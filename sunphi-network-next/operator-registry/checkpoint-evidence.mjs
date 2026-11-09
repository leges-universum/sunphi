// WebCrypto verification of the existing checkpoint/renewal wire contract.
// This observer cannot change the consensus state or issue a checkpoint.
import {hash,verify,need,canonical} from './contract.mjs';
const exact=(v,k)=>need(v&&Object.keys(v).sort().join('|')===k.sort().join('|'),'Invalid checkpoint fields');
const fields=p=>({version:p.version,members:p.members,threshold:p.threshold,maxAge:p.maxAge,notAfter:p.notAfter});
async function quorum(body,signatures,p){need(Array.isArray(signatures)&&signatures.length<=p.members.length,'Invalid quorum');const seen=new Set();for(const s of signatures){need(p.members.some(m=>m.key===s.key)&&!seen.has(s.key)&&await verify(body,s.signature,s.key),'Invalid checkpoint signature');seen.add(s.key);}need(seen.size>=p.threshold,'Checkpoint quorum required');}
function policyShape(p){need(Number.isSafeInteger(p.version)&&p.version>0&&Number.isSafeInteger(p.notAfter)&&Number.isSafeInteger(p.maxAge)&&p.maxAge>0&&p.maxAge<=86400,'Invalid policy');need(Array.isArray(p.members)&&p.members.length>=4&&p.members.length<=32&&new Set(p.members.map(m=>m.key)).size===p.members.length&&new Set(p.members.map(m=>m.group)).size===p.members.length,'Invalid policy membership');need(Number.isSafeInteger(p.threshold)&&p.threshold>2*p.members.length/3&&p.threshold<=p.members.length,'Invalid policy threshold');}
export async function checkpointCertificate(doc,{root,configHash},previous=null,now=Math.floor(Date.now()/1000)){
 exact(doc,['body','signatures',...(doc.renewals?['renewals']:[])]);let p=fields(root);const renewals=doc.renewals??[];need(Array.isArray(renewals)&&renewals.length<=256,'Invalid renewals');let height=0,time=0;
 for(const r of renewals){exact(r,['certificate','height','time']);const c=r.certificate,b=c.body;exact(c,['body','oldSignatures','newSignatures']);exact(b,['domain','network','configHash','previous','next','notBefore','expires']);policyShape(b.next);
  need(b.domain==='DUEBYTE_TRIAL_CONTROL_V1/POLICY'&&b.network===root.network&&b.configHash===configHash&&b.previous===await hash(p),'Invalid policy lineage');
  need(b.next.version===p.version+1&&Number.isSafeInteger(b.notBefore)&&Number.isSafeInteger(b.expires)&&b.notBefore<b.expires&&b.expires<=p.notAfter&&b.next.notAfter>p.notAfter&&b.next.notAfter<=p.notAfter+31*86400,'Invalid policy term');
  need(Number.isSafeInteger(r.height)&&r.height>height&&Number.isSafeInteger(r.time)&&r.time>=time&&r.time>=b.notBefore&&r.time<b.expires,'Invalid policy inclusion');
  await quorum(b,c.oldSignatures,p);await quorum(b,c.newSignatures,b.next);p=b.next;height=r.height;time=r.time;
 }
 const effective={...root,...p},b=doc.body;policyShape(p);exact(b,['domain','policyHash','network','genesisHash','sequence','height','blockHash','appHeight','appHash','snapshotHash','previous','issuedAt','expiresAt']);
 need(b.domain==='DUEBYTE_CHECKPOINT_TRIAL_V1'&&b.network===root.network&&b.genesisHash===root.genesisHash&&b.policyHash===await hash(effective),'Invalid checkpoint binding');
 need(['sequence','height','appHeight','issuedAt','expiresAt'].every(k=>Number.isSafeInteger(b[k])&&b[k]>0)&&b.height>=2&&b.appHeight===b.height-1&&height<=b.appHeight,'Invalid checkpoint counters');
 need(b.issuedAt<=now+30&&now-b.issuedAt<=180&&b.expiresAt>now&&b.expiresAt>b.issuedAt&&b.expiresAt-b.issuedAt<=p.maxAge&&now<p.notAfter,'Checkpoint is not current');
 if(previous){need(b.height>=previous.body.height&&b.sequence>=previous.body.sequence&&b.issuedAt>=previous.body.issuedAt,'Checkpoint rollback');if(b.sequence===previous.body.sequence)need(canonical(b)===canonical(previous.body),'Checkpoint conflict');const old=previous.renewals??[];need(renewals.length>=old.length&&canonical(renewals.slice(0,old.length))===canonical(old),'Policy rollback');}
 await quorum(b,doc.signatures,p);return {policy:p,renewals};
}
export async function checkpointEvidence(doc,state,pins,previous=null,now=Math.floor(Date.now()/1000)){
 const {policy:p,renewals}=await checkpointCertificate(doc,pins,previous,now),b=doc.body,{configHash}=pins;
 need(state.height===b.appHeight&&state.configHash===configHash&&await hash(state)===b.snapshotHash&&b.snapshotHash===b.appHash,'Snapshot mismatch');
 need(canonical(state.authority.policy)===canonical(p)&&canonical(state.authority.renewals)===canonical(renewals),'Policy state mismatch');
 return {policy:p,sample:{verified:true,time:b.issuedAt,...paymentMetrics(state),lagBlocks:0},logicalValidators:state.authority.validators.length,height:b.height};
}
export function paymentMetrics(state){
 const requests=Object.values(state.money.requests),pruned=!!state.authority?.resourceLimits&&state.height>=state.authority.resourceLimits.activation;
 // A bounded retained set cannot supply a lifetime settlement count or rate.
 return {settled:pruned?null:requests.filter(r=>r.status==='SETTLED').length,settledMetric:pruned?'unavailable_after_pruning':'cumulative',pending:requests.filter(r=>r.status==='RESERVED'||r.status==='SCHEDULED').length};
}
