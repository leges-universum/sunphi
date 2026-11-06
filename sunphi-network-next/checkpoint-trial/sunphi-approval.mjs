import assert from'node:assert/strict';
import{hash,sign}from'./crypto.mjs';
import{envelope}from'./core.mjs';
import{approvalTransportRequest,verifyApprovalRequest,verifyApprovalDecision,decisionPaymentApproval}from'./approval-transport.mjs';
import{spendPolicy,applySpendPolicy,approvalBody}from'./spend-protection.mjs';
// Durable requests and exact signed replies. No auto-enrolment or bypass on failure.
export class SunPhiApproval{
 constructor({connection,wallet,store,walletId,checkpoint,now=()=>Math.floor(Date.now()/1000)}){Object.assign(this,{connection,wallet,store,walletId,checkpoint,now});wallet.db.exec('CREATE TABLE IF NOT EXISTS sunphi_approvals(id TEXT PRIMARY KEY,body TEXT NOT NULL,status TEXT NOT NULL,response TEXT,wire TEXT)');}
 rows(){return this.wallet.db.prepare('SELECT id,body,status FROM sunphi_approvals ORDER BY rowid DESC LIMIT 20').all().map(r=>({id:r.id,status:r.status,kind:JSON.parse(r.body).request.body.kind,expires:JSON.parse(r.body).expires,pid:JSON.parse(r.body).request.body.payload.intent?.pid??null}));}
 async open(kind,buildPayload){
  await this.connection.refresh(this.walletId,this.wallet.key);assert(this.store.sunphiLink(this.walletId)?.status==='linked','Connect Sun·Phi first.');
  const checkpoint=await this.checkpoint(),verified=await this.wallet.client.checkpointSnapshot(checkpoint,this.wallet.url),state=verified.state,config=this.wallet.client.config,payload=buildPayload(state);
  for(const row of this.wallet.db.prepare("SELECT body FROM sunphi_approvals WHERE status IN ('opening','pending','submitted')").all()){
   const existing=JSON.parse(row.body),q=existing.request.body;if(q.expires<=this.now()||q.kind!==kind)continue;
   if(kind==='policy'){assert.equal(q.payload.enabled,payload.enabled,'Finish or decline the pending settings request first.');return existing;}
   if(q.payload.intent.pid===payload.intent.pid)return existing;
  }
  const packet=approvalTransportRequest(config,this.wallet.key,kind,payload,this.now()),context=verifyApprovalRequest(packet,state,{root:{network:config.chainId},configHash:hash(config)},this.now());
  this.wallet.db.prepare('INSERT INTO sunphi_approvals(id,body,status) VALUES(?,?,?)').run(context.id,JSON.stringify(context),'opening');
  await this.connection.call({action:'approval_open',packet,checkpoint,state});this.wallet.db.prepare("UPDATE sunphi_approvals SET status='pending' WHERE id=?").run(context.id);return context;
 }
 async policy(enabled){assert(typeof enabled==='boolean');return this.open('policy',state=>{const old=spendPolicy(state,this.wallet.key.publicKey);assert(old?.enabled!==enabled,'This option already has the requested state.');return{enabled,version:(old?.version??0)+1,recoveryDelay:old?.recoveryDelay??86400};});}
 async payment(pid){return this.open('payment',state=>{const row=this.wallet.db.prepare('SELECT body FROM outgoing WHERE pid=?').get(pid);assert(row,'Unknown local payment.');const intent=JSON.parse(row.body).body.action.signed.intent;return{intent,approval:approvalBody(state,intent,Math.min(state.money.time,this.now())+600)};});}
 async sync(){
  for(const row of this.wallet.db.prepare("SELECT * FROM sunphi_approvals WHERE status IN ('opening','pending','submitted') ORDER BY rowid LIMIT 8").all()){
   const context=JSON.parse(row.body),q=context.request.body,{state}=await this.wallet.view();
   if(q.kind==='payment'&&state.money.requests[q.payload.intent.pid]){this.wallet.db.prepare("UPDATE sunphi_approvals SET status='confirmed' WHERE id=?").run(row.id);continue;}
   if(row.wire&&q.kind==='policy'){
    const wire=JSON.parse(row.wire),actual=spendPolicy(state,q.wallet),target=wire.body.action.body.policy;
    if(actual?.version===target.version&&actual.enabled===target.enabled&&actual.approver===target.approver&&actual.recovery===target.recovery){this.wallet.db.prepare("UPDATE sunphi_approvals SET status='confirmed' WHERE id=?").run(row.id);continue;}
   }
   if(this.now()>=q.expires){this.wallet.db.prepare("UPDATE sunphi_approvals SET status='expired' WHERE id=?").run(row.id);continue;}
   if(row.status==='opening'){
    const checkpoint=await this.checkpoint(),fresh=await this.wallet.client.checkpointSnapshot(checkpoint,this.wallet.url),config=this.wallet.client.config;
    const checked=verifyApprovalRequest(context.request,fresh.state,{root:{network:config.chainId},configHash:hash(config)},this.now());assert.equal(hash(checked),hash(context),'Request policy changed.');
    await this.connection.call({action:'approval_open',packet:context.request,checkpoint,state:fresh.state});this.wallet.db.prepare("UPDATE sunphi_approvals SET status='pending' WHERE id=?").run(row.id);continue;
   }
   const result=await this.connection.call(this.connection.signed(this.wallet.key,'approval_status',{id:row.id}));assert.equal(result.id,row.id);assert.equal(hash(result.context),hash(context),'Request context changed.');
   if(result.status==='pending')continue;verifyApprovalDecision(context,result.response);
   if(result.response.decision==='reject'){this.wallet.db.prepare("UPDATE sunphi_approvals SET status='rejected',response=? WHERE id=?").run(JSON.stringify(result.response),row.id);continue;}
   if(q.kind==='payment'){
    const approval=decisionPaymentApproval(context,result.response,state);await this.wallet.acceptApproval(q.payload.intent.pid,approval);this.wallet.db.prepare("UPDATE sunphi_approvals SET status='submitted',response=? WHERE id=?").run(JSON.stringify(result.response),row.id);await this.wallet.resume(q.payload.intent.pid);
   }else{
    const action={type:'SET_SPEND_POLICY_V1',body:result.response.body,signatures:{wallet:sign(result.response.body,this.wallet.key.privateKey),...result.response.signatures}};
    applySpendPolicy(state,action,this.wallet.key.publicKey);const wire=envelope(this.wallet.client.config,action,this.wallet.key);
    this.wallet.db.prepare("UPDATE sunphi_approvals SET status='submitted',response=?,wire=? WHERE id=?").run(JSON.stringify(result.response),JSON.stringify(wire),row.id);await this.wallet.broadcast(wire);
   }
  }
 }
}
