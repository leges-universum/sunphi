// The runner owns only an unfunded transport identity, never a fund spending key.
import assert from 'node:assert/strict';
import {paymentClock} from './obligation-clock.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {hash} from './crypto.mjs';
import {envelope} from './core.mjs';
import {rpc} from './client.mjs';
import {warmupPlan} from './network-reserves.mjs';
export class ProgramWarmupWorker{
 constructor({home,client,url,checkpoint,key,policyHash,routes,broadcast,enabled=()=>false,now=()=>Math.floor(Date.now()/1000)}){
  Object.assign(this,{client,url,checkpoint,key,policyHash,routes,broadcast,enabled,now});mkdirSync(home,{recursive:true,mode:0o700});this.db=new DatabaseSync(join(home,'program-warmup.sqlite'));this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS pending(id INTEGER PRIMARY KEY CHECK(id=1), sequence INTEGER NOT NULL, body TEXT NOT NULL)');
  this.lock=new DatabaseSync(join(home,'program-warmup-lock.sqlite'));this.lock.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS guard(id INTEGER PRIMARY KEY)');this.busy=false;
 }
 async cycle(){
  if(this.busy)return{waiting:true};this.busy=true;let locked=false;
  try{
   try{this.lock.exec('BEGIN IMMEDIATE');locked=true;}catch{return{waiting:true,reason:'another-runner'};}
   const cp=typeof this.checkpoint==='function'?await this.checkpoint():this.checkpoint,{state:s}=await this.client.sync(cp,this.url),r=s.networkReserves;
   if(!r)return{prepared:false,paused:true};assert.equal(hash(r.policy),this.policyHash,'reserve policy pin');const w=r.warmup,row=this.db.prepare('SELECT * FROM pending WHERE id=1').get();
   if(row&&w.sequence>row.sequence){this.db.exec('DELETE FROM pending WHERE id=1');return{completed:true,sequence:row.sequence};}
   if(row)assert.equal(row.sequence,w.sequence,'outbox ahead of verified state');
   if(this.now()-s.money.time>60||s.money.time>this.now()+10)return{paused:true,reason:'stale-consensus'};
   // A pause never abandons already admitted escrow; anyone can relay receipts.
   if(w.pending){
    const pid=w.pending.pid,q=s.money.requests[pid];assert(q?.status==='RESERVED','verified pending request required');let action;
    if(paymentClock(s.money,q.intent,s.money.height+1)>q.intent.deadline)action={type:'EXPIRE',pid,request:q.digest};
    else{const receipts=await Promise.all(q.intent.parts.flatMap((p,index)=>p.nodes.map(async node=>{const url=this.routes[node];assert(url,'worker route unavailable');const response=await rpc(url,'abci_query',{path:'/work',data:Buffer.from(JSON.stringify({pid,index})).toString('hex')});assert(!response.response.code,'worker unavailable');return JSON.parse(Buffer.from(response.response.value,'base64'));})));action={type:'FINALIZE',pid,request:q.digest,receipts};}
    await this.broadcast(envelope(this.client.config,action,this.key));return{pid,status:action.type==='EXPIRE'?'REFUND_SUBMITTED':'SETTLEMENT_SUBMITTED'};
   }
   if(!this.enabled()||!r.issued||w.mode!=='ACTIVE')return{paused:true};
   if(!warmupPlan(s))return{waiting:true,reason:'no-eligible-work'};
   let wire;if(row)wire=JSON.parse(row.body);else{wire=envelope(this.client.config,{type:'RUN_WARMUP_V1',sequence:w.sequence},this.key);this.db.prepare('INSERT INTO pending VALUES(1,?,?)').run(w.sequence,JSON.stringify(wire));}
   await this.broadcast(wire);return{sequence:w.sequence,status:'PROGRAM_SUBMITTED'};
  }finally{if(locked)this.lock.exec('ROLLBACK');this.busy=false;}
 }
 close(){this.db.close();this.lock.close();}
}
