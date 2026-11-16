// One explicitly authorised launch allocation; never a genesis reset or an
// automatic refill. Program-wallet spending remains bounded at consensus.
import assert from 'node:assert/strict';
import {hash,exact,integer,hex,publicKey,verify} from './crypto.mjs';
import {amount,policyId} from './payment-model.mjs';
import {validatorQuorum} from './authority.mjs';
import {DUBYT_SUPPLY_CAP} from './emission-calendar.mjs';
export const LAUNCH='DUEBYTE_LAUNCH_FUND_V1';
export const LAUNCH_ACTIONS=['PREPARE_LAUNCH_FUND_V1','ISSUE_LAUNCH_FUND_V1','SET_LAUNCH_MODE_V1'];
export function validateLaunchPolicy(p){
 exact(p,['id','wallets','allocation','feeBudget','dailyFeeBudget','maxPayment','intervalSeconds','durationSeconds','paymentPolicy']);
 hex(p.id);assert(Array.isArray(p.wallets)&&p.wallets.length===2);p.wallets.forEach(publicKey);assert.notEqual(...p.wallets);
 assert(Array.isArray(p.allocation)&&p.allocation.length===2);p.allocation.forEach(v=>assert(amount(v)>0n));
 const total=p.allocation.reduce((n,v)=>n+amount(v),0n);assert(total<=DUBYT_SUPPLY_CAP);
 assert(amount(p.feeBudget)>0n&&amount(p.feeBudget)<=total);assert(amount(p.dailyFeeBudget)>0n&&amount(p.dailyFeeBudget)<=amount(p.feeBudget));assert(amount(p.maxPayment)>0n);
 integer(p.intervalSeconds,1);assert(p.intervalSeconds<=86400);integer(p.durationSeconds,60);assert(p.durationSeconds<=30*366*86400);
 assert.equal(p.paymentPolicy,policyId,'launch fee terms differ from qualified payment policy');return total;
}
export const launchConsent=(configHash,policy)=>({domain:LAUNCH+'/CUSTODY',configHash,policyHash:hash(policy)});
export const launchReserved=s=>s.launchFund&&!s.launchFund.issued?validateLaunchPolicy(s.launchFund.policy):0n;
function certificate(s,a,c,fields){
 exact(a,['type','certificate',...(a.type==='PREPARE_LAUNCH_FUND_V1'?['consents']:[])]);
 const b=a.certificate.body;exact(a.certificate,['body','approvals']);exact(b,['domain','network','configHash','generation','notBefore','expires',...fields]);
 assert.equal(b.domain,LAUNCH+'/'+a.type);assert.equal(b.network,c.chainId);assert.equal(b.configHash,hash(c));assert.equal(b.generation,s.authority.generation);
 integer(b.notBefore,1);integer(b.expires,b.notBefore);assert(b.expires-b.notBefore<=100&&s.height>=b.notBefore&&s.height<=b.expires,'launch certificate inclusion window');
 validatorQuorum(b,a.certificate.approvals,s.authority.validators);return b;
}
export function applyLaunchAction(base,a,c){
 assert(base.authority);const s=structuredClone(base);
 if(a.type==='PREPARE_LAUNCH_FUND_V1'){
  const b=certificate(s,a,c,['policy']),total=validateLaunchPolicy(b.policy);assert(!s.launchFund&&!s.networkReserves,'one launch fund per network');
  assert(!s.authority.nodeRewards&&!s.rewards,'reserve launch allocation before scheduling the reward calendar');
  assert(amount(s.money.supply)+total<=DUBYT_SUPPLY_CAP,'launch supply cap');
  assert(Array.isArray(a.consents)&&a.consents.length===2);
  for(let i=0;i<2;i++){const key=b.policy.wallets[i];assert(verify(launchConsent(s.configHash,b.policy),a.consents[i],key),'launch wallet possession');
   assert(!Object.values(s.money.outputs).some(o=>o.owner===key),'use fresh program wallets');
   assert(!Object.values(s.money.requests).some(r=>r.intent.sender===key||r.intent.recipient===key),'program wallet already used');}
  s.launchFund={policy:structuredClone(b.policy),prepared:hash(a.certificate),issued:null,mode:'PREPARED',sequence:0,issuedSupply:s.money.supply,issuedAt:0,endTime:0,spentFees:'0',settled:0,failed:0,nextAt:0,day:0,dayFees:'0',pending:null,last:null,history:hash({domain:LAUNCH,policy:b.policy})};
 }else if(a.type==='ISSUE_LAUNCH_FUND_V1'){
  const b=certificate(s,a,c,['policyHash']),f=s.launchFund;assert(f&&b.policyHash===hash(f.policy),'unknown launch policy');
  if(f.issued)return base;
  assert.equal(f.mode,'PREPARED');assert(s.rewards?.coefficients.calendar,'reward accounting must be active before launch issuance');
  const total=validateLaunchPolicy(f.policy),cal=s.rewards.coefficients.calendar;
  assert(s.money.time>=cal.startTime&&s.money.time<cal.endTime,'launch outside reward calendar');
  assert(amount(s.money.supply)+total+amount(cal.budget)-amount(s.rewards.minted)<=DUBYT_SUPPLY_CAP,'reserve all remaining scheduled issuance');
  for(let i=0;i<2;i++){const id=hash({domain:LAUNCH+'/ALLOCATION',configHash:s.configHash,program:f.policy.id,wallet:f.policy.wallets[i]});assert(!s.money.outputs[id]);s.money.outputs[id]={owner:f.policy.wallets[i],value:f.policy.allocation[i],unlock:0};}
  f.issuedSupply=String(amount(s.money.supply)+total);s.money.supply=f.issuedSupply;f.issued=hash(a.certificate);f.mode='ACTIVE';f.issuedAt=s.money.time;f.endTime=Math.min(f.issuedAt+f.policy.durationSeconds,cal.endTime);f.nextAt=f.issuedAt;
 }else{
  assert.equal(a.type,'SET_LAUNCH_MODE_V1');const b=certificate(s,a,c,['policyHash','sequence','mode']),f=s.launchFund;
  assert(f?.issued&&b.policyHash===hash(f.policy));assert(['ACTIVE','PAUSED','FROZEN'].includes(b.mode));
  if(b.sequence===f.sequence){assert.equal(b.mode,f.mode);return base;}
  assert.equal(b.sequence,f.sequence+1);assert.notEqual(f.mode,'FROZEN','final freeze is irreversible');
  if(b.mode==='ACTIVE')assert(s.money.time<f.endTime&&amount(f.spentFees)<amount(f.policy.feeBudget));
  if(b.mode==='FROZEN')assert(!f.pending,'drain the pending payment before freezing');
  f.mode=b.mode;f.sequence=b.sequence;
 }
 auditLaunchFund(s);return s;
}
export function checkLaunchPayment(s,i){
 const f=s.launchFund;if(!f?.policy.wallets.includes(i.sender))return;
 if(s.money.requests[i.pid])return; // Idempotent replay still needs ordinary validation.
 assert(f.issued&&f.mode==='ACTIVE','launch program is not active');
 assert(s.money.time<f.endTime&&s.money.time>=f.nextAt,'launch schedule');
 assert(!f.pending,'one unfinished launch payment');
 assert(i.recipient===f.policy.wallets.find(k=>k!==i.sender),'launch recipient allowlist');
 assert(!i.delay&&!i.sendDelay,'ordinary immediate launch payments only');
 assert(amount(i.value)<=amount(f.policy.maxPayment),'launch payment limit');
 assert(amount(f.spentFees)+amount(i.fee)<=amount(f.policy.feeBudget),'launch fee budget');
 const day=Math.floor(s.money.time/86400),spent=day===f.day?amount(f.dayFees):0n;
 assert(spent+amount(i.fee)<=amount(f.policy.dailyFeeBudget),'launch daily fee budget');
}
export function recordLaunchPayment(base,before){
 const f=base.launchFund;if(!f)return base;let s=base;
 for(const [pid,r] of Object.entries(base.money.requests)){
  if(!f.policy.wallets.includes(r.intent.sender)||before.requests[pid]?.status===r.status)continue;
  if(s===base)s=structuredClone(base);const p=s.launchFund;
  if(r.status==='RESERVED'){
   assert(!p.pending||p.pending.pid===pid);p.pending={pid,fee:r.intent.fee};p.nextAt=s.money.time+p.policy.intervalSeconds;
  }else if(['SETTLED','EXPIRED','CANCELLED'].includes(r.status)){
   assert.equal(p.pending?.pid,pid,'launch completion without reservation');
   const fee=r.status==='SETTLED'?r.intent.fee:r.intent.abortFee,day=Math.floor(s.money.time/86400);
   p.dayFees=String((p.day===day?amount(p.dayFees):0n)+amount(fee));p.day=day;p.spentFees=String(amount(p.spentFees)+amount(fee));p.pending=null;
   if(r.status==='SETTLED')p.settled++;else p.failed++;
   p.last={pid,status:r.status,fee,terminalHeight:r.terminalHeight};p.history=hash({previous:p.history,result:p.last});
  }
 }
 auditLaunchFund(s);return s;
}
export function auditLaunchFund(s){
 const f=s.launchFund;if(!f)return;
 exact(f,['policy','prepared','issued','mode','sequence','issuedSupply','issuedAt','endTime','spentFees','settled','failed','nextAt','day','dayFees','pending','last','history']);
 const total=validateLaunchPolicy(f.policy);hex(f.prepared);hex(f.history);integer(f.sequence);integer(f.settled);integer(f.failed);integer(f.issuedAt);integer(f.endTime);integer(f.nextAt);integer(f.day);
 assert(['PREPARED','ACTIVE','PAUSED','FROZEN'].includes(f.mode));assert(amount(s.money.supply)<=DUBYT_SUPPLY_CAP);amount(f.issuedSupply);
 assert(amount(f.spentFees)<=amount(f.policy.feeBudget));assert(amount(f.dayFees)<=amount(f.policy.dailyFeeBudget));assert(amount(f.dayFees)<=amount(f.spentFees));
 if(f.issued){hex(f.issued);assert.notEqual(f.mode,'PREPARED');assert(f.issuedAt>0&&f.endTime>f.issuedAt);assert(amount(f.issuedSupply)<=amount(s.money.supply));}
 else{assert.equal(f.mode,'PREPARED');assert.equal(f.spentFees,'0');assert(!f.pending);assert(amount(s.money.supply)+total<=DUBYT_SUPPLY_CAP);}
 if(f.pending){exact(f.pending,['pid','fee']);hex(f.pending.pid);amount(f.pending.fee);const r=s.money.requests[f.pending.pid];assert(r?.status==='RESERVED'&&f.policy.wallets.includes(r.intent.sender));assert.equal(f.pending.fee,r.intent.fee);assert(amount(f.spentFees)+amount(f.pending.fee)<=amount(f.policy.feeBudget));}
 if(f.last){exact(f.last,['pid','status','fee','terminalHeight']);hex(f.last.pid);assert(['SETTLED','EXPIRED','CANCELLED'].includes(f.last.status));amount(f.last.fee);integer(f.last.terminalHeight,1);}
 if(s.rewards?.coefficients.calendar){const r=s.rewards;assert(amount(s.money.supply)+launchReserved(s)+amount(r.coefficients.calendar.budget)-amount(r.minted)<=DUBYT_SUPPLY_CAP,'launch/calendar total allocation');}
}
