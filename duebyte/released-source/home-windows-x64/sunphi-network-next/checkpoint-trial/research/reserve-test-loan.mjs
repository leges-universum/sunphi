import assert from 'node:assert/strict';
import {hash,hex,exact,publicKey,integer,verify} from '../crypto.mjs';
import {amount} from '../payment-model.mjs';
import {spendPolicy} from '../spend-protection.mjs';
import {reserveStatement} from './network-reserve.mjs';
import {checkEvidence} from './backed-series.mjs';
import {qualifyCredit} from './secured-credit-qualification.mjs';
import {allocateAsk} from './reserve-limit-asks.mjs';
import {reserveAsset,settlementAddress} from './settlement-asset.mjs';
export const LOAN='DUEBYTE_ISOLATED_FIXED_LOAN_V1';
export function verifyLoanOffer(packet,p,s){
 exact(packet,['offer','signature','evidence']);
 const {offer,signature,evidence}=packet,t=p.reserve.credit,a=reserveAsset(p);
 exact(offer,['domain','configHash','loan','termsHash','until']);
 assert.equal(offer.domain,LOAN+'/OFFER');assert.equal(offer.configHash,s.configHash);assert.equal(offer.loan,t.id);assert.equal(offer.termsHash,hash(t));
 integer(offer.until,s.money.time);assert(offer.until<=s.money.time+300&&verify(offer,signature,p.reserve.signer),'Invalid or expired fund offer.');
 const cash=evidence.body.cash;assert(amount(cash)>0n);
 checkEvidence(evidence,{loan:t.id,vault:t.vault,codeHash:t.codeHash,genesis:a.genesis,token:a.assetId,owner:t.externalOwner,event:'ACCEPTED',cash},p,s,LOAN);
 return cash;
}
export function checkLoanTerms(t,asset){
 exact(t,['id','vault','codeHash','borrower','externalOwner','principal','interest','risk','duration','priceShockBps','cashShockBps','executionCost',...(t.maturityRecovery===true?['maturityRecovery']:[])]);
 hex(t.id);hex(t.codeHash);publicKey(t.borrower);for(const addr of [t.vault,t.externalOwner])settlementAddress(addr,asset?.addressFormat??'hex20');
 assert(amount(t.principal)>0n&&amount(t.risk)>=amount(t.principal));amount(t.interest);amount(t.executionCost);
 integer(t.duration,3600);assert(t.duration<=30*86400);integer(t.priceShockBps);integer(t.cashShockBps);assert(t.cashShockBps<=10000&&t.priceShockBps<=100000);
}
export function loanAdmission(s,p,cash,observedAt,signers){
 const t=p.reserve.credit,now=s.money.time,risk=amount(t.risk),exposure=s.portfolioExposure;
 let free=amount(reserveStatement(s.rewards.calendarService).surplusMicro);
 if(exposure){
  const capital=amount(exposure.riskBudget)-amount(exposure.capitalUsed);
  if(amount(exposure.capitalUsed)+amount(exposure.riskHeld)+risk>amount(exposure.riskBudget))return {available:false,reason:'Portfolio loss capital is fully allocated.'};
  // At the first draw the full budget is endowed from available treasury.
  // On later draws the unconsumed amount remains in the loss account.
  if(free<capital)return {available:false,reason:'Treasury cannot fund the loss account.'};
  free=free-capital+risk;
 }
 const asks=Object.entries(s.exchangeBook?.asks??{}).map(([id,o])=>({id,maker:o.maker,closed:o.closed,expires:o.terms.expires,price:o.terms.price,remaining:o.remaining}));
 const excludedMakers=[...(exposure?.borrowers??[t.borrower]),p.reserve.signer];
 if(exposure){
  const live=asks.filter(o=>!o.closed&&o.expires>now&&!excludedMakers.includes(o.maker)).sort((a,b)=>BigInt(a.price)===BigInt(b.price)?a.id.localeCompare(b.id):BigInt(a.price)<BigInt(b.price)?-1:1);
  let reserved=amount(exposure.otherDebt);
  for(const o of live){const size=amount(o.remaining),used=size<reserved?size:reserved;o.remaining=String(size-used);reserved-=used;}
 }
 return qualifyCredit({principal:t.principal,interest:t.interest,inventory:String(free>=risk?free-risk:0n),allocatedRisk:String(free<risk?free:risk),riskRequired:t.risk,collateral:cash,collateralShockBps:t.cashShockBps,executionCost:t.executionCost,now,maxAge:300,distinctReaders:signers,market:{asks,excludedMakers,priceShockBps:t.priceShockBps,feeBps:p.reserve.feeBps,observedAt}});
}
export function auditLoan(s,c){
 const ledger=s.rewards?.calendarService?.reserve?.credit,loan=s.testLoan;
 if(!ledger){assert(!loan);return;}
 assert(c.trialOnly&&c.exchangeLab?.policy.reserve?.credit);exact(ledger,['drawn','repaid','riskHeld']);
 const t=c.exchangeLab.policy.reserve.credit;
 if(loan?.cancelled){
  hex(loan.cancelled);if(loan.release){hex(loan.release);assert(amount(loan.cash)>0n);}
  assert.deepEqual(ledger,{drawn:'0',repaid:'0',riskHeld:'0'});
  return;
 }
 if(!loan){assert.deepEqual(ledger,{drawn:'0',repaid:'0',riskHeld:'0'});return;}
 const loss=loan.loss;
 if(loss){
  assert(c.exchangeLab.policy.reserve.portfolio&&loan.release&&loan.release===loss.transaction);
  const duePrincipal=amount(t.principal)>amount(ledger.repaid)?amount(t.principal)-amount(ledger.repaid):0n;
  assert.equal(amount(loss.principal),duePrincipal);assert(duePrincipal<=amount(t.risk)&&amount(loss.interest)<=amount(t.interest));
 }
 assert.equal(ledger.drawn,t.principal);assert.equal(amount(loan.debt)+amount(ledger.repaid)+amount(loss?.principal??'0')+amount(loss?.interest??'0'),amount(t.principal)+amount(t.interest));
 assert.equal(ledger.riskHeld,loan.release?'0':t.risk);
 if(loan.release)assert.equal(loan.debt,'0');
 if(loan.recovery){
  const rec=loan.recovery;
  assert(t.maturityRecovery&&amount(rec.cost)<=amount(loan.recoveryCap));
  const output=s.money.outputs[rec.hold];
  if(loan.release)assert(!output);
  else assert.deepEqual(output,{owner:rec.maker,value:rec.units??loan.debt,unlock:Number.MAX_SAFE_INTEGER});
 }
}
export function applyLoan(s,a,author,c){
 const p=c.exchangeLab.policy,t=p.reserve?.credit,cal=s.rewards?.calendarService;assert(t&&cal?.reserve.credit);
 const ledger=cal.reserve.credit,loan=s.testLoan,cmd=a.command,principal=amount(t.principal);
 const key=role=>hash({domain:LOAN,configHash:s.configHash,id:t.id,role});
 const route=reserveAsset(p);
 const expected={loan:t.id,vault:t.vault,codeHash:t.codeHash,genesis:route.genesis,token:route.assetId,owner:t.externalOwner};
 if(cmd.type==='LOAN_BOOK_LOSS'){
  exact(cmd,['type','evidence']);assert(p.reserve.portfolio&&author===p.reserve.signer&&!a.inputs.length);
  assert(loan&&!loan.recovery&&!loan.cancelled&&s.money.time>loan.dueAt,'A matured outstanding loan is required.');
  if(loan.loss){assert.equal(hash(cmd.evidence.body),loan.loss.receipt);return s;}
  assert(!loan.release&&amount(loan.debt)>0n);
  // Principal-first payments determine the realized capital shortfall. Waived
  // interest was never received and must never consume fund cash.
  const repaid=amount(ledger.repaid),unpaid=principal>repaid?principal-repaid:0n;
  const interest=amount(loan.debt)-unpaid;
  assert(unpaid<=amount(ledger.riskHeld)&&unpaid<=amount(cal.heldMicro));
  checkEvidence(cmd.evidence,{...expected,event:'FINAL_LOSS',offer:loan.offer,pledged:loan.cash,remainingCash:'0',remainingClaim:'0',debt:loan.debt,principalLoss:String(unpaid),interestWaived:String(interest)},p,s,LOAN);
  loan.loss={principal:String(unpaid),interest:String(interest),transaction:cmd.evidence.body.transaction,receipt:hash(cmd.evidence.body),height:s.height};
  loan.debt='0';loan.release=loan.loss.transaction;ledger.riskHeld='0';
  // The draw already reduced custody. Reclassify the allocated capital to
  // cover that realized debit; a second cash debit would count the loss twice.
  auditLoan(s,c);return s;
 }
 if(cmd.type==='LOAN_START_RECOVERY'){
  const partial=Object.hasOwn(cmd,'units');
  exact(cmd,['type','loan','ask','recipient',...(partial?['units','evidence']:[])]);assert(t.maturityRecovery&&!a.inputs.length&&cmd.loan===t.id);
  assert(loan&&loan.dueAt<s.money.time,'The loan is not overdue.');
  if(loan.recovery){assert.equal(loan.recovery.instruction,hash(cmd));assert.equal(loan.recovery.maker,author);return s;}
  assert(amount(loan.debt)>0n&&!loan.release);
  const ask=s.exchangeBook?.asks?.[cmd.ask];assert(ask?.maker===author&&author===p.provider);
  settlementAddress(cmd.recipient,route.addressFormat);assert(![t.vault,t.externalOwner].includes(cmd.recipient));
  const debt=amount(loan.debt),units=partial?amount(cmd.units):debt;
  if(partial)assert(p.reserve.portfolio&&units>0n&&units<debt);
  const price=amount(ask.terms.price),cost=(units*price+999999n)/1000000n;
  if(partial)checkEvidence(cmd.evidence,{...expected,event:'FINAL_SALE_PROCEEDS',offer:loan.offer,pledged:loan.cash,cash:String(cost),remainingClaim:'0',ask:cmd.ask,units:cmd.units,payee:cmd.recipient},p,s,LOAN);
  const originalDebt=principal+amount(t.interest),cap=(amount(loan.recoveryCap)*units+originalDebt-1n)/originalDebt;
  assert(cost<=cap&&cost<=amount(loan.cash),'Recovery price exceeds the signed limit or pledged cash.');
  const quote={direction:'BUY_DUBYT',asset:route.symbol,provider:author,dubytAtomic:String(units),externalAtomic:String(cost)};
  allocateAsk(s,s.exchangeBook,quote,cmd.ask);
  const hold=key('repurchase escrow'),instruction=hash(cmd);
  s.money.outputs[hold]={owner:author,value:String(units),unlock:Number.MAX_SAFE_INTEGER};
  loan.recovery={hold,maker:author,cost:String(cost),...(partial?{units:cmd.units}:{}),recipient:cmd.recipient,instruction,certificate:hash({domain:LOAN+'/RECOVERY',configHash:s.configHash,instruction,debt:loan.debt,cost:String(cost)})};
  auditLoan(s,c);return s;
 }
 if(loan?.recovery&&cmd.type!=='LOAN_DRAW'){
  assert.equal(cmd.type,'LOAN_SETTLE_RECOVERY','Recovery settlement is in progress.');
  exact(cmd,['type','evidence']);assert(!a.inputs.length);
  const rec=loan.recovery,b=cmd.evidence.body;
  if(loan.release){assert.equal(loan.release,b.transaction);return s;}
  if(rec.units){
   assert(author===p.reserve.signer&&p.reserve.portfolio&&b.cash===rec.cost);
   assert(amount(b.cash)<=amount(loan.cash),'Final recovery must match the exhausted collateral.');
  }else assert(amount(b.cash)>=amount(loan.cash));
  const surplus=String(amount(b.cash)-amount(rec.cost));
  const closing=rec.units?{pledged:loan.cash,remainingCash:'0',remainingClaim:'0',units:rec.units}:{};
  checkEvidence(cmd.evidence,{...expected,event:rec.units?'FINAL_RECOVERY':'RECOVERED',repayment:rec.certificate,cash:b.cash,paid:rec.cost,payee:rec.recipient,surplus,...closing},p,s,LOAN);
  auditLoan(s,c);delete s.money.outputs[rec.hold];
  const recovered=amount(rec.units??loan.debt);
  ledger.repaid=String(amount(ledger.repaid)+recovered);cal.heldMicro=String(amount(cal.heldMicro)+recovered);s.money.fees=String(amount(s.money.fees)+recovered);
  if(rec.units){
   const short=principal>amount(ledger.repaid)?principal-amount(ledger.repaid):0n;
   loan.loss={principal:String(short),interest:String(amount(loan.debt)-recovered-short),receipt:hash(b),transaction:b.transaction,height:s.height};
  }
  loan.debt='0';loan.release=b.transaction;loan.cash=b.cash;rec.surplus=surplus;ledger.riskHeld='0';
  auditLoan(s,c);return s;
 }
 if(cmd.type==='LOAN_CANCEL_UNUSED'){
  exact(cmd,['type','loan']);assert.equal(cmd.loan,t.id);assert.equal(author,t.borrower);assert(!a.inputs.length);
  if(loan?.cancelled)return s;
  assert(!loan,'Principal already drawn.');
  s.testLoan={cancelled:key('unused pledge return'),cash:null,release:null};
  auditLoan(s,c);return s;
 }
 if(loan?.cancelled){
  assert.equal(cmd.type,'LOAN_UNUSED_RETURNED','This loan request was cancelled.');
  exact(cmd,['type','evidence']);assert(!a.inputs.length);
  if(loan.release){assert.equal(loan.release,cmd.evidence.body.transaction);return s;}
  const cash=cmd.evidence.body.cash;assert(amount(cash)>0n);
  checkEvidence(cmd.evidence,{...expected,event:'UNUSEDRETURNED',cash,repayment:loan.cancelled},p,s,LOAN);
  loan.cash=cash;loan.release=cmd.evidence.body.transaction;
  auditLoan(s,c);return s;
 }
 if(cmd.type==='LOAN_DRAW'||cmd.type==='LOAN_TOP_UP'){
  exact(cmd,cmd.type==='LOAN_DRAW'?['type','offer','signature','evidence',...(t.maturityRecovery?['maxRecoveryCash']:[])]:['type','evidence']);
  assert(author===t.borrower||(cmd.type==='LOAN_TOP_UP'&&p.observers.includes(author)));assert.equal(a.inputs.length,0);
  const b=cmd.evidence.body,cash=b.cash;amount(cash);
  if(cmd.type==='LOAN_DRAW'){
   const g=cmd.offer;exact(g,['domain','configHash','loan','termsHash','until']);
   assert.equal(g.domain,LOAN+'/OFFER');assert.equal(g.configHash,s.configHash);assert.equal(g.loan,t.id);assert.equal(g.termsHash,hash(t));assert(verify(g,cmd.signature,p.reserve.signer));
   if(loan){assert.equal(loan.offer,hash(g));if(t.maturityRecovery)assert.equal(cmd.maxRecoveryCash,loan.recoveryCap);return s;}
   integer(g.until,s.money.time);assert(g.until<=s.money.time+300);
  }else{assert(loan&&!loan.release);if(loan.pledgeReceipt===hash(b))return s;assert(amount(cash)>amount(loan.cash),'Top-up must increase the pledged balance.');}
  checkEvidence(cmd.evidence,{...expected,event:cmd.type==='LOAN_DRAW'?'ACCEPTED':'PLEDGED',cash},p,s,LOAN);
  if(cmd.type==='LOAN_TOP_UP'){loan.cash=cash;loan.pledgeReceipt=hash(b);}
  else{
   const decision=loanAdmission(s,p,cash,b.observedAt,cmd.evidence.signatures.map(v=>v.observer));assert(decision.available,decision.reason);
   if(t.maturityRecovery)assert.equal(cmd.maxRecoveryCash,decision.quote.cost,'Recovery limit changed. Review the offer again.');
   ledger.drawn=t.principal;ledger.riskHeld=t.risk;cal.heldMicro=String(amount(cal.heldMicro)-principal);s.money.fees=String(amount(s.money.fees)-principal);
   s.money.outputs[key('draw')]={owner:t.borrower,value:t.principal,unlock:0};
   s.testLoan={offer:hash(cmd.offer),cash,debt:decision.debt,pledgeReceipt:hash(b),dueAt:s.money.time+t.duration,repayments:{},release:null};
   if(t.maturityRecovery)s.testLoan.recoveryCap=String(decision.quote.cost);
  }
 }else if(cmd.type==='LOAN_REPAY'){
  exact(cmd,['type','nonce','value']);hex(cmd.nonce);assert(loan&&author===t.borrower);
  if(loan.repayments[cmd.nonce]){assert.equal(loan.repayments[cmd.nonce],cmd.value);return s;}
  const policy=spendPolicy(s,author);assert(!policy?.enabled&&!policy?.pending);const value=amount(cmd.value);assert(value>0n&&value<=amount(loan.debt));
  assert(Object.keys(loan.repayments).length<63||value===amount(loan.debt),'Repayment capacity reserved for payoff.');
  let sum=0n;for(const id of a.inputs){const o=s.money.outputs[id];assert(o&&o.owner===author&&o.unlock<=s.money.time);sum+=amount(o.value);}
  assert(sum>=value);for(const id of a.inputs)delete s.money.outputs[id];
  if(sum>value)s.money.outputs[key(cmd.nonce)]={owner:author,value:String(sum-value),unlock:0};
  ledger.repaid=String(amount(ledger.repaid)+value);cal.heldMicro=String(amount(cal.heldMicro)+value);s.money.fees=String(amount(s.money.fees)+value);
  loan.repayments[cmd.nonce]=cmd.value;loan.debt=String(amount(loan.debt)-value);if(loan.debt==='0')loan.payoff=hash({domain:LOAN,configHash:s.configHash,loan:t.id,payment:cmd});
 }else{
  exact(cmd,['type','evidence']);assert.equal(cmd.type,'LOAN_RETURNED');assert(loan&&loan.debt==='0'&&!a.inputs.length);
  if(loan.release){assert.equal(loan.release,cmd.evidence.body.transaction);return s;}
  checkEvidence(cmd.evidence,{...expected,event:'RETURNED',cash:loan.cash,repayment:loan.payoff},p,s,LOAN);loan.release=cmd.evidence.body.transaction;ledger.riskHeld='0';
 }
 auditLoan(s,c);return s;
}
