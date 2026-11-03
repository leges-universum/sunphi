import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {envelope,PROFILE} from './core.mjs';
import {hash,sign,publicKey} from './crypto.mjs';
import {rpc} from './client.mjs';
import {DOMAIN,policy,policyId,feeFor,amount} from '../research/transition-core-20261103/model.mjs';
export function balances(state,owner){let available=0n,protectedValue=0n,reserved=0n;for(const o of Object.values(state.money.outputs))if(o.owner===owner){if(o.unlock<=state.money.time)available+=BigInt(o.value);else protectedValue+=BigInt(o.value);}for(const r of Object.values(state.money.requests))if(r.status==='RESERVED'&&r.intent.sender===owner)reserved+=BigInt(r.escrow);return {available:String(available),protected:String(protectedValue),reserved:String(reserved)};}
export function plan(money,value){let left=amount(value);const workers=Object.entries(money.nodes).map(([id,n])=>({id,group:n.operator,tier:BigInt(n.tier),free:BigInt(n.stake)-BigInt(n.consensusHeld)-BigInt(n.taskHeld)})).filter(n=>n.tier>0n&&n.free>0n&&BigInt(money.nodes[n.id].consensusHeld)>0n),parts=[];
 while(left>0n){const groups=new Set(),chosen=[];workers.sort((a,b)=>a.free===b.free?a.id.localeCompare(b.id):a.free>b.free?-1:1);for(const n of workers)if(n.free>0n&&!groups.has(n.group)){groups.add(n.group);chosen.push(n);if(chosen.length===3)break;}assert.equal(chosen.length,3,'not enough independent worker capacity');let v=left;for(const n of chosen){if(n.free<v)v=n.free;if(n.tier<v)v=n.tier;}assert(v>0n);parts.push({value:String(v),nodes:chosen.map(n=>n.id)});assert(parts.length<=policy.maxParts,'trial plan limit');for(const n of chosen)n.free-=v;left-=v;}
 return parts;
}
export class Wallet{
 constructor({client,key,home,routes,url,checkpoint}){this.client=client;this.key=key;this.routes=routes;this.url=url;this.checkpoint=checkpoint;this.db=new DatabaseSync(join(home,'outbox.sqlite'));this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS outgoing(pid TEXT PRIMARY KEY,body TEXT NOT NULL)');}
 async view(){return this.client.sync(typeof this.checkpoint==='function'?this.checkpoint():this.checkpoint,this.url);}
 async prepare(recipient,value,delay=0){publicKey(recipient);assert(amount(value)>0n);const {state}=await this.view(),money=state.money,fee=feeFor(value),need=BigInt(value)+fee,inputs=[];let total=0n;for(const [id,o] of Object.entries(money.outputs).sort(([a],[b])=>a.localeCompare(b)))if(o.owner===this.key.publicKey&&o.unlock<=money.time&&BigInt(o.value)>0n){inputs.push(id);total+=BigInt(o.value);if(total>=need)break;}assert(total>=need&&inputs.length<=policy.maxInputs,'insufficient spendable funds or trial input limit');const intent={domain:DOMAIN+'/INTENT',policy:policyId,network:policy.network,pid:hash({domain:PROFILE+'/PAYMENT',random:randomUUID()}),sender:this.key.publicKey,recipient,inputs,value,fee:String(fee),abortFee:'1',epoch:money.epoch,lastReserve:money.height+24,deadline:money.height+88,delay,parts:plan(money,value)};const signed={intent,signature:sign(intent,this.key.privateKey)},wire=envelope(this.client.config,{type:'RESERVE',signed},this.key);this.db.prepare('INSERT INTO outgoing VALUES(?,?)').run(intent.pid,JSON.stringify(wire));return {pid:intent.pid,fee:intent.fee,parts:intent.parts.length};}
 async broadcast(wire){try{const r=await rpc(this.url,'broadcast_tx_sync',{tx:Buffer.from(JSON.stringify(wire)).toString('base64')});assert.equal(r.code,0,'transaction rejected; refresh confirmed state');return {admitted:true};}catch(e){if(e.message.includes('tx already exists in cache'))return {admitted:true};throw e;}}
 async resume(pid){const row=this.db.prepare('SELECT body FROM outgoing WHERE pid=?').get(pid);assert(row,'unknown local payment');const wire=JSON.parse(row.body),{state}=await this.view(),r=state.money.requests[pid];if(!r){await this.broadcast(wire);return {status:'RESERVATION_SUBMITTED',pid};}if(r.status!=='RESERVED')return {status:r.status,pid};
  if(state.money.height+1>r.intent.deadline){await this.broadcast(envelope(this.client.config,{type:'EXPIRE',pid,request:r.digest},this.key));return {status:'REFUND_SUBMITTED',pid};}
  const receipts=await Promise.all(r.intent.parts.flatMap((p,index)=>p.nodes.map(async node=>{const url=this.routes[node];assert(url,'worker route unavailable; funds remain reserved');const q=await rpc(url,'abci_query',{path:'/work',data:Buffer.from(JSON.stringify({pid,index})).toString('hex')});assert(!q.response.code,'worker not ready');return JSON.parse(Buffer.from(q.response.value,'base64'));})));
  await this.broadcast(envelope(this.client.config,{type:'FINALIZE',pid,request:r.digest,receipts},this.key));return {status:'SETTLEMENT_SUBMITTED',pid};
 }
 close(){this.db.close();}
}
