// Optional founder-owned recovery policy; legacy reserve states stay byte-identical.
import assert from 'node:assert/strict';
import {exact,integer,publicKey,verify,hash,hex} from './crypto.mjs';
export const RECOVERY_ACTIONS=['ROTATE_DEVELOPMENT_MANAGER_V1','SCHEDULE_DEVELOPMENT_RECOVERY_V1','CANCEL_DEVELOPMENT_RECOVERY_V1','EXECUTE_DEVELOPMENT_RECOVERY_V1'];
export function validateRecovery(p){
 exact(p,['keys','threshold','delaySeconds']);assert(Array.isArray(p.keys)&&p.keys.length===3&&new Set(p.keys).size===3);
 p.keys.forEach(publicKey);assert.deepEqual(p.keys,[...p.keys].sort());assert.equal(p.threshold,2);
 integer(p.delaySeconds,86400);assert(p.delaySeconds<=30*86400);return p;
}
export const accessState=p=>({manager:p.manager,epoch:0,recovery:structuredClone(validateRecovery(p.recovery)),sequence:0,pending:null,last:null});
export const developmentManager=r=>r.development.access?.manager??r.policy.development.manager;
export const managerFields=r=>r.development.access?['managementEpoch']:[];
export function managerGuard(r,a,author){
 assert.equal(author,developmentManager(r),'founder management signature');
 if(r.development.access){assert.equal(a.managementEpoch,r.development.access.epoch,'management epoch');assert(!r.development.access.pending,'recovery pending');}
}
export function recoveryBody(s,action,fields){return {domain:'DUEBYTE_RESERVE_RECOVERY_V1/'+action,configHash:s.configHash,epoch:s.networkReserves.development.access.epoch,...fields};}
export function recoveryApprovals(body,approvals,p){
 validateRecovery(p);assert(Array.isArray(approvals)&&approvals.length>=p.threshold&&approvals.length<=3);
 const used=new Set();for(const a of approvals){exact(a,['key','signature']);assert(p.keys.includes(a.key)&&!used.has(a.key),'unique recovery signer');assert(verify(body,a.signature,a.key),'recovery signature');used.add(a.key);}
}
function cancelSpend(d,now){if(d.pending){d.last={...d.pending,status:'CANCELLED',at:now};d.pending=null;}d.mode='PAUSED';d.modeSequence++;}
export function auditRecovery(r){
 const a=r.development.access;
 if(!r.policy.development.recovery){assert(!a);return;}
 validateRecovery(r.policy.development.recovery);assert(a);exact(a,['manager','epoch','recovery','sequence','pending','last']);publicKey(a.manager);integer(a.epoch);integer(a.sequence);validateRecovery(a.recovery);assert(!a.recovery.keys.includes(a.manager));
 if(a.pending){const p=a.pending;exact(p,['sequence','manager','recovery','notBefore','requestHash']);assert.equal(p.sequence,a.sequence);publicKey(p.manager);validateRecovery(p.recovery);assert(!p.recovery.keys.includes(p.manager));integer(p.notBefore,1);hex(p.requestHash);assert.equal(r.development.mode,'PAUSED');assert(!r.development.pending);}
}
export function applyRecovery(s,a,author){
 const r=s.networkReserves,d=r?.development,v=d?.access;assert(v,'recovery policy not configured');const now=s.money.time;
 if(a.type==='ROTATE_DEVELOPMENT_MANAGER_V1'){
  exact(a,['type','managementEpoch','manager','newConsent']);managerGuard(r,a,author);publicKey(a.manager);assert(a.manager!==v.manager&&!v.recovery.keys.includes(a.manager),'separate new management key');
  assert(verify(recoveryBody(s,a.type,{manager:a.manager}),a.newConsent,a.manager),'new manager consent');cancelSpend(d,now);v.manager=a.manager;v.epoch++;v.last={type:a.type,at:now};
 }else if(a.type==='SCHEDULE_DEVELOPMENT_RECOVERY_V1'){
  exact(a,['type','body','approvals','newConsent','newRecoveryConsents']);assert(!v.pending,'recovery already pending');const b=a.body;
  exact(b,['domain','configHash','epoch','sequence','manager','recovery','expiresAt']);assert.equal(b.domain,'DUEBYTE_RESERVE_RECOVERY_V1/'+a.type);assert.equal(b.configHash,s.configHash);assert.equal(b.epoch,v.epoch);assert.equal(b.sequence,v.sequence+1);integer(b.expiresAt,now);assert(b.expiresAt<=now+86400,'bounded recovery request');
  publicKey(b.manager);validateRecovery(b.recovery);assert(b.manager!==v.manager&&!b.recovery.keys.includes(b.manager));
  recoveryApprovals(b,a.approvals,v.recovery);assert(verify(b,a.newConsent,b.manager),'replacement manager consent');
  assert(Array.isArray(a.newRecoveryConsents)&&a.newRecoveryConsents.length===3);recoveryApprovals(b,a.newRecoveryConsents,{...b.recovery,threshold:2});assert.deepEqual(a.newRecoveryConsents.map(x=>x.key).sort(),b.recovery.keys,'replacement backup possession');
  cancelSpend(d,now);v.sequence=b.sequence;v.pending={sequence:b.sequence,manager:b.manager,recovery:structuredClone(b.recovery),notBefore:now+v.recovery.delaySeconds,requestHash:hash(b)};
 }else if(a.type==='CANCEL_DEVELOPMENT_RECOVERY_V1'){
  exact(a,['type','body','approvals']);assert(v.pending,'no pending recovery');const b=recoveryBody(s,a.type,{sequence:v.pending.sequence,requestHash:v.pending.requestHash});assert.deepEqual(a.body,b);recoveryApprovals(b,a.approvals,v.recovery);v.last={type:a.type,sequence:v.sequence,at:now};v.pending=null;v.epoch++;
 }else{
  assert.equal(a.type,'EXECUTE_DEVELOPMENT_RECOVERY_V1');exact(a,['type','managementEpoch','sequence','requestHash']);assert.equal(a.managementEpoch,v.epoch);const p=v.pending;assert(p&&p.sequence===a.sequence&&p.requestHash===a.requestHash,'pending recovery match');assert(now>=p.notBefore,'recovery delay');
  v.manager=p.manager;v.recovery=structuredClone(p.recovery);v.epoch++;v.pending=null;v.last={type:a.type,sequence:p.sequence,at:now};cancelSpend(d,now);
 }
 auditRecovery(r);return s;
}
