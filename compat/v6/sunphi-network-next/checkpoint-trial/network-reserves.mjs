// Consensus program accounts: no spending keys, no general delegation, no refill.
import assert from 'node:assert/strict';
import {hash,exact,integer,hex,publicKey,verify} from './crypto.mjs';
import {amount,audit,DOMAIN,PROGRAM_FEE_DOMAIN,policy,policyId,feeFor,reserveProgramPayment} from './payment-model.mjs';
import {DUBYT_SUPPLY_CAP} from './emission-calendar.mjs';
import {unitScale,tokenCap} from './token-units.mjs';
import {centuryWarmupAccounts} from './economic-policy-v3.mjs';
import {eligibleLiabilityWorker,effectiveWorkGroup,founderWorker} from './payment-liability.mjs';
import {quorum} from './authority.mjs';
import {RECOVERY_ACTIONS,validateRecovery,accessState,developmentManager,managerFields,managerGuard,auditRecovery,applyRecovery} from './reserve-recovery.mjs';
export const RESERVES='DUEBYTE_NETWORK_RESERVES_V1';
export const WARMUP_ALLOCATION='100000000',DEVELOPMENT_ALLOCATION='1000000000';
export const DEVELOPMENT_NAME='DueByte Development Reserve';
export const PURPOSES=['liquidity','development','security','integration','operators','ecosystem','incident','other'];
export const RESERVE_ACTIONS=['PREPARE_NETWORK_RESERVES_V1','ISSUE_NETWORK_RESERVES_V1','SET_NETWORK_RESERVE_MODE_V1','SET_DEVELOPMENT_CONTROL_V1','RUN_WARMUP_V1','QUEUE_DEVELOPMENT_SPEND_V1','CANCEL_DEVELOPMENT_SPEND_V1','EXECUTE_DEVELOPMENT_SPEND_V1',...RECOVERY_ACTIONS];
export function validateDevelopmentControls(d,scale=1n){
 exact(d,['delaySeconds','executionWindowSeconds','dailyLimit','transferLimit']);integer(d.delaySeconds);assert(d.delaySeconds<=30*86400);integer(d.executionWindowSeconds,3600);assert(d.executionWindowSeconds<=30*86400);
 assert(scale===1n||scale===1000000n,'supported control denomination');assert(amount(d.transferLimit)>0n&&amount(d.transferLimit)<=amount(d.dailyLimit)&&amount(d.dailyLimit)<=amount(DEVELOPMENT_ALLOCATION)*scale);return d;
}
export const unrestrictedDevelopmentControls=()=>({delaySeconds:0,executionWindowSeconds:7*86400,dailyLimit:DEVELOPMENT_ALLOCATION,transferLimit:DEVELOPMENT_ALLOCATION});
export function validateReservePolicy(p){
 exact(p,['warmup','development']);exact(p.warmup,['allocation','dailyFeeBudget','maxPayment','intervalSeconds','ttlBlocks']);
 assert.equal(p.warmup.allocation,WARMUP_ALLOCATION);assert(amount(p.warmup.dailyFeeBudget)>0n&&amount(p.warmup.dailyFeeBudget)<=amount(WARMUP_ALLOCATION));assert(amount(p.warmup.maxPayment)>0n);
 integer(p.warmup.intervalSeconds,1);assert(p.warmup.intervalSeconds<=86400);integer(p.warmup.ttlBlocks,4);assert(p.warmup.ttlBlocks<=policy.maxLifetime);
 exact(p.development,['allocation','manager','controls',...(p.development.recovery?['recovery']:[])]);assert.equal(p.development.allocation,DEVELOPMENT_ALLOCATION);publicKey(p.development.manager);validateDevelopmentControls(p.development.controls);if(p.development.recovery){validateRecovery(p.development.recovery);assert(!p.development.recovery.keys.includes(p.development.manager),'separate recovery keys');}return p;
}
export const reserveConsent=(configHash,p)=>({domain:RESERVES+'/FOUNDER_CONSENT',configHash,policyHash:hash(p)});
// Address-shaped identifiers, never generated keypairs. Ordinary spends are
// forbidden even if someone were to present a signature for one of these bytes.
export const reserveAddresses=configHash=>['warmup-a','warmup-b','development'].map(role=>Buffer.from(hash({domain:RESERVES+'/ACCOUNT',configHash,role}),'hex').toString('base64url'));
const outputId=(s,index)=>hash({domain:RESERVES+'/BALANCE',configHash:s.configHash,index});
export const networkReserved=s=>s.networkReserves&&!s.networkReserves.issued&&!s.economicPreparation?(amount(WARMUP_ALLOCATION)+amount(DEVELOPMENT_ALLOCATION))*unitScale(s):0n;
const balance=(s,index)=>amount(s.money.outputs[outputId(s,index)]?.value??'0');
function writeBalance(s,index,value){s.money.outputs[outputId(s,index)]={owner:reserveAddresses(s.configHash)[index],value:String(value),unlock:0};}
function consolidateWarmup(s){
 const addresses=reserveAddresses(s.configHash);for(let index=0;index<2;index++){let total=0n;for(const [id,o]of Object.entries(s.money.outputs))if(o.owner===addresses[index]){total+=amount(o.value);delete s.money.outputs[id];}writeBalance(s,index,total);}
}
function certificate(s,a,c,fields,prepare=false){
 exact(a,['type','certificate',...(prepare?['founderConsent',...(a.certificate?.body?.policy?.development?.recovery?['recoveryConsents']:[])]:[])]);exact(a.certificate,['body','approvals']);const b=a.certificate.body;
 exact(b,['domain','network','configHash','generation','notBefore','expires',...fields]);assert.equal(b.domain,RESERVES+'/'+a.type);assert.equal(b.network,c.chainId);assert.equal(b.configHash,s.configHash);assert.equal(b.generation,s.authority.generation);
 integer(b.notBefore,1);integer(b.expires,b.notBefore);assert(b.expires-b.notBefore<=100&&s.height>=b.notBefore&&s.height<=b.expires,'reserve certificate window');quorum(b,a.certificate.approvals,s.authority.validators,7);return b;
}
export function checkReservedPayment(s,i){
 // Reserve the namespace before preparation too: unsolicited dust must not
 // make the future program accounts unusable or change their fixed allocation.
 const addresses=[...reserveAddresses(s.configHash),...centuryWarmupAccounts(s.configHash)];
 assert(!addresses.includes(i.sender)&&!addresses.includes(i.recipient),'program accounts reject ordinary transfers');
}
export function warmupPlan(s){
 const r=s.networkReserves;if(!r?.issued||r.warmup.mode!=='ACTIVE'||r.warmup.pending||s.money.time<r.warmup.nextAt)return null;
 if(Object.values(s.money.requests).some(x=>['RESERVED','SCHEDULED'].includes(x.status)))return null;
 const w=r.warmup,p=r.policy.warmup,day=Math.floor(s.money.time/86400),allowance=amount(p.dailyFeeBudget)-(day===w.day?amount(w.dayFees):0n);if(allowance<=0n)return null;
 let index=w.nextWallet;if(!balance(s,index))index=1-index;const funds=balance(s,index);if(!funds)return null;
 const terminal=funds===1n;let value=0n;
 if(!terminal){let lo=1n,hi=amount(p.maxPayment)<funds?amount(p.maxPayment):funds;while(lo<=hi){const mid=(lo+hi)/2n,fee=feeFor(String(mid));if(mid+fee<=funds&&fee<=allowance){value=mid;lo=mid+1n;}else hi=mid-1n;}if(!value)return null;}
 const workValue=terminal?1n:value,operators=new Set(),nodes=[];
 // Rotate a deterministic order; caller cannot direct subsidies to chosen workers.
 const candidates=Object.keys(s.money.nodes).sort((a,b)=>{const x=hash({sequence:w.sequence,node:a}),y=hash({sequence:w.sequence,node:b});return x<y?-1:x>y?1:0;});
 for(const id of candidates){const n=s.money.nodes[id];if(!eligibleLiabilityWorker(s.money,id)||(operators.has(effectiveWorkGroup(s.money,id))&&!founderWorker(s.money,id))||amount(n.consensusHeld)===0n||amount(n.tier)<workValue||amount(n.stake)-amount(n.consensusHeld)-amount(n.taskHeld)<workValue)continue;operators.add(effectiveWorkGroup(s.money,id));nodes.push(id);if(nodes.length===policy.copies)break;}
 if(nodes.length!==policy.copies)return null;
 const addresses=reserveAddresses(s.configHash),pid=hash({domain:RESERVES+'/PAYMENT',configHash:s.configHash,sequence:w.sequence});
 return {domain:terminal?PROGRAM_FEE_DOMAIN:DOMAIN+'/INTENT',policy:policyId,network:policy.network,pid,sender:addresses[index],recipient:addresses[1-index],inputs:[outputId(s,index)],value:String(value),fee:terminal?'1':String(feeFor(String(value))),abortFee:'0',epoch:s.money.epoch,lastReserve:s.money.height+1,deadline:s.money.height+p.ttlBlocks,delay:0,parts:[{value:String(workValue),nodes}]};
}
export function applyReserveAction(base,a,author,c){
 assert(base.authority);const s={...base,money:{...base.money,...(base.money.liability?{liability:structuredClone(base.money.liability)}:{})},...(base.networkReserves?{networkReserves:structuredClone(base.networkReserves)}:{})};let r=s.networkReserves;
 if(a.type==='PREPARE_NETWORK_RESERVES_V1'){
  const b=certificate(s,a,c,['policy'],true);validateReservePolicy(b.policy);assert(!r&&!s.launchFund,'one reserve program; legacy launch cannot coexist');assert(!s.authority.nodeRewards&&!s.rewards,'reserve allocations before reward calendar');
  assert(verify(reserveConsent(s.configHash,b.policy),a.founderConsent,b.policy.development.manager),'founder consent');const addresses=reserveAddresses(s.configHash);assert(!addresses.includes(b.policy.development.manager));
  if(b.policy.development.recovery){const ks=b.policy.development.recovery.keys;assert(Array.isArray(a.recoveryConsents)&&a.recoveryConsents.length===3);assert.deepEqual(a.recoveryConsents.map(x=>x.key).sort(),ks);for(const proof of a.recoveryConsents){exact(proof,['key','signature']);assert(verify(reserveConsent(s.configHash,b.policy),proof.signature,proof.key),'recovery key possession');}}
  assert(!Object.values(s.money.outputs).some(o=>addresses.includes(o.owner)));assert(!Object.values(s.money.requests).some(q=>addresses.includes(q.intent.sender)||addresses.includes(q.intent.recipient)));
  s.networkReserves={policy:structuredClone(b.policy),prepared:hash(a.certificate),issued:null,issuedAt:0,warmup:{mode:'PAUSED',modeSequence:0,sequence:0,spentFees:'0',day:0,dayFees:'0',nextAt:0,nextWallet:0,pending:null,settled:0,expired:0,last:null},development:{mode:'PAUSED',modeSequence:0,controls:structuredClone(b.policy.development.controls),sequence:0,spent:'0',day:0,daySpent:'0',pending:null,last:null},history:hash({domain:RESERVES,policy:b.policy})};
  if(b.policy.development.recovery)s.networkReserves.development.access=accessState(b.policy.development);
 }else{
  assert(r,'reserves not prepared');
  if(RECOVERY_ACTIONS.includes(a.type))applyRecovery(s,a,author);
  else if(a.type==='ISSUE_NETWORK_RESERVES_V1'){
   const b=certificate(s,a,c,['policyHash']);assert.equal(b.policyHash,hash(r.policy));if(r.issued)return base;
   assert(s.rewards?.coefficients.calendar,'reward calendar required before explicit issuance');
   s.money.outputs={...s.money.outputs};writeBalance(s,0,amount(WARMUP_ALLOCATION));writeBalance(s,1,0n);writeBalance(s,2,amount(DEVELOPMENT_ALLOCATION));s.money.supply=String(amount(s.money.supply)+networkReserved(s));r.issued=hash(a.certificate);r.issuedAt=s.money.time;
   // Explicit issuance does NOT start either spending program.
  }else if(a.type==='SET_NETWORK_RESERVE_MODE_V1'){
   const b=certificate(s,a,c,['policyHash','target','sequence','mode']);assert.equal(b.policyHash,hash(r.policy));assert.equal(b.target,'warmup');assert(['ACTIVE','PAUSED'].includes(b.mode));assert(r.issued,'not issued');const f=r[b.target];
   if(b.sequence===f.modeSequence){assert.equal(b.mode,f.mode);return base;}assert.equal(b.sequence,f.modeSequence+1);f.mode=b.mode;f.modeSequence=b.sequence;
  }else if(a.type==='SET_DEVELOPMENT_CONTROL_V1'){
   exact(a,['type','sequence','mode','controls',...managerFields(r)]);managerGuard(r,a,author);assert(r.issued,'not issued');assert.equal(a.sequence,r.development.modeSequence+1);assert(['ACTIVE','PAUSED'].includes(a.mode));validateDevelopmentControls(a.controls,unitScale(s));
   r.development.controls=structuredClone(a.controls);r.development.mode=a.mode;r.development.modeSequence=a.sequence;
  }else if(a.type==='RUN_WARMUP_V1'){
   exact(a,['type','sequence']);assert.equal(a.sequence,r.warmup.sequence,'stale warmup sequence');const i=warmupPlan(s);assert(i,'no eligible warmup work');
   s.money=reserveProgramPayment(s.money,i,s.money.time).state;const index=reserveAddresses(s.configHash).indexOf(i.sender);r.warmup.pending={pid:i.pid,fee:i.fee,index};r.warmup.nextAt=s.money.time+r.policy.warmup.intervalSeconds;
  }else if(a.type==='QUEUE_DEVELOPMENT_SPEND_V1'){
   exact(a,['type','sequence','recipient','value','purpose','description','reference',...managerFields(r)]);assert(r.issued&&r.development.mode==='ACTIVE','development reserve paused');managerGuard(r,a,author);assert(!r.development.pending,'one pending reserve payment');assert.equal(a.sequence,r.development.sequence+1);
   publicKey(a.recipient);assert(!reserveAddresses(s.configHash).includes(a.recipient),'external recipient required');assert(PURPOSES.includes(a.purpose));assert(typeof a.description==='string'&&a.description.trim().length>0&&a.description.length<=240&&!/[\u0000-\u001f]/.test(a.description),'public purpose description');hex(a.reference);assert(amount(a.value)>0n&&amount(a.value)<=amount(r.development.controls.transferLimit)&&amount(a.value)<=balance(s,2),'reserve payment limit');
   const notBefore=s.money.time+r.development.controls.delaySeconds,expires=notBefore+r.development.controls.executionWindowSeconds;r.development.sequence=a.sequence;r.development.pending={sequence:a.sequence,recipient:a.recipient,value:a.value,purpose:a.purpose,description:a.description,reference:a.reference,notBefore,expires};
  }else if(a.type==='CANCEL_DEVELOPMENT_SPEND_V1'){
   exact(a,['type','sequence',...managerFields(r)]);managerGuard(r,a,author);assert.equal(a.sequence,r.development.pending?.sequence,'unknown reserve payment');r.development.last={...r.development.pending,status:'CANCELLED',at:s.money.time};r.development.pending=null;
  }else{
   assert.equal(a.type,'EXECUTE_DEVELOPMENT_SPEND_V1');exact(a,['type','sequence']);const d=r.development,p=d.pending;assert(p&&p.sequence===a.sequence,'unknown reserve payment');
   if(s.money.time>p.expires){d.last={...p,status:'EXPIRED',at:s.money.time};d.pending=null;}
   else{assert.equal(d.mode,'ACTIVE','development reserve paused');assert(s.money.time>=p.notBefore,'reserve notice period');const day=Math.floor(s.money.time/86400),spent=day===d.day?amount(d.daySpent):0n;assert(amount(p.value)<=amount(d.controls.transferLimit)&&spent+amount(p.value)<=amount(d.controls.dailyLimit),'reserve operational limit');
    const id=hash({domain:RESERVES+'/DEVELOPMENT_PAYMENT',configHash:s.configHash,sequence:p.sequence});assert(!s.money.outputs[id]);s.money.outputs={...s.money.outputs};writeBalance(s,2,balance(s,2)-amount(p.value));s.money.outputs[id]={owner:p.recipient,value:p.value,unlock:0};d.spent=String(amount(d.spent)+amount(p.value));d.day=day;d.daySpent=String(spent+amount(p.value));d.last={...p,status:'PAID',at:s.money.time};d.pending=null;
   }
  }
  r.history=hash({previous:r.history,action:a,height:s.height});
 }
 auditNetworkReserves(s);audit(s.money);return s;
}
export function recordReserveSettlement(base,before){
 const p=base.networkReserves?.warmup.pending;if(!p)return base;const q=base.money.requests[p.pid];if(!q||q.status===before.requests[p.pid]?.status||q.status==='RESERVED')return base;
 assert(['SETTLED','EXPIRED'].includes(q.status));const s={...base,networkReserves:structuredClone(base.networkReserves),money:{...base.money,outputs:{...base.money.outputs}}},w=s.networkReserves.warmup,fee=q.status==='SETTLED'?amount(q.intent.fee):amount(q.intent.abortFee),day=Math.floor(s.money.time/86400);
 w.spentFees=String(amount(w.spentFees)+fee);w.dayFees=String((day===w.day?amount(w.dayFees):0n)+fee);w.day=day;w.sequence++;w.nextWallet=1-p.index;w.pending=null;w.last={pid:p.pid,status:q.status,fee:String(fee),at:s.money.time};if(q.status==='SETTLED')w.settled++;else w.expired++;
 consolidateWarmup(s);s.networkReserves.history=hash({previous:s.networkReserves.history,result:w.last});auditNetworkReserves(s);return s;
}
export function auditNetworkReserves(s){
 const r=s.networkReserves;if(!r)return;assert(!s.launchFund,'mutually exclusive launch versions');exact(r,['policy','prepared','issued','issuedAt','warmup','development','history']);validateReservePolicy(r.policy);hex(r.prepared);hex(r.history);integer(r.issuedAt);
 const w=r.warmup,d=r.development;exact(w,['mode','modeSequence','sequence','spentFees','day','dayFees','nextAt','nextWallet','pending','settled','expired','last']);exact(d,['mode','modeSequence','controls','sequence','spent','day','daySpent','pending','last',...(r.policy.development.recovery?['access']:[])]);validateDevelopmentControls(d.controls,unitScale(s));auditRecovery(r);
 for(const f of[w,d]){assert(['PAUSED','ACTIVE'].includes(f.mode));integer(f.modeSequence);integer(f.sequence);integer(f.day);}for(const n of['nextAt','settled','expired'])integer(w[n]);assert([0,1].includes(w.nextWallet));assert.equal(w.sequence,w.settled+w.expired);
 assert(amount(w.spentFees)<=amount(WARMUP_ALLOCATION));assert(amount(w.dayFees)<=amount(r.policy.warmup.dailyFeeBudget));assert(amount(d.spent)<=amount(DEVELOPMENT_ALLOCATION));assert(amount(d.daySpent)<=amount(d.spent));
 const addresses=reserveAddresses(s.configHash);let g=0n,dev=0n;for(const [id,o]of Object.entries(s.money.outputs)){const index=addresses.indexOf(o.owner);if(index<0)continue;assert.equal(id,outputId(s,index),'canonical program balance');assert.equal(o.unlock,0);if(index===2)dev+=amount(o.value);else g+=amount(o.value);}
 if(w.pending){exact(w.pending,['pid','fee','index']);hex(w.pending.pid);assert([0,1].includes(w.pending.index));const q=s.money.requests[w.pending.pid];assert(q?.status==='RESERVED'&&q.intent.sender===addresses[w.pending.index]);assert.equal(w.pending.fee,q.intent.fee);g+=amount(q.escrow);}
 const cal=s.rewards?.coefficients.calendar??s.authority?.nodeRewards?.coefficients.calendar;
 assert(amount(s.money.supply)+networkReserved(s)+(cal?amount(cal.budget)-amount(s.rewards?.minted??'0'):0n)<=(s.economicPreparation?tokenCap(s):DUBYT_SUPPLY_CAP*unitScale(s)),'reserves and calendar exceed supply cap');
 if(r.issued){hex(r.issued);assert(r.issuedAt>0);assert.equal(g+amount(w.spentFees),amount(WARMUP_ALLOCATION),'warmup conservation');assert.equal(dev+amount(d.spent),amount(DEVELOPMENT_ALLOCATION),'development conservation');}
 else{assert.equal(g+dev,0n);assert.equal(w.spentFees,'0');assert.equal(d.spent,'0');assert(!w.pending&&!d.pending);assert.equal(w.mode,'PAUSED');assert.equal(d.mode,'PAUSED');}
 if(d.pending){const p=d.pending;exact(p,['sequence','recipient','value','purpose','description','reference','notBefore','expires']);assert.equal(p.sequence,d.sequence);publicKey(p.recipient);hex(p.reference);assert(PURPOSES.includes(p.purpose));assert(amount(p.value)>0n&&amount(p.value)<=dev);integer(p.notBefore,1);integer(p.expires,p.notBefore+1);}
}
export function reserveSummary(s){
 const r=s.networkReserves;if(!r)return null;return {name:DEVELOPMENT_NAME,manager:developmentManager(r),managerRole:'founder',issued:Boolean(r.issued),addresses:reserveAddresses(s.configHash),warmup:{allocation:WARMUP_ALLOCATION,spent:r.warmup.spentFees,remaining:String(amount(WARMUP_ALLOCATION)-amount(r.warmup.spentFees)),expiresAt:null,mode:r.warmup.mode,pending:r.warmup.pending},development:{allocation:DEVELOPMENT_ALLOCATION,spent:r.development.spent,remaining:String(amount(DEVELOPMENT_ALLOCATION)-amount(r.development.spent)),mode:r.development.mode,controls:r.development.controls,pending:r.development.pending,last:r.development.last,...(r.development.access?{access:r.development.access}:{})},guaranteedRedemption:false,externalAssetBackingVerified:false};
}
