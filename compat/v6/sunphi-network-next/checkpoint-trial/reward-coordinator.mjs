// Finite-work coordination. Validator keys remain on their own signing hosts.
import assert from'node:assert/strict';import{DatabaseSync}from'node:sqlite';import{mkdirSync}from'node:fs';import{join}from'node:path';
import{hash,sign,exact,verify}from'./crypto.mjs';import{envelope,stateHash}from'./core.mjs';import{quorum}from'./authority.mjs';
import{nextRewardProposal}from'./reward-scheduler.mjs';
const domain='DUEBYTE_FUNDED_WORK_V1/';
const certificateBody=(state,proposal,config)=>({domain:domain+proposal.type,network:config.chainId,configHash:hash(config),generation:state.authority.generation,notBefore:state.height,expires:state.height+90,...proposal.fields});
export class RewardProposalSigner{
 constructor({client,url,validatorKeys,home,plannerOptions,now=()=>Math.floor(Date.now()/1000)}){
  Object.assign(this,{client,url,validatorKeys,plannerOptions,now});assert(validatorKeys.length>0&&validatorKeys.length<=10);this.busy=false;mkdirSync(home,{recursive:true,mode:0o700});this.db=new DatabaseSync(join(home,'reward-signatures.sqlite'));this.db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS signed(reference TEXT PRIMARY KEY,body TEXT NOT NULL,approvals TEXT NOT NULL)');
 }
 async approve(packet){
  assert(!this.busy,'signer busy');this.busy=true;
  try{
   exact(packet,['checkpoint','body']);assert(this.now()-packet.checkpoint.body.issuedAt<=60,'fresh checkpoint required for scheduling');
   const {state}=await this.client.checkpointSnapshot(packet.checkpoint,this.url);assert.equal(stateHash(state,this.client.config),packet.checkpoint.body.appHash);
   const proposal=nextRewardProposal(state,this.plannerOptions);assert(proposal,'no funded work proposal');assert.deepEqual(packet.body,certificateBody(state,proposal,this.client.config),'proposal differs from published scheduling policy');
   const reference=hash(packet.checkpoint.body),old=this.db.prepare('SELECT body,approvals FROM signed WHERE reference=?').get(reference);
   if(old){assert.equal(old.body,JSON.stringify(packet.body),'conflicting proposal at one checkpoint');return JSON.parse(old.approvals);}
   const allowed=new Set(state.authority.validators.map(v=>v.key)),approvals=this.validatorKeys.map(k=>{assert(allowed.has(k.publicKey),'not a current validator');const signature=sign(packet.body,k.privateKey);assert(verify(packet.body,signature,k.publicKey));return{key:k.publicKey,signature};});
   this.db.prepare('INSERT INTO signed VALUES(?,?,?)').run(reference,JSON.stringify(packet.body),JSON.stringify(approvals));return approvals;
  }finally{this.busy=false;}
 }
 close(){this.db.close();}
}
export class RewardCoordinator{
 constructor({client,url,checkpoint,home,key,plannerOptions,signers,broadcast,now=()=>Math.floor(Date.now()/1000)}){
  Object.assign(this,{client,url,checkpoint,key,plannerOptions,signers,broadcast,now});assert(signers.length>=1);this.busy=false;mkdirSync(home,{recursive:true,mode:0o700});this.db=new DatabaseSync(join(home,'reward-coordination.sqlite'));this.db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,packet TEXT NOT NULL,wire TEXT,status TEXT NOT NULL)');
 }
 async cycle(){
  if(this.busy)return{busy:true};this.busy=true;
  try{
   const checkpoint=await this.checkpoint();assert(this.now()-checkpoint.body.issuedAt<=60,'fresh checkpoint required');const view=await this.client.sync(checkpoint,this.url),current=view.state;
   assert.equal(stateHash(current,this.client.config),view.certificate.appHash);
   const pending=this.db.prepare("SELECT * FROM proposals WHERE status='pending' ORDER BY rowid LIMIT 1").get();
   if(pending){
    const packet=JSON.parse(pending.packet),body=packet.body,type=body.domain.slice(domain.length),funded=current.rewards?.fundedWork;
    let accepted=false;
    if(['OPEN_REWARD_WORK_V2','OPEN_REWARD_WORK_V3'].includes(type)&&funded?.book.policy.version>=body.policy.version){assert.equal(funded.book.policy.version,body.policy.version,'unexpected work window advanced');assert.deepEqual(funded.book.policy,body.policy);accepted=true;}
    if(type==='ASSIGN_REWARD_WORK_V1')accepted=Object.values(funded?.book.jobs??{}).some(j=>hash(j.request)===hash(body.request));
    if(accepted){this.db.prepare("UPDATE proposals SET status='confirmed' WHERE id=?").run(pending.id);return{confirmed:pending.id,height:current.height};}
    if(current.height>=body.expires||this.now()-packet.checkpoint.body.issuedAt>60){this.db.prepare("UPDATE proposals SET status='expired' WHERE id=?").run(pending.id);return{expired:pending.id,height:current.height};}
    let wire=pending.wire&&JSON.parse(pending.wire);
    if(!wire){const outcomes=await Promise.allSettled(this.signers.map(fn=>fn(packet)));
     // Finish every signing request before releasing the cycle lock. A failed
     // peer must not leave another signer busy when a durable retry starts.
     const failed=outcomes.find(r=>r.status==='rejected');if(failed)throw failed.reason;
     const responses=outcomes.map(r=>r.value),byKey=new Map();for(const a of responses.flat()) {if(byKey.has(a.key))assert.equal(byKey.get(a.key).signature,a.signature);byKey.set(a.key,a);}const approvals=[...byKey.values()];
     quorum(body,approvals,current.authority.validators,7);assert.equal(body.generation,current.authority.generation);wire=envelope(this.client.config,{type,certificate:{body,approvals}},this.key);this.db.prepare('UPDATE proposals SET wire=? WHERE id=?').run(JSON.stringify(wire),pending.id);
    }
    await this.broadcast(wire);return{submitted:pending.id,height:current.height};
   }
   const {state}=await this.client.checkpointSnapshot(checkpoint,this.url),proposal=nextRewardProposal(state,this.plannerOptions);if(!proposal)return{idle:true,height:current.height};
   const packet={checkpoint,body:certificateBody(state,proposal,this.client.config)},id=hash(packet.body);
   if(this.db.prepare('SELECT 1 FROM proposals WHERE id=?').get(id))return{awaitingCheckpoint:true,height:current.height};
   this.db.prepare("INSERT INTO proposals(id,packet,status) VALUES(?,?,'pending')").run(id,JSON.stringify(packet));return{prepared:id,height:current.height};
  }finally{this.busy=false;}
 }
 close(){this.db.close();}
}
