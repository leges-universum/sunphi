import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {envelope,PROFILE,stateHash} from './core.mjs';
import {hash,sign,publicKey} from './crypto.mjs';
import {rpc} from './client.mjs';
import {DOMAIN,policy,policyId,feeFor,amount,SCHEDULE_DOMAIN,scheduled} from './payment-model.mjs';
import {delayedPaymentsEnabled,resourceLimitsEnabled} from './authority.mjs';
import {resourcePaymentId} from './resource-limits.mjs';
export function balances(state,owner){let available=0n,protectedValue=0n,reserved=0n,delayed=0n;for(const o of Object.values(state.money.outputs))if(o.owner===owner){if(o.unlock<=state.money.time)available+=BigInt(o.value);else protectedValue+=BigInt(o.value);}for(const r of Object.values(state.money.requests))if(r.status==='RESERVED'&&r.intent.sender===owner)reserved+=BigInt(r.escrow);for(const r of Object.values(state.money.requests))if(r.status==='SCHEDULED'&&r.intent.sender===owner)delayed+=BigInt(r.escrow);return {available:String(available),protected:String(protectedValue),reserved:String(reserved),scheduled:String(delayed)};}
// Only a verified state can establish that the admission window was missed.
// A network record always wins over the local outbox's age.
export function outgoingStatus(state,intent){return state?.money.requests[intent.pid]?.status??(state&&state.money.height>=intent.lastReserve?(resourceLimitsEnabled(state)?'HISTORY_UNAVAILABLE':'NOT_SUBMITTED'):'QUEUED');}
export function paymentFee(intent,status){return status==='HISTORY_UNAVAILABLE'?null:status==='NOT_SUBMITTED'?'0':['EXPIRED','CANCELLED'].includes(status)?intent.abortFee:intent.fee;}
export function requestedRecipientDelay(q){
 assert(q&&typeof q==='object'&&!Array.isArray(q),'invalid payment request');
 assert(Object.keys(q).every(k=>['recipient','value','protected','delayed'].includes(k)),'Unsupported payment option; payment has not been prepared.');
 assert(q.protected===undefined||typeof q.protected==='boolean','recipient lock must be true or false');
 assert(q.delayed===undefined||typeof q.delayed==='boolean','delayed sending must be true or false');
 return q.protected===true?86400:0;
}
export function plan(money,value){let left=amount(value);const workers=Object.entries(money.nodes).map(([id,n])=>({id,group:n.operator,tier:BigInt(n.tier),free:BigInt(n.stake)-BigInt(n.consensusHeld)-BigInt(n.taskHeld)})).filter(n=>n.tier>0n&&n.free>0n&&BigInt(money.nodes[n.id].consensusHeld)>0n),parts=[];
 while(left>0n){const groups=new Set(),chosen=[];workers.sort((a,b)=>a.free===b.free?a.id.localeCompare(b.id):a.free>b.free?-1:1);for(const n of workers)if(n.free>0n&&!groups.has(n.group)){groups.add(n.group);chosen.push(n);if(chosen.length===3)break;}assert.equal(chosen.length,3,'not enough independent worker capacity');let v=left;for(const n of chosen){if(n.free<v)v=n.free;if(n.tier<v)v=n.tier;}assert(v>0n);parts.push({value:String(v),nodes:chosen.map(n=>n.id)});assert(parts.length<=policy.maxParts,'trial plan limit');for(const n of chosen)n.free-=v;left-=v;}
 return parts;
}
export class Wallet{
 constructor({client,key,home,routes,url,checkpoint}){this.client=client;this.key=key;this.routes=routes;this.url=url;this.checkpoint=checkpoint;this.db=new DatabaseSync(join(home,'outbox.sqlite'));this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS outgoing(pid TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cancellations(pid TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS observed_terminal(pid TEXT PRIMARY KEY,body TEXT NOT NULL)');}
 terminalRecords(){return Object.fromEntries(this.db.prepare('SELECT pid,body FROM observed_terminal').all().map(r=>[r.pid,JSON.parse(r.body)]));}
 async view(){return this.client.sync(typeof this.checkpoint==='function'?this.checkpoint():this.checkpoint,this.url);}
 recoverPending({state,certificate},limit=16){
  assert(Number.isInteger(limit)&&limit>0&&limit<=32);assert.equal(stateHash(state,this.client.config),certificate.appHash);assert.equal(state.height,certificate.appHeight);
  const recovered=[];this.db.exec('BEGIN IMMEDIATE');try{
   for(const [pid,r]of Object.entries(state.money.requests))if(['SETTLED','EXPIRED','CANCELLED'].includes(r.status)&&(r.intent.sender===this.key.publicKey||r.intent.recipient===this.key.publicKey))this.db.prepare('INSERT OR IGNORE INTO observed_terminal VALUES(?,?)').run(pid,JSON.stringify(r));
   for(const [pid,r] of Object.entries(state.money.requests).sort(([a],[b])=>a.localeCompare(b))){
    if(recovered.length>=limit)break;
    if(!['RESERVED','SCHEDULED'].includes(r.status)||r.intent.sender!==this.key.publicKey||this.db.prepare('SELECT 1 FROM outgoing WHERE pid=?').get(pid))continue;
    assert.equal(r.intent.pid,pid);assert.equal(hash(r.intent),r.digest);
    const signed={intent:r.intent,signature:sign(r.intent,this.key.privateKey)},wire=envelope(this.client.config,{type:scheduled(r.intent)?'SCHEDULE_PAYMENT_V1':'RESERVE',signed},this.key);
    this.db.prepare('INSERT INTO outgoing VALUES(?,?)').run(pid,JSON.stringify(wire));recovered.push(pid);
   }this.db.exec('COMMIT');return recovered;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 async prepare(recipient,value,delay=0,sendDelay=0){publicKey(recipient);assert(amount(value)>0n);const {state}=await this.view(),money=state.money,fee=feeFor(value),need=BigInt(value)+fee,inputs=[];let total=0n;for(const [id,o] of Object.entries(money.outputs).sort(([a],[b])=>a.localeCompare(b)))if(o.owner===this.key.publicKey&&o.unlock<=money.time&&BigInt(o.value)>0n){inputs.push(id);total+=BigInt(o.value);if(total>=need)break;}assert(total>=need&&inputs.length<=policy.maxInputs,'insufficient spendable funds or trial input limit');assert([0,86400].includes(sendDelay),'invalid sending delay');assert(!sendDelay||delayedPaymentsEnabled(state),'Delayed sending is not enabled on this network.');const intent={domain:sendDelay?SCHEDULE_DOMAIN:DOMAIN+'/INTENT',policy:policyId,network:policy.network,pid:hash({domain:PROFILE+'/PAYMENT',random:randomUUID()}),sender:this.key.publicKey,recipient,inputs,value,fee:String(fee),abortFee:'1',epoch:money.epoch,lastReserve:money.height+24,deadline:money.height+88,delay,parts:plan(money,value),...(sendDelay?{sendDelay}:{})};if(resourceLimitsEnabled(state))intent.pid=resourcePaymentId(intent,state.configHash);const signed={intent,signature:sign(intent,this.key.privateKey)},wire=envelope(this.client.config,{type:sendDelay?'SCHEDULE_PAYMENT_V1':'RESERVE',signed},this.key);this.db.prepare('INSERT OR IGNORE INTO outgoing VALUES(?,?)').run(intent.pid,JSON.stringify(wire));return {pid:intent.pid,fee:intent.fee,parts:intent.parts.length};}
 async broadcast(wire){try{const r=await rpc(this.url,'broadcast_tx_sync',{tx:Buffer.from(JSON.stringify(wire)).toString('base64')});assert.equal(r.code,0,'transaction rejected; refresh confirmed state');return {admitted:true};}catch(e){if(e.message.includes('tx already exists in cache'))return {admitted:true};throw e;}}
 async resume(pid){const row=this.db.prepare('SELECT body FROM outgoing WHERE pid=?').get(pid);assert(row,'unknown local payment');const wire=JSON.parse(row.body),{state}=await this.view(),r=state.money.requests[pid];if(!r){const cached=this.db.prepare('SELECT body FROM observed_terminal WHERE pid=?').get(pid);if(cached)return {status:JSON.parse(cached.body).status,pid};const status=outgoingStatus(state,wire.body.action.signed.intent);if(['NOT_SUBMITTED','HISTORY_UNAVAILABLE'].includes(status))return {status,pid};await this.broadcast(wire);return {status:'RESERVATION_SUBMITTED',pid};}if(['SETTLED','EXPIRED','CANCELLED'].includes(r.status))return {status:r.status,pid};
  const cancellation=this.db.prepare('SELECT body FROM cancellations WHERE pid=?').get(pid);
  if(cancellation){if(r.executeAt&&state.money.time>=r.executeAt)return {status:'CANCELLATION_WINDOW_CLOSED',pid};await this.broadcast(JSON.parse(cancellation.body));return {status:'CANCELLATION_SUBMITTED',pid};}
  if(r.status==='SCHEDULED')return {status:'SCHEDULED',pid};
  if(state.money.height+1>r.intent.deadline){await this.broadcast(envelope(this.client.config,{type:'EXPIRE',pid,request:r.digest},this.key));return {status:'REFUND_SUBMITTED',pid};}
  const receipts=await Promise.all(r.intent.parts.flatMap((p,index)=>p.nodes.map(async node=>{const url=this.routes[node];assert(url,'worker route unavailable; funds remain reserved');const q=await rpc(url,'abci_query',{path:'/work',data:Buffer.from(JSON.stringify({pid,index})).toString('hex')});assert(!q.response.code,'worker not ready');return JSON.parse(Buffer.from(q.response.value,'base64'));})));
  await this.broadcast(envelope(this.client.config,{type:'FINALIZE',pid,request:r.digest,receipts},this.key));return {status:'SETTLEMENT_SUBMITTED',pid};
 }
 async cancel(pid){
  const view=await this.view(),r=view.state.money.requests[pid];
  assert(r&&scheduled(r.intent)&&r.intent.sender===this.key.publicKey,'Only the sender can cancel this scheduled payment.');
  if(r.status==='CANCELLED')return {status:'CANCELLED',pid};
  assert(['RESERVED','SCHEDULED'].includes(r.status),'This payment can no longer be cancelled.');
  assert(!r.executeAt||view.state.money.time<r.executeAt,'The cancellation window has closed.');
  const wire=envelope(this.client.config,{type:'CANCEL_SCHEDULED_PAYMENT_V1',pid,request:r.digest},this.key);
  this.db.prepare('INSERT OR IGNORE INTO cancellations VALUES(?,?)').run(pid,JSON.stringify(wire));
  this.recoverPending(view);
  await this.broadcast(wire);return {status:'CANCELLATION_SUBMITTED',pid};
 }
 close(){this.db.close();}
}
