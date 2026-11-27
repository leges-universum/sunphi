// Conditional exchange admission is genesis-pinned and isolated-only.
import assert from 'node:assert/strict';
import {exact,hash,hex} from '../crypto.mjs';
import {amount,MAX} from '../payment-model.mjs';
import {spendPolicy} from '../spend-protection.mjs';
import {centuryRestrictedAccounts} from '../century-funds.mjs';
import {centuryWarmupAccounts,memorialPolicy} from '../economic-policy-v3.mjs';
import {reserveAddresses} from '../network-reserves.mjs';
import {supportAccount} from '../support-accounting.mjs';
import {exchangePolicy,exchangeGenesis,applyExchange,auditExchange} from './exchange-escrow.mjs';
import {reserveStatement,RESERVE_TRIAL} from './network-reserve.mjs';
import {applyAsk,allocateAsk,auditAsks} from './reserve-limit-asks.mjs';
import {applyLoan,auditLoan,verifyLoanOffer} from './reserve-test-loan.mjs';
import {applySeries,assertCustody,verifySeriesFunding} from './backed-series.mjs';
import {applyProgramme,auditPortfolio} from './reserve-portfolio.mjs';
export const EXCHANGE_ACTION='EXECUTE_EXCHANGE_LAB_V1';
export const exchangeOutput=(configHash,id,role)=>hash({domain:EXCHANGE_ACTION,configHash,id,role});
export function checkExchangeConfig(c){
 if(!c.exchangeLab)return;
 exact(c.exchangeLab,['policy','feeMicro']);exchangePolicy(c.exchangeLab.policy);
 assert.equal(c.trialOnly,true);assert(/^duebyte-trial-exchange-lab-[a-z0-9-]+$/.test(c.chainId),'isolated exchange chain only');
 assert.equal(c.exchangeLab.policy.chain,c.chainId.replace('duebyte-trial-','duebyte-'));
 assert(amount(c.exchangeLab.feeMicro)>0n,'explicit exchange fee required');
}
const payer=q=>q.direction==='BUY_DUBYT'?q.provider:q.user;
export function auditNativeExchange(s,c){
 if(c.exchangeLab?.policy.reserve?.portfolio)auditPortfolio(s,c);else auditLoan(s,c);
 const reserve=s.rewards?.calendarService?.reserve;
 if(s.backedSeries){assert(c.trialOnly&&c.chainId===RESERVE_TRIAL&&c.exchangeLab?.policy.reserve?.series);assertCustody(s,c.exchangeLab.policy.reserve.series,s.backedSeries);}
 if(reserve){assert.equal(c.trialOnly,true);assert.equal(c.chainId,RESERVE_TRIAL);}
 if(!s.exchangeBook){if(reserve){assert.equal(reserve.marketInMicro,'0');assert.equal(reserve.marketOutMicro,'0');}return;}
 assert(c.exchangeLab,'exchange state without admission');checkExchangeConfig(c);
 const b=s.exchangeBook;auditExchange(b);assert.deepEqual(b.policy,c.exchangeLab.policy);
 if(b.asks){assert(b.policy.reserve?.armAtLock);auditAsks(s,b);}
 assert(Object.values(b.balances).every(v=>v==='0'),'undrained native exchange balance');
 let marketIn=0n,marketOut=0n;
 for(const [id,o]of Object.entries(b.orders)){
  if(b.policy.reserve&&o.quote.provider===b.policy.reserve.signer){
   const value=amount(o.quote.dubytAtomic);
   if(o.quote.direction==='BUY_DUBYT'){
    marketOut+=value;if(o.status==='REFUNDED')marketIn+=value;
   }else if(o.status==='CLAIMED')marketIn+=value;
  }
  const held=s.money.outputs[exchangeOutput(s.configHash,id,'escrow')];
  if(o.status==='LOCKED')assert.deepEqual(held,{owner:payer(o.quote),value:o.quote.dubytAtomic,unlock:Number.MAX_SAFE_INTEGER},'exchange backing');
  else assert(!held,'terminal exchange escrow retained');
 }
 assert.equal(marketIn,amount(reserve?.marketInMicro??'0'),'reserve market receipts');
 assert.equal(marketOut,amount(reserve?.marketOutMicro??'0'),'reserve exchange escrow placements');
}
export function executeNativeExchange(s,a,author,c){
 assert(c.exchangeLab,'two-way exchange admission disabled');checkExchangeConfig(c);
 const scoped=c.exchangeLab.policy.reserve?.portfolio&&/^(SERIES|LOAN)_/.test(a.command?.type);
 exact(a,['type','command','inputs',...(Object.hasOwn(a,'ask')?['ask']:[]),...(scoped?['programme']:[])]);assert.equal(a.type,EXCHANGE_ACTION);
 assert.equal(s.money.unitScale,'1000000','fractional denomination required');
 assert(Array.isArray(a.inputs)&&a.inputs.length<=8);a.inputs.forEach(hex);
 assert.deepEqual(a.inputs,[...new Set(a.inputs)].sort(),'canonical exchange inputs');
 const p=c.exchangeLab.policy,cmd=a.command;
 if(scoped){
  assert(!Object.hasOwn(a,'ask'));s.exchangeBook??=exchangeGenesis(p,{});
  return applyProgramme(s,a,author,c);
 }
 if(cmd.type==='SERIES_FUNDING_NOTICE'){
  exact(cmd,['type','evidence']);assert(p.reserve?.series?.settlement&&p.observers.includes(author)&&!a.inputs.length&&!Object.hasOwn(a,'ask')&&!s.backedSeries);
  verifySeriesFunding(p,s,cmd.evidence);
  const book=s.exchangeBook??exchangeGenesis(p,{});
  book.seriesFundingReceipt=structuredClone(cmd.evidence);s.exchangeBook=book;auditNativeExchange(s,c);return s;
 }
 if(p.reserve?.nativeOnly){assert(cmd.type.startsWith('SERIES_')&&!Object.hasOwn(a,'ask'),'This programme supports native series operations only.');return applySeries(s,a,author,c);}
 let b=structuredClone(s.exchangeBook??exchangeGenesis(p,{}));
 if(Object.hasOwn(a,'ask')){assert(p.reserve?.armAtLock&&cmd.type==='LOCK');hex(a.ask);}
 if(cmd.type==='LOAN_PUBLISH_OFFER'){
  exact(cmd,['type','packet']);assert(p.reserve?.settlement&&p.reserve.credit&&author===p.reserve.signer&&!a.inputs.length&&!s.testLoan);
  verifyLoanOffer(cmd.packet,p,s);
  b.loanOffer=structuredClone(cmd.packet);s.exchangeBook=b;auditNativeExchange(s,c);return s;
 }
 if(cmd.type.startsWith('LOAN_'))return applyLoan(s,a,author,c);
 if(cmd.type.startsWith('SERIES_'))return applySeries(s,a,author,c);
 if(['PLACE_ASK','CLOSE_ASK'].includes(cmd.type)){
  assert(p.reserve?.armAtLock,'Limit orders are disabled.');
  if(cmd.type==='PLACE_ASK'){const protection=spendPolicy(s,author);assert(!protection?.enabled&&!protection?.pending,'Protected wallet requires separate consent.');}
  applyAsk(s,b,a,author,amount(c.exchangeLab.feeMicro));s.exchangeBook=b;auditNativeExchange(s,c);return s;
 }
 const id=cmd.type==='LOCK'?hash(cmd.quote):cmd.id;hex(id);const prior=b.orders[id];
 const escrow=exchangeOutput(s.configHash,id,'escrow');
 if(cmd.type==='LOCK'){
  const owner=payer(cmd.quote);assert.equal(author,owner,'DUBYT payer signs native funding');
  assert(![...centuryRestrictedAccounts(s.configHash),...centuryWarmupAccounts(s.configHash),memorialPolicy(s.configHash).account,...Object.values(reserveAddresses(s.configHash)),supportAccount(s.configHash)].includes(owner),'programme funds cannot fund exchange');
  const protection=spendPolicy(s,owner);assert(!protection?.enabled&&!protection?.pending,'protected payer requires separate exchange consent');
  if(prior)b=applyExchange(b,cmd,s.money.time);
  else{
   assert(a.inputs.length>0);const value=amount(cmd.quote.dubytAtomic),fee=amount(c.exchangeLab.feeMicro);let total=0n;
   for(const input of a.inputs){const o=s.money.outputs[input];assert(o&&o.owner===owner,'missing or foreign exchange funding');assert(o.unlock<=s.money.time,'locked exchange funding');total+=amount(o.value);}
   const fundSale=p.reserve&&cmd.quote.provider===p.reserve.signer&&cmd.quote.direction==='BUY_DUBYT';
   if(a.ask){assert(!fundSale&&total>=fee);total+=allocateAsk(s,b,cmd.quote,a.ask);}
   if(fundSale){
    const calendar=s.rewards?.calendarService,statement=reserveStatement(calendar);
    assert(statement&&value<=amount(statement.surplusMicro),'protected payroll cannot fund an offer');
    assert(total>=fee,'fund execution fee unavailable');
    calendar.reserve.marketOutMicro=String(amount(calendar.reserve.marketOutMicro)+value);
    calendar.heldMicro=String(amount(calendar.heldMicro)-value);
    s.money.fees=String(amount(s.money.fees)-value);
    total+=value;
   }
   assert(total>=value+fee&&total<=MAX,'exchange inventory and fee unavailable');
   const change=exchangeOutput(s.configHash,id,'change');assert(!s.money.outputs[escrow]&&!s.money.outputs[change],'exchange output collision');
   b.balances[owner]=String(value);b.total=String(amount(b.total)+value);b=applyExchange(b,cmd,s.money.time);
   for(const input of a.inputs)delete s.money.outputs[input];
   s.money.outputs[escrow]={owner,value:String(value),unlock:Number.MAX_SAFE_INTEGER};
   if(total>value+fee)s.money.outputs[change]={owner,value:String(total-value-fee),unlock:0};
   s.money.fees=String(amount(s.money.fees)+fee);
  }
 }else{
  assert.equal(a.inputs.length,0);assert(prior,'unknown native exchange');
  assert([prior.quote.user,prior.quote.provider,...p.observers].includes(author),'exchange participant or observer required');
  b=applyExchange(b,cmd,s.money.time);
  for(const [owner,value]of Object.entries(b.balances))if(value!=='0'){
   const held=s.money.outputs[escrow];assert.deepEqual(held,{owner:payer(prior.quote),value,unlock:Number.MAX_SAFE_INTEGER},'exchange backing required');
   const output=exchangeOutput(s.configHash,id,'settlement');assert(!s.money.outputs[output],'exchange already settled');
   delete s.money.outputs[escrow];
   if(owner===p.reserve?.signer&&prior.quote.provider===owner){
    const calendar=s.rewards?.calendarService;assert(calendar?.reserve,'reserve custody required');
    calendar.reserve.marketInMicro=String(amount(calendar.reserve.marketInMicro)+amount(value));
    calendar.heldMicro=String(amount(calendar.heldMicro)+amount(value));
    s.money.fees=String(amount(s.money.fees)+amount(value));
   }else s.money.outputs[output]={owner,value,unlock:0};
   b.balances[owner]='0';b.total=String(amount(b.total)-amount(value));
  }
 }
 s.exchangeBook=b;auditNativeExchange(s,c);return s;
}
