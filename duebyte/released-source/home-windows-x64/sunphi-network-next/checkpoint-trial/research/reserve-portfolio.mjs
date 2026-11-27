import assert from 'node:assert/strict';
import {exact,hash,hex} from '../crypto.mjs';
import {amount} from '../payment-model.mjs';
import {applySeries,assertCustody,validateSeries,verifySeriesFunding} from './backed-series.mjs';
import {applyLoan,auditLoan,checkLoanTerms,verifyLoanOffer} from './reserve-test-loan.mjs';

const emptyLedger=()=>({drawn:'0',repaid:'0',riskHeld:'0'});
export function programmes(reserve,kind){
 const extra=reserve?.portfolio?.[kind==='series'?'series':'loans']??[];
 return [reserve?.[kind],...extra].filter(Boolean);
}
export function validatePortfolio(p){
 const r=p.reserve,v=r.portfolio;
 exact(v,['series','loans','riskBudget']);
 assert(p.isolated&&Array.isArray(v.series)&&Array.isArray(v.loans)&&v.series.length+v.loans.length<=30);
 assert(r.series||!v.series.length);assert(r.credit||!v.loans.length);amount(v.riskBudget);
 const ids=new Set(),vaults=new Set([r.externalWallet,r.escrow,r.feeWallet].filter(Boolean));
 for(const kind of ['series','credit'])for(const term of programmes(r,kind)){
  if(kind==='series'){
   validateSeries(term);assert(term.settlement);assert(![p.provider,r.signer,...p.observers].includes(term.contributor));
  }else{
   assert(r.settlement&&r.armAtLock);checkLoanTerms(term,r.settlement);
   assert(term.maturityRecovery&&term.externalOwner!==term.vault&&!vaults.has(term.externalOwner));
   assert(![r.signer,p.provider,...p.observers].includes(term.borrower));
  }
  assert(!ids.has(term.id)&&!vaults.has(term.vault),'Programme IDs and custody accounts must be distinct.');
  ids.add(term.id);vaults.add(term.vault);
 }
 for(const t of programmes(r,'credit'))assert(!vaults.has(t.externalOwner)&&amount(t.risk)<=amount(v.riskBudget));
}
export function selectProgramme(p,kind,id){
 const term=programmes(p.reserve,kind).find(t=>t.id===id);assert(term,'Unknown reserve programme.');
 return {...p,reserve:{...p.reserve,[kind]:term}};
}

// The original verified state owns the money ledger. Instrument views share
// that ledger, but keep the claims, settlement notices and loan terms separate.
export function programmeView(s,p,kind,id){
 const entry=s.exchangeBook?.positions?.[id]??{};
 const scoped={...s,backedSeries:entry.series,testLoan:entry.loan,
  exchangeBook:{...s.exchangeBook,seriesFundingReceipt:entry.funding,loanOffer:entry.offer}};
 const cal=s.rewards?.calendarService;
 if(kind==='credit'&&cal?.reserve?.credit){
  const total=cal.reserve.credit,own=entry.ledger??emptyLedger();
  scoped.rewards={...s.rewards,calendarService:{...cal,reserve:{...cal.reserve,credit:{...own}}}};
  const positions=Object.entries(s.exchangeBook?.positions??{});
  scoped.portfolioExposure={riskHeld:total.riskHeld,capitalUsed:total.capitalUsed,riskBudget:p.reserve.portfolio.riskBudget,
   otherDebt:String(positions.reduce((n,[key,e])=>n+(key!==id&&!e.loan?.recovery?BigInt(e.loan?.debt??0):0n),0n)),
   borrowers:programmes(p.reserve,'credit').map(t=>t.borrower)};
 }
 return scoped;
}
function totals(positions,budget){
 let drawn=0n,repaid=0n,risk=0n,used=0n,waived=0n;
 for(const e of Object.values(positions))if(e.ledger){
  drawn+=amount(e.ledger.drawn);repaid+=amount(e.ledger.repaid);risk+=amount(e.ledger.riskHeld);
  used+=amount(e.loan?.loss?.principal??'0');waived+=amount(e.loan?.loss?.interest??'0');
 }
 const funded=drawn?amount(budget):0n;
 assert(used+risk<=funded,'Loss capital exhausted.');
 return {drawn:String(drawn),repaid:String(repaid),riskHeld:String(risk),capitalFunded:String(funded),capitalAvailable:String(funded-risk-used),capitalUsed:String(used),interestWaived:String(waived)};
}
export function auditPortfolio(s,c){
 const p=c.exchangeLab.policy,positions=s.exchangeBook?.positions??{};
 assert(!s.backedSeries&&!s.testLoan);
 const ledger=s.rewards?.calendarService?.reserve?.credit;
 for(const [id,e] of Object.entries(positions)){
  const kind=programmes(p.reserve,'series').some(t=>t.id===id)?'series':'credit';
  const policy=selectProgramme(p,kind,id),view=programmeView(s,p,kind,id);
  if(kind==='series'){if(e.series)assertCustody(view,policy.reserve.series,e.series);}
  else auditLoan(view,{...c,exchangeLab:{...c.exchangeLab,policy}});
 }
 const sum=totals(positions,p.reserve.portfolio.riskBudget);
 if(ledger)assert.deepEqual(ledger,sum);else assert.equal(sum.drawn,'0');
 assert(amount(sum.riskHeld)+amount(sum.capitalUsed)<=amount(p.reserve.portfolio.riskBudget),'Loss capital exhausted.');
}
export function applyProgramme(s,a,author,c){
 const p=c.exchangeLab.policy,cmd=a.command,kind=cmd.type.startsWith('SERIES_')?'series':'credit';
 hex(a.programme);const id=a.programme,policy=selectProgramme(p,kind,id);
 const config={...c,exchangeLab:{...c.exchangeLab,policy}};
 const book=s.exchangeBook,positions=book.positions??={},entry=positions[id]??={};
 const view=programmeView(s,p,kind,id),ev=cmd.evidence??cmd.packet?.evidence;
 // Receipt identities are global within an asset ledger, including across loans.
 let event,allocation;
 if(ev){
  const {observedAt,...fact}=ev.body;event=hash([fact.genesis,fact.transaction,fact.logIndex]);
  allocation=hash({id,fact});const prior=book.programmeEvents?.[event];
  assert(!prior||prior===allocation,'Settlement event already allocated.');
  const alreadyApplied=(cmd.type==='SERIES_OPEN'&&entry.series)||(cmd.type==='SERIES_PAID'&&entry.series?.redemptions[cmd.id]?.paid)
   ||(cmd.type==='SERIES_FREEZE'&&entry.series?.frozen)||(cmd.type==='LOAN_DRAW'&&entry.loan)
   ||(kind==='credit'&&entry.loan?.release);
  if(alreadyApplied)assert.equal(prior,allocation,'A completed operation cannot allocate another event.');
 }
 if(cmd.type==='SERIES_FUNDING_NOTICE'){
  exact(cmd,['type','evidence']);assert(!entry.series&&p.observers.includes(author)&&!a.inputs.length);
  verifySeriesFunding(policy,s,ev);entry.funding=structuredClone(ev);
 }else if(cmd.type==='LOAN_PUBLISH_OFFER'){
  exact(cmd,['type','packet']);assert(author===p.reserve.signer&&!a.inputs.length&&!entry.loan);
  verifyLoanOffer(cmd.packet,policy,s);entry.offer=structuredClone(cmd.packet);
 }else if(kind==='series'){
  applySeries(view,a,author,config);entry.series=view.backedSeries;if(entry.series)delete entry.funding;
 }else{
  applyLoan(view,a,author,config);entry.loan=view.testLoan;entry.ledger=view.rewards.calendarService.reserve.credit;
  s.rewards.calendarService.heldMicro=view.rewards.calendarService.heldMicro;
  s.rewards.calendarService.reserve.credit=totals(positions,p.reserve.portfolio.riskBudget);
  if(entry.loan)delete entry.offer;
 }
 if(event)(book.programmeEvents??={})[event]=allocation;
 auditPortfolio(s,c);return s;
}
