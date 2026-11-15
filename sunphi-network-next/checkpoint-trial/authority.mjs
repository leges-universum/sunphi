// Ordered control-plane transitions; never move money or authorize monetary work.
import assert from 'node:assert/strict';
import {hash,exact,integer,hex,publicKey,verify} from './crypto.mjs';
import {validatorSet,validatorQuorum} from './validator-authority.mjs';
import {CHANGE_VALIDATORS,changeValidators} from './validator-membership.mjs';
export {validatorQuorum} from './validator-authority.mjs';
export const CONTROL='DUEBYTE_TRIAL_CONTROL_V1';
export const DELAYED_FEATURE='DUEBYTE_SCHEDULED_PAYMENT_V1';
export const RESOURCE_FEATURE='DUEBYTE_RESOURCE_LIMITS_V1';
export const SPEND_FEATURE='DUEBYTE_SPEND_PROTECTION_V1';
export function controlActions(config){return ['RENEW_POLICY','ENABLE_DELAYED_PAYMENTS','ENABLE_RESOURCE_LIMITS','ENABLE_SPEND_PROTECTION_V1',config.control?.version===2?CHANGE_VALIDATORS:'ROTATE_VALIDATOR'];}
export function resourceLimitsEnabled(state){const p=state.authority?.resourceLimits;return !!p&&state.height>=p.activation;}
export function delayedPaymentsEnabled(state){const p=state.authority?.delayedPayments;return !!p&&state.height>=p.activation;}
export function policyFields(p){return {version:p.version,members:p.members,threshold:p.threshold,maxAge:p.maxAge,notAfter:p.notAfter};}
export function validateFields(p){
 exact(p,['version','members','threshold','maxAge','notAfter']);integer(p.version,1);integer(p.maxAge,1);assert(p.maxAge<=86400);integer(p.notAfter,1);
 assert(Array.isArray(p.members)&&p.members.length>=4&&p.members.length<=32);
 const keys=new Set(),groups=new Set();for(const m of p.members){exact(m,['key','group']);publicKey(m.key);hex(m.group);assert(!keys.has(m.key)&&!groups.has(m.group));keys.add(m.key);groups.add(m.group);}
 integer(p.threshold,1);assert(p.threshold>2*p.members.length/3&&p.threshold<=p.members.length);return p;
}
export function quorum(body,signatures,members,threshold){
 assert(Array.isArray(signatures)&&signatures.length<=members.length);const seen=new Set(),authorized=new Set(members.map(m=>m.key));
 for(const s of signatures){exact(s,['key','signature']);assert(authorized.has(s.key)&&!seen.has(s.key),'unauthorized or duplicate control signer');assert(verify(body,s.signature,s.key),'control signature');seen.add(s.key);}
 assert(seen.size>=threshold,'control quorum');
}
export function validateControl(c){
 exact(c,['validators','policy',...(Object.hasOwn(c,'version')?['version']:[])]);
 if(Object.hasOwn(c,'version'))assert.equal(c.version,2,'explicit authority version');
 assert.equal(validatorSet(c.validators).version,c.version??1,'validator schema matches control version');
 validateFields(c.policy);return c;
}
export function initialAuthority(c){validateControl(c);return {...(c.version===2?{version:2}:{}),validators:structuredClone(c.validators),usedKeys:c.validators.map(v=>v.key).sort(),generation:0,pending:null,policy:structuredClone(c.policy),renewals:[]};}
export function activate(a,height){if(!a?.pending)return a;assert(height<=a.pending.activation,'missed activation');if(height!==a.pending.activation)return a;const next=structuredClone(a);next.validators=next.pending.validators;next.pending=null;next.generation++;return next;}
export function verifyRenewal(cert,previous,{network,configHash}){
 exact(cert,['body','oldSignatures','newSignatures']);const b=cert.body;
 exact(b,['domain','network','configHash','previous','next','notBefore','expires']);
 assert.equal(b.domain,CONTROL+'/POLICY');assert.equal(b.network,network);assert.equal(b.configHash,configHash);assert.equal(b.previous,hash(previous));validateFields(b.next);
 assert.equal(b.next.version,previous.version+1,'policy version');integer(b.notBefore,1);integer(b.expires,1);
 assert(b.notBefore<b.expires&&b.expires<=previous.notAfter,'renew before retirement');
 assert(b.next.notAfter>previous.notAfter&&b.next.notAfter<=previous.notAfter+31*86400,'bounded policy extension');
 quorum(b,cert.oldSignatures,previous.members,previous.threshold);quorum(b,cert.newSignatures,b.next.members,b.next.threshold);return b.next;
}
export function applyControl(a,action,{config,height,time}){
 assert(a,'control transitions not enabled in this genesis');const context={network:config.chainId,configHash:hash(config)};
 if(action.type===CHANGE_VALIDATORS)return changeValidators(a,action,{config,height});
 if(['ENABLE_DELAYED_PAYMENTS','ENABLE_RESOURCE_LIMITS','ENABLE_SPEND_PROTECTION_V1'].includes(action.type)){
  exact(action,['type','certificate']);const cert=action.certificate;exact(cert,['body','approvals']);const b=cert.body;
  exact(b,['domain','network','configHash','generation','feature','activation','notBefore','expires']);
  assert.equal(b.domain,CONTROL+'/FEATURE');assert.equal(b.network,context.network);assert.equal(b.configHash,context.configHash);assert.equal(b.generation,a.generation);
  const field=action.type==='ENABLE_RESOURCE_LIMITS'?'resourceLimits':action.type==='ENABLE_SPEND_PROTECTION_V1'?'spendProtection':'delayedPayments';
  assert.equal(b.feature,field==='resourceLimits'?RESOURCE_FEATURE:field==='spendProtection'?SPEND_FEATURE:DELAYED_FEATURE);assert(!a[field],'feature already enabled');
  integer(b.notBefore,1);integer(b.expires,1);integer(b.activation,1);
  assert(b.expires>=b.notBefore&&b.expires-b.notBefore<=100&&height>=b.notBefore&&height<=b.expires,'feature inclusion height');
  assert(b.activation>=b.expires+2&&b.activation<=b.expires+10000,'feature activation height');
  validatorQuorum(b,cert.approvals,a.validators);const out=structuredClone(a);out[field]={activation:b.activation,certificate:hash(cert)};return out;
 }
 if(action.type==='RENEW_POLICY'){
  exact(action,['type','certificate']);const next=verifyRenewal(action.certificate,a.policy,context),b=action.certificate.body;
  assert(!a.renewals.length||a.renewals.at(-1).height<height,'one policy renewal per block');
  assert(time>=b.notBefore&&time<b.expires,'renewal inclusion time');
  const out=structuredClone(a);out.policy=structuredClone(next);out.renewals.push({certificate:action.certificate,height,time});assert(out.renewals.length<=256,'trial policy archive capacity');return out;
 }
 exact(action,['type','certificate']);assert.equal(action.type,'ROTATE_VALIDATOR');assert(a.version!==2,'V2 requires versioned membership change');assert(!a.pending,'rotation pending');
 const cert=action.certificate;exact(cert,['body','approvals','possession']);const b=cert.body;
 exact(b,['domain','network','configHash','generation','slot','oldKey','newKey','group','notBefore','expires']);
 assert.equal(b.domain,CONTROL+'/VALIDATOR');assert.equal(b.network,context.network);assert.equal(b.configHash,context.configHash);assert.equal(b.generation,a.generation);
 integer(b.slot);assert(b.slot<10);assert.equal(b.oldKey,a.validators[b.slot].key);publicKey(b.newKey);hex(b.group);
 assert(!a.usedKeys.includes(b.newKey),'retired/reused validator key');assert(!a.validators.some((v,i)=>i!==b.slot&&v.group===b.group),'duplicate control group');
 integer(b.notBefore,1);integer(b.expires,1);assert(b.expires>b.notBefore&&b.expires-b.notBefore<=100&&height>=b.notBefore&&height<=b.expires,'rotation inclusion height');
 validatorQuorum(b,cert.approvals,a.validators);assert(verify(b,cert.possession,b.newKey),'new signer possession');
 const out=structuredClone(a),validators=structuredClone(a.validators);validators[b.slot]={key:b.newKey,group:b.group};out.pending={activation:height+2,validators,oldKey:b.oldKey,newKey:b.newKey,certificate:hash(cert)};out.usedKeys.push(b.newKey);out.usedKeys.sort();assert(out.usedKeys.length<=2048,'trial rotation archive capacity');return out;
}
export function validatorUpdates(state,height){const p=state.authority?.pending;return p?.activation===height+2?(state.authority.version===2?structuredClone(p.updates):[{key:p.oldKey,power:0},{key:p.newKey,power:10}]):[];}
export function documentPolicy(root,renewals,configHash){
 let fields=policyFields(root),lastHeight=0,lastTime=0;
 assert(Array.isArray(renewals)&&renewals.length<=256);
 for(const r of renewals){exact(r,['certificate','height','time']);integer(r.height,1);integer(r.time,1);assert(r.height>lastHeight&&r.time>=lastTime,'renewal order');fields=verifyRenewal(r.certificate,fields,{network:root.network,configHash});assert(r.time>=r.certificate.body.notBefore&&r.time<r.certificate.body.expires,'renewal time');lastHeight=r.height;lastTime=r.time;}
 return {...root,...fields};
}
