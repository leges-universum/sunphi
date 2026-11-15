// Bounded capacity certification by independently running local validators.
// This service cannot mint, change policy, spend custody funds or sign payments.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {hash,sign,exact} from './crypto.mjs';
import {envelope} from './core.mjs';
import {validatorApprovalBody,validatorQuorum,verifyValidatorApprovals} from './validator-authority.mjs';
import {WARMUP_EXECUTOR_V2} from './century-warmup.mjs';

export function capacityProposal(state,{planHash,rate='1000'},now){
 const b=state.centuryWarmup,p=state.centuryFunds?.zeroStage?.body;
 assert(Number.isSafeInteger(now)&&Number.isSafeInteger(state.money.time));
 assert(now>=state.money.time&&now-state.money.time<=50,'fresh consensus state required');
 assert.equal(b?.planHash,planHash,'warmup plan pin');
 assert.equal(b.version,WARMUP_EXECUTOR_V2,'executor upgrade required');
 assert(!state.centurySubsidy,'zero-stage capacity must not activate subsidy');
 assert(p,'zero-stage mandate required');
 assert(/^[1-9][0-9]*$/.test(rate)&&BigInt(rate)<=1000n,'conservative capacity ceiling');
 if(b.pending||b.controller.pending||state.money.time<b.controller.cursor)return null;
 const from=state.money.time,to=from+b.controllerPolicy.intervalSeconds;
 if(from<p.startsAt||to>p.startsAt+p.settings.durationSeconds)return null;
 const allowed=BigInt(b.controller.previousRateMicroPerSecond)+BigInt(b.controllerPolicy.maximumRiseMicroPerSecond);
 assert(BigInt(rate)<=allowed&&BigInt(rate)<=BigInt(b.controllerPolicy.operationalRateMicroPerSecond));
 return {domain:'DUEBYTE_WARMUP_CAPACITY_V2',configHash:state.configHash,generation:state.authority.generation,start:b.controller.start,from,to,observedHeight:state.height,observedAt:from,sequence:b.controller.sequence+1,healthy:true,capacityRateMicroPerSecond:rate,controllerPolicyHash:hash(b.controllerPolicy)};
}

function database(file){const db=new DatabaseSync(file);db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;');return db;}
export class CapacitySigner{
 constructor({file,view,validatorKeys,options,enabled=()=>true}){
  Object.assign(this,{view,validatorKeys,options,enabled});this.busy=false;this.db=database(file);
  this.db.exec('CREATE TABLE IF NOT EXISTS approval(slot TEXT PRIMARY KEY,sequence INTEGER NOT NULL,body TEXT NOT NULL,approvals TEXT NOT NULL)');
 }
 async approve(packet){
  assert(!this.busy,'signer busy');this.busy=true;
  try{
   assert(this.enabled(),'capacity signing paused');exact(packet,['height','root','body']);
   const {state,time,root}=await this.view(packet.height);assert.equal(root,packet.root,'local consensus root mismatch');
   assert.deepEqual(packet.body,capacityProposal(state,this.options,time),'capacity differs from local verified state');
   const body=packet.body;assert(body&&time<body.to,'expired capacity');
   const slot=hash({configHash:state.configHash,planHash:this.options.planHash,generation:state.authority.generation});
   const old=this.db.prepare('SELECT * FROM approval WHERE slot=?').get(slot);
   if(old){
    assert(body.sequence>=old.sequence,'capacity sequence rollback');
    if(body.sequence===old.sequence){
     if(hash(JSON.parse(old.body))===hash(body)){const result=JSON.parse(old.approvals);verifyValidatorApprovals(body,result,state.authority.validators);return result;}
     assert(time>=JSON.parse(old.body).to,'conflicting unexpired capacity');
    }
   }
   const allowed=new Set(state.authority.validators.map(v=>v.key)),signed=validatorApprovalBody(body,state.authority.validators);
   const approvals=this.validatorKeys.map(k=>{assert(allowed.has(k.publicKey),'inactive validator');return{key:k.publicKey,signature:sign(signed,k.privateKey)};});
   verifyValidatorApprovals(body,approvals,state.authority.validators);
   // Persist before returning a signature. Replacement is safe only after the
   // old interval has expired on independently verified consensus time.
   this.db.prepare('INSERT OR REPLACE INTO approval VALUES(?,?,?,?)').run(slot,body.sequence,JSON.stringify(body),JSON.stringify(approvals));
   return approvals;
  }finally{this.busy=false;}
 }
 close(){this.db.close();}
}

export class CapacityCoordinator{
 constructor({file,view,config,key,options,signers,broadcast,enabled=()=>true}){
  Object.assign(this,{view,config,key,options,signers,broadcast,enabled});this.busy=false;this.db=database(file);
  this.db.exec('CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY CHECK(id=1),packet TEXT NOT NULL,wire TEXT)');
 }
 async cycle(){
  if(this.busy)return{busy:true};this.busy=true;
  try{
   const current=await this.view(),s=current.state,b=s.centuryWarmup;
   assert.equal(s.configHash,hash(this.config));assert.equal(b?.planHash,this.options.planHash);
   let row=this.db.prepare('SELECT * FROM outbox WHERE id=1').get();
   if(row){
    const packet=JSON.parse(row.packet),body=packet.body;
    if(b.controller.sequence>=body.sequence||s.authority.generation!==body.generation||current.time>=body.to){
     this.db.prepare('DELETE FROM outbox WHERE id=1').run();return{reconciled:body.sequence,height:s.height};
    }
   }
   if(!this.enabled())return{paused:true,height:s.height};
   if(!row){
    const body=capacityProposal(s,this.options,current.time);if(!body)return{waiting:true,height:s.height};
    const packet={height:s.height,root:current.root,body};
    this.db.prepare('INSERT INTO outbox VALUES(1,?,NULL)').run(JSON.stringify(packet));row={packet:JSON.stringify(packet),wire:null};
   }
   const packet=JSON.parse(row.packet),body=packet.body;let wire=row.wire&&JSON.parse(row.wire);
   if(!wire){
    const outcomes=await Promise.allSettled(this.signers.map(fn=>Promise.resolve().then(()=>fn(packet)))),byKey=new Map();
    for(const outcome of outcomes)if(outcome.status==='fulfilled'){
     try{verifyValidatorApprovals(body,outcome.value,s.authority.validators);for(const a of outcome.value)byKey.set(a.key,a);}catch{}
    }
    const approvals=[...byKey.values()].sort((a,b)=>a.key.localeCompare(b.key));validatorQuorum(body,approvals,s.authority.validators);
    wire=envelope(this.config,{type:'CERTIFY_CENTURY_WARMUP_INTERVAL_V1',certificate:{body,approvals}},this.key);
    this.db.prepare('UPDATE outbox SET wire=? WHERE id=1').run(JSON.stringify(wire));
   }
   assert.equal(wire.body.action.type,'CERTIFY_CENTURY_WARMUP_INTERVAL_V1');assert.deepEqual(wire.body.action.certificate.body,body);
   validatorQuorum(body,wire.body.action.certificate.approvals,s.authority.validators);
   // Retry the exact persisted transaction, including after an uncertain reply.
   const result=await this.broadcast(wire);
   return result?.cached?{awaitingConfirmation:body.sequence,height:s.height}:{submitted:body.sequence,height:s.height};
  }finally{this.busy=false;}
 }
 close(){this.db.close();}
}
