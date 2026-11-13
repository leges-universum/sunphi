// Finite-work coordination. Validator keys remain on their own signing hosts.
import assert from'node:assert/strict';import{DatabaseSync}from'node:sqlite';import{mkdirSync}from'node:fs';import{join}from'node:path';
import{hash,sign,exact,verify}from'./crypto.mjs';import{envelope,stateHash}from'./core.mjs';import{validatorQuorum}from'./authority.mjs';
import{MAX_ACTIVE_VALIDATORS,validatorApprovalBody,verifyValidatorApprovals}from'./validator-authority.mjs';
import{nextRewardProposal}from'./reward-scheduler.mjs';
import{assertBoundedServiceView}from'./research/bounded-wallet-view.mjs';
import{CENTURY_SUBSIDY_ACTION,centuryOwnerSnapshot}from'./century-subsidy.mjs';
import{developmentManager}from'./reserve-recovery.mjs';
const domain='DUEBYTE_FUNDED_WORK_V1/';
const certificateBody=(state,proposal,config)=>({domain:proposal.type===CENTURY_SUBSIDY_ACTION?proposal.type:domain+proposal.type,network:config.chainId,configHash:hash(config),generation:state.authority.generation,notBefore:state.height,expires:state.height+90,...proposal.fields});
const isCentury=body=>body.domain===CENTURY_SUBSIDY_ACTION;
function founderAuthorized(state,packet){return !state.networkReserves?.development?.access?.pending&&verify(packet.body,packet.founderConsent,developmentManager(state.networkReserves));}
function centuryCurrent(state,b){
 const book=state.centurySubsidy,change=book?.policyControl?.pending,due=change&&b.from>=change.effectiveFrom,access=state.networkReserves?.development?.access;
 if(!book||book.pending||book.sequence+1!==b.sequence||book.start!==b.start||book.planHash!==b.planHash||state.economicPreparation?.planHash!==b.planHash||state.centuryFunds?.execution?.start!==b.start||state.centuryFunds?.zeroStage||access?.pending)return false;
 if(b.from<state.money.time||b.from<book.cursor||b.from<(state.centuryFunds?.support?.to??0))return false;
 if(due&&(!access||access.epoch!==change.managementEpoch||state.money.time<change.effectiveFrom))return false;
 if(change&&!due&&b.to>change.effectiveFrom)return false;
 const policy=due?change.policy:book.policy;
 return hash(policy)===hash(b.policy)&&hash(centuryOwnerSnapshot(state,policy))===b.ownersHash;
}
async function planningView(client,url,checkpoint,planning){
 if(client.bounded){
  exact(planning,['offset']);assert(Number.isSafeInteger(planning.offset)&&planning.offset>=0,'planning cursor');
  const view=await client.rewardPlanningEvidence(checkpoint,url,planning.offset);
  assert.deepEqual(view.checkpoint,checkpoint,'planning checkpoint changed');
  assertBoundedServiceView(view.state,{appHash:checkpoint.body.appHash,appHeight:checkpoint.body.appHeight},client.config);return view;
 }
 assert.equal(planning,undefined,'legacy planning cannot accept indexed pages');
 const view=await client.checkpointSnapshot(checkpoint,url);assert.equal(stateHash(view.state,client.config),checkpoint.body.appHash);return view;
}
export class RewardProposalSigner{
 constructor({client,url,validatorKeys,home,plannerOptions,now=()=>Math.floor(Date.now()/1000)}){
  Object.assign(this,{client,url,validatorKeys,plannerOptions,now});assert(Array.isArray(validatorKeys)&&validatorKeys.length>0&&validatorKeys.length<=MAX_ACTIVE_VALIDATORS);assert.equal(new Set(validatorKeys.map(k=>k.publicKey)).size,validatorKeys.length,'duplicate local validator key');this.busy=false;mkdirSync(home,{recursive:true,mode:0o700});this.db=new DatabaseSync(join(home,'reward-signatures.sqlite'));this.db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS signed(reference TEXT PRIMARY KEY,body TEXT NOT NULL,approvals TEXT NOT NULL)');
 }
 async approve(packet){
  assert(!this.busy,'signer busy');this.busy=true;
  try{
   exact(packet,['checkpoint','body',...(this.client.bounded?['planning']:[]),...(isCentury(packet.body)?['founderConsent']:[])]);assert(this.now()-packet.checkpoint.body.issuedAt<=60,'fresh checkpoint required for scheduling');
   const {state}=await planningView(this.client,this.url,packet.checkpoint,packet.planning);
   const proposal=nextRewardProposal(state,this.plannerOptions);assert(proposal,'no funded work proposal');assert.deepEqual(packet.body,certificateBody(state,proposal,this.client.config),'proposal differs from published scheduling policy');
   if(proposal.requiresFounderConsent)assert(founderAuthorized(state,packet),'founder subsidy consent');
   const reference=hash(packet.checkpoint.body),old=this.db.prepare('SELECT body,approvals FROM signed WHERE reference=?').get(reference);
   if(old){assert.equal(old.body,JSON.stringify(packet.body),'conflicting proposal at one checkpoint');const approvals=JSON.parse(old.approvals);verifyValidatorApprovals(packet.body,approvals,state.authority.validators);return approvals;}
   const signed=validatorApprovalBody(packet.body,state.authority.validators),allowed=new Set(state.authority.validators.map(v=>v.key)),approvals=this.validatorKeys.map(k=>{assert(allowed.has(k.publicKey),'not a current validator');const signature=sign(signed,k.privateKey);assert(verify(signed,signature,k.publicKey));return{key:k.publicKey,signature};});
   this.db.prepare('INSERT INTO signed VALUES(?,?,?)').run(reference,JSON.stringify(packet.body),JSON.stringify(approvals));return approvals;
  }finally{this.busy=false;}
 }
 close(){this.db.close();}
}
export class RewardCoordinator{
 constructor({client,url,checkpoint,home,key,plannerOptions,signers,broadcast,founderConsent,now=()=>Math.floor(Date.now()/1000)}){
  Object.assign(this,{client,url,checkpoint,key,plannerOptions,signers,broadcast,founderConsent,now});assert(signers.length>=1);this.busy=false;mkdirSync(home,{recursive:true,mode:0o700});this.db=new DatabaseSync(join(home,'reward-coordination.sqlite'));this.db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,packet TEXT NOT NULL,wire TEXT,status TEXT NOT NULL)');
  this.db.exec('CREATE TABLE IF NOT EXISTS planning_cursor(id INTEGER PRIMARY KEY CHECK(id=1),offset INTEGER NOT NULL); INSERT OR IGNORE INTO planning_cursor VALUES(1,0)');
 }
 async cycle(){
  if(this.busy)return{busy:true};this.busy=true;
  try{
   const checkpoint=await this.checkpoint();assert(this.now()-checkpoint.body.issuedAt<=60,'fresh checkpoint required');const view=await this.client.sync(checkpoint,this.url,...(this.client.bounded?[{service:true}]:[])),current=view.state;
   if(this.client.bounded)assertBoundedServiceView(current,view.certificate,this.client.config);
   else assert.equal(stateHash(current,this.client.config),view.certificate.appHash);
   const pending=this.db.prepare("SELECT * FROM proposals WHERE status='pending' ORDER BY rowid LIMIT 1").get();
   if(pending){
    const packet=JSON.parse(pending.packet),body=packet.body,type=isCentury(body)?body.domain:body.domain.slice(domain.length),funded=current.rewards?.fundedWork;
    let accepted=false;
    if(isCentury(body)&&pending.wire)accepted=current.centurySubsidy?.certificateHash===hash(JSON.parse(pending.wire).body.action.certificate);
    if(['OPEN_REWARD_WORK_V2','OPEN_REWARD_WORK_V3'].includes(type)&&funded?.book.policy.version>=body.policy.version){assert.equal(funded.book.policy.version,body.policy.version,'unexpected work window advanced');assert.deepEqual(funded.book.policy,body.policy);accepted=true;}
    if(type==='ASSIGN_REWARD_WORK_V1')accepted=Object.values(funded?.book.jobs??{}).some(j=>hash(j.request)===hash(body.request));
    if(accepted){this.db.prepare("UPDATE proposals SET status='confirmed' WHERE id=?").run(pending.id);return{confirmed:pending.id,height:current.height};}
    if(body.generation!==current.authority.generation){this.db.prepare("UPDATE proposals SET status='superseded' WHERE id=?").run(pending.id);return{superseded:pending.id,height:current.height};}
    if(current.height>=body.expires||this.now()-packet.checkpoint.body.issuedAt>60){this.db.prepare("UPDATE proposals SET status='expired' WHERE id=?").run(pending.id);return{expired:pending.id,height:current.height};}
    if(isCentury(body)){
     const latest=await planningView(this.client,this.url,checkpoint,this.client.bounded?{offset:0}:undefined);
     if(!centuryCurrent(latest.state,body)){this.db.prepare("UPDATE proposals SET status='superseded' WHERE id=?").run(pending.id);return{superseded:pending.id,height:current.height};}
     if(!packet.founderConsent){
      const consent=await this.founderConsent?.(structuredClone(body));
      if(!consent)return{awaitingFounderConsent:pending.id,height:current.height};
      packet.founderConsent=consent;assert(founderAuthorized(latest.state,packet),'founder subsidy consent');
      this.db.prepare('UPDATE proposals SET packet=? WHERE id=?').run(JSON.stringify(packet),pending.id);
     }
     assert(founderAuthorized(latest.state,packet),'founder subsidy consent');
    }
    let wire=pending.wire&&JSON.parse(pending.wire);
    if(!wire){const outcomes=await Promise.allSettled(this.signers.map(fn=>Promise.resolve().then(()=>fn(packet))));
     // Finish every signing request before releasing the cycle lock. A failed
     // peer must not leave another signer busy when a durable retry starts.
     const failures=[],byKey=new Map();for(const result of outcomes){
      if(result.status==='rejected'){failures.push(result.reason);continue;}
      try{verifyValidatorApprovals(body,result.value,current.authority.validators);}catch(e){failures.push(e);continue;}
      for(const a of result.value)byKey.set(a.key,a);
     }
     const approvals=[...byKey.values()].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
     try{validatorQuorum(body,approvals,current.authority.validators);}catch(e){throw failures[0]??e;}
     wire=envelope(this.client.config,{type,certificate:{body,approvals},...(isCentury(body)?{founderConsent:packet.founderConsent}:{})},this.key);this.db.prepare('UPDATE proposals SET wire=? WHERE id=?').run(JSON.stringify(wire),pending.id);
    }
    // Durable retries must still match the current certified authority and packet.
    assert.deepEqual(wire.body.action.certificate.body,body,'stored reward certificate body');
    assert.equal(wire.body.action.type,type,'stored reward action');
    if(isCentury(body))assert.equal(wire.body.action.founderConsent,packet.founderConsent,'stored founder consent');
    validatorQuorum(body,wire.body.action.certificate.approvals,current.authority.validators);
    await this.broadcast(wire);return{submitted:pending.id,height:current.height};
   }
   const planning=this.client.bounded?{offset:this.db.prepare('SELECT offset FROM planning_cursor WHERE id=1').get().offset}:undefined;
   const {state,page}=await planningView(this.client,this.url,checkpoint,planning),proposal=nextRewardProposal(state,this.plannerOptions);
   if(!proposal){
    if(page)this.db.prepare('UPDATE planning_cursor SET offset=? WHERE id=1').run(page.next??0);
    return{idle:true,height:current.height,...(page?{planningPage:page}:{})};
   }
   const packet={checkpoint,body:certificateBody(state,proposal,this.client.config),...(planning?{planning}:{})},id=hash(packet.body);
   if(this.db.prepare('SELECT 1 FROM proposals WHERE id=?').get(id))return{awaitingCheckpoint:true,height:current.height};
   this.db.prepare("INSERT INTO proposals(id,packet,status) VALUES(?,?,'pending')").run(id,JSON.stringify(packet));return{prepared:id,height:current.height};
  }finally{this.busy=false;}
 }
 close(){this.db.close();}
}
