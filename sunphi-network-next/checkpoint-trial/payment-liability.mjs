// Prospective, opt-in liability for objectively false signed payment facts.
// No accusation by vote, retrospective penalty, arbitrary loss claim or mint.
import assert from 'node:assert/strict';
import {hash,verify,sign,exact,integer,hex,publicKey,canonical} from './crypto.mjs';
import {quorum} from './authority.mjs';
import {developmentManager} from './reserve-recovery.mjs';
import {PROTECTION_RESERVE_ACTIONS,initialProtection,protectionEvent,protectionAuthority,applyProtectionAction,auditProtection,reconcileProtection} from './protection-reserve.mjs';
export const LIABILITY='DUEBYTE_PAYMENT_LIABILITY_V1';
export const LIABILITY_ACTIONS=['PREPARE_PAYMENT_LIABILITY_V1','ACCEPT_PAYMENT_LIABILITY_V1','REPORT_PAYMENT_FAULT_V1','RESOLVE_PAYMENT_FAULT_V1','READMIT_PAYMENT_WORKER_V1',...PROTECTION_RESERVE_ACTIONS];
const amt=x=>{assert(typeof x==='string'&&/^(0|[1-9][0-9]*)$/.test(x));const v=BigInt(x);assert(v<(1n<<64n));return v;};
// All security delays use consensus block height, never the payment-action clock.
const active=m=>!!m.liability&&m.liability.height>=m.liability.policy.activation;
export const liabilityEnabled=active;
export function liabilityPolicy(p){
 exact(p,['version','activation','challengeBlocks','suspensionBlocks','exceptionDelaySeconds','penaltyBps','maxOpen','founderKey','founderGroup','founderNodes']);assert.equal(p.version,1);integer(p.activation,1);integer(p.challengeBlocks,2);assert(p.challengeBlocks<=10000);integer(p.suspensionBlocks,1);assert(p.suspensionBlocks<=10000);integer(p.exceptionDelaySeconds,86400);assert(p.exceptionDelaySeconds<=30*86400);integer(p.penaltyBps,1);assert(p.penaltyBps<=10000);integer(p.maxOpen,1);assert(p.maxOpen<=32);publicKey(p.founderKey);hex(p.founderGroup);assert(Array.isArray(p.founderNodes)&&p.founderNodes.length<=256&&new Set(p.founderNodes).size===p.founderNodes.length);p.founderNodes.forEach(hex);return p;
}
export function liabilityConsent(m,node){return {domain:LIABILITY+'/CONSENT',network:m.liability.network,configHash:m.liability.configHash,policyHash:hash(m.liability.policy),node};}
export function effectiveWorkGroup(m,node){return active(m)&&m.liability.policy.founderNodes.includes(node)?m.liability.policy.founderGroup:m.nodes[node].operator;}
export function founderWorker(m,node){return active(m)&&m.liability.policy.founderNodes.includes(node);}
export function eligibleLiabilityWorker(m,node){return !active(m)||!!m.liability.consents[node]&&!m.liability.discipline[node]?.suspended;}
export function liabilityReserve(m,pid){if(!active(m))return;const l=m.liability,r=m.requests[pid];assert(Object.keys(l.records).length<l.policy.maxOpen,'liability record capacity');assert(!l.records[pid],'liability replay');
 const assignments=r.intent.parts.flatMap((p,index)=>p.nodes.map(node=>{assert(eligibleLiabilityWorker(m,node),'worker liability consent or readmission required');return {index,node,key:m.nodes[node].key,partValue:p.value};}));
 l.records[pid]={pid,request:r.digest,sender:r.intent.sender,recipient:r.intent.recipient,value:r.intent.value,abortFee:r.intent.abortFee,deadline:r.intent.deadline,admitted:m.height,assignments,status:'RESERVED',terminal:0,release:0,faults:{}};
}
export function liabilityTerminal(m,pid,status){const r=m.liability?.records[pid];if(!r)return false;r.status=status;r.terminal=m.liability.height;r.release=m.liability.height+m.liability.policy.challengeBlocks;integer(r.release);return true;}
export function attestationBody(m,pid,index,node,claim){const l=m.liability,r=l?.records[pid];assert(r,'liability assignment required');const a=r.assignments.find(a=>a.index===index&&a.node===node);assert(a,'assigned liability worker');return {domain:LIABILITY+'/ATTEST',network:l.network,configHash:l.configHash,policyHash:hash(l.policy),pid,request:r.request,admitted:r.admitted,index,node,claim:claim??{recipient:r.recipient,value:r.value,partValue:a.partValue}};}
export function liabilityAttestation(m,pid,index,node,key){const body=attestationBody(m,pid,index,node);return {body,signature:sign(body,key.privateKey)};}
function checkAttestation(m,att){exact(att,['body','signature']);const b=att.body;exact(b,['domain','network','configHash','policyHash','pid','request','admitted','index','node','claim']);exact(b.claim,['recipient','value','partValue']);publicKey(b.claim.recipient);amt(b.claim.value);amt(b.claim.partValue);const expected=attestationBody(m,b.pid,b.index,b.node),a=m.liability.records[b.pid].assignments.find(a=>a.index===b.index&&a.node===b.node);const {claim,...binding}=b,{claim:correct,...expectedBinding}=expected;assert.equal(canonical(binding),canonical(expectedBinding),'fault context mismatch');assert(verify(b,att.signature,a.key),'fault signature');return {correct:canonical(claim)===canonical(correct),record:m.liability.records[b.pid],assignment:a};}
export function checkLiabilityReceipt(m,pid,index,node,att){if(!m.liability?.records[pid]){assert(!att,'unexpected liability attestation');return;}assert(typeof att==='string','compact payment attestation required');const v=checkAttestation(m,{body:attestationBody(m,pid,index,node),signature:att});assert(v.correct,'false payment attestation');}
function resolveLiability(m,pid){const l=m.liability,r=l.records[pid];assert(r&&r.status!=='RESERVED'&&l.height>=r.release,'liability release window');let collected=0n;
 for(const a of r.assignments){const node=m.nodes[a.node],value=amt(a.partValue);assert(amt(node.taskHeld)>=value);node.taskHeld=String(amt(node.taskHeld)-value);if(r.faults[a.index+':'+a.node]){
  // Round upward so a small false statement never becomes a free attempt.
  const penalty=(value*BigInt(l.policy.penaltyBps)+9999n)/10000n;assert(amt(node.stake)>=penalty+amt(node.consensusHeld)+amt(node.taskHeld),'protected collateral');node.stake=String(amt(node.stake)-penalty);collected+=penalty;
 }}
 // Rejected principal was never lost. Cover only the recorded expiry fee,
 // capped by this case's penalties: no communal-pool fee farming.
 const loss=r.status==='EXPIRED'?amt(r.abortFee):0n,paid=loss<collected?loss:collected;
 let output=null;if(paid>0n){output=hash({domain:LIABILITY+'/COMPENSATION',configHash:l.configHash,pid:r.pid});assert(!m.outputs[output],'compensation replay');m.outputs[output]={owner:r.sender,value:String(paid),unlock:0};}
 l.pool=String(amt(l.pool)+collected-paid);l.protection.collected=String(amt(l.protection.collected)+collected);l.protection.compensated=String(amt(l.protection.compensated)+paid);
 protectionEvent(m,{type:'LIABILITY_RESOLVED',pid,status:r.status,evidenceHash:hash(r.faults),penalty:String(collected),loss:String(loss),compensation:String(paid),recipient:r.sender,output});delete l.records[pid];
}
export function advanceLiability(s){if(!s.money.liability)return s;const out=structuredClone(s),l=out.money.liability;l.height=out.height;reconcileProtection(out);for(const pid of Object.keys(l.records).sort()){const r=l.records[pid];if(r.status!=='RESERVED'&&l.height>=r.release)resolveLiability(out.money,pid);}return out;}
export function applyLiabilityAction(state,action,config,author){const s=structuredClone(state),m=s.money;
 if(action.type==='PREPARE_PAYMENT_LIABILITY_V1'){
  exact(action,['type','certificate','founderConsent']);assert(!m.liability,'liability already prepared');assert(s.authority?.resourceLimits&&s.height>=s.authority.resourceLimits.activation,'resource replay protection required');const cert=action.certificate;exact(cert,['body','approvals']);const b=cert.body;exact(b,['domain','network','configHash','generation','notBefore','expires','policy']);assert.equal(b.domain,LIABILITY+'/POLICY');assert.equal(b.network,config.chainId);assert.equal(b.configHash,s.configHash);assert.equal(b.generation,s.authority.generation);integer(b.notBefore,1);integer(b.expires,b.notBefore);assert(b.notBefore<=s.height&&s.height<=b.expires&&b.expires-b.notBefore<=100,'policy inclusion');liabilityPolicy(b.policy);assert(b.policy.activation>=b.expires+2&&b.policy.activation<=b.expires+10000);quorum(b,cert.approvals,s.authority.validators,7);
  assert(s.networkReserves?.development.access&&!s.networkReserves.development.access.pending,'prepared founder recovery required');assert.equal(b.policy.founderKey,s.networkReserves.policy.development.manager);assert(verify(b,action.founderConsent,developmentManager(s.networkReserves)),'founder policy consent');for(const node of b.policy.founderNodes)assert(m.nodes[node],'unknown founder worker');
  m.liability={network:b.network,configHash:b.configHash,height:s.height,policy:structuredClone(b.policy),consents:{},discipline:{},records:{},pool:'0',protection:initialProtection()};return s;
 }
 assert(m.liability,'liability not prepared');const l=m.liability;
 if(action.type==='ACCEPT_PAYMENT_LIABILITY_V1'){exact(action,['type','node','signature']);assert(m.nodes[action.node]&&author===m.nodes[action.node].key,'worker consent author');assert(!l.discipline[action.node]?.suspended,'worker quarantined');assert(verify(liabilityConsent(m,action.node),action.signature,author),'worker consent signature');assert(Object.keys(l.consents).length<256||l.consents[action.node]);l.consents[action.node]=true;return s;}
 assert(active(m),'liability not active');if(PROTECTION_RESERVE_ACTIONS.includes(action.type))return applyProtectionAction(s,action,author);
 if(action.type==='READMIT_PAYMENT_WORKER_V1'){
  exact(action,['type','node']);const n=m.nodes[action.node],d=l.discipline[action.node];assert(n?.key===author,'worker readmission author');assert(d?.suspended&&d.incidents.length===1,'repeat offender permanently excluded');assert(l.height>=d.until,'suspension window');assert(!Object.values(l.records).some(r=>Object.values(r.faults).some(f=>f.evidence.body.node===action.node)),'unresolved worker liability');assert(amt(n.stake)>amt(n.consensusHeld)+amt(n.taskHeld),'worker collateral required');d.suspended=false;protectionEvent(m,{type:'WORKER_READMITTED',node:action.node});return s;
 }
 if(action.type==='REPORT_PAYMENT_FAULT_V1'){
  exact(action,['type','attestation']);const v=checkAttestation(m,action.attestation),r=v.record;assert(!v.correct,'correct statement is not a fault');assert(r.status==='RESERVED'&&m.height<r.deadline,'fault must be recorded before settlement or deadline');const id=v.assignment.index+':'+v.assignment.node;assert(!r.faults[id],'duplicate fault');r.faults[id]={evidence:structuredClone(action.attestation),reported:m.height};
  const node=v.assignment.node,d=l.discipline[node]??={incidents:[],until:0,suspended:true};if(!d.incidents.includes(r.pid)&&d.incidents.length<2)d.incidents.push(r.pid);d.suspended=true;d.until=Math.max(d.until,l.height+l.policy.suspensionBlocks);integer(d.until);protectionEvent(m,{type:'FAULT_PROVED',pid:r.pid,node,evidenceHash:hash(action.attestation),permanent:d.incidents.length===2});return s;
 }
 exact(action,['type','pid']);assert.equal(action.type,'RESOLVE_PAYMENT_FAULT_V1');resolveLiability(m,action.pid);return s;
}
export function auditLiability(m,liabilities){const l=m.liability;if(!l)return 0n;exact(l,['network','configHash','height','policy','consents','discipline','records','pool','protection']);liabilityPolicy(l.policy);hex(l.configHash);integer(l.height,1);assert(typeof l.network==='string'&&l.network.length<=100);assert(Object.keys(l.records).length<=l.policy.maxOpen);assert(Object.keys(l.consents).length<=256);assert(Object.keys(l.discipline).length<=256);auditProtection(m);
 for(const [node,value]of Object.entries(l.consents))assert(m.nodes[node]&&value===true);
 for(const [node,d]of Object.entries(l.discipline)){assert(l.consents[node]);exact(d,['incidents','until','suspended']);assert(Array.isArray(d.incidents)&&d.incidents.length>=1&&d.incidents.length<=2&&new Set(d.incidents).size===d.incidents.length);d.incidents.forEach(hex);integer(d.until,1);assert(typeof d.suspended==='boolean');if(d.incidents.length===2)assert(d.suspended);}
 for(const [pid,r]of Object.entries(l.records)){
  exact(r,['pid','request','sender','recipient','value','abortFee','deadline','admitted','assignments','status','terminal','release','faults']);assert.equal(pid,r.pid);hex(pid);hex(r.request);publicKey(r.sender);publicKey(r.recipient);amt(r.value);amt(r.abortFee);integer(r.deadline,1);integer(r.admitted,1);assert(r.admitted<=r.deadline);assert(['RESERVED','SETTLED','SCHEDULED','EXPIRED','CANCELLED'].includes(r.status));const request=m.requests[pid];assert(request&&request.digest===r.request,'retained liability request');const i=request.intent;assert.equal(r.sender,i.sender);assert.equal(r.recipient,i.recipient);assert.equal(r.value,i.value);assert.equal(r.abortFee,i.abortFee);assert.equal(r.deadline,i.deadline);
  assert.deepEqual(r.assignments,i.parts.flatMap((p,index)=>p.nodes.map(node=>({index,node,key:m.nodes[node].key,partValue:p.value}))),'liability assignments');const seen=new Set();for(const a of r.assignments){assert(l.consents[a.node]);const id=a.index+':'+a.node;assert(!seen.has(id));seen.add(id);if(r.status!=='RESERVED')liabilities.set(a.node,(liabilities.get(a.node)??0n)+amt(a.partValue));}
  if(r.status==='RESERVED'){assert.equal(request.status,'RESERVED');assert.equal(r.release,0);assert.equal(r.terminal,0);}else{assert(request.status!=='RESERVED');integer(r.terminal,1);assert(r.terminal<=l.height);assert.equal(r.release,r.terminal+l.policy.challengeBlocks);assert(r.status===request.status||r.status==='SCHEDULED'&&['SETTLED','CANCELLED'].includes(request.status));}
  for(const [id,f]of Object.entries(r.faults)){exact(f,['evidence','reported']);assert(seen.has(id)&&id===f.evidence.body.index+':'+f.evidence.body.node);integer(f.reported,r.admitted);assert(f.reported<r.deadline);const v=checkAttestation(m,f.evidence);assert(!v.correct&&v.record===r);assert(l.discipline[v.assignment.node]);}
 }
 return amt(l.pool);
}
export function auditLiabilityState(s){if(!s.money.liability)return;assert.equal(s.money.liability.configHash,s.configHash);assert.equal(s.money.liability.height,s.height);protectionAuthority(s);}
