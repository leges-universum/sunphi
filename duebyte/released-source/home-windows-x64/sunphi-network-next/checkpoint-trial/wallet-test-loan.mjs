import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {exact,hash,hex} from './crypto.mjs';
import {formatToken,parseToken} from './token-units.mjs';
import {envelope} from './core.mjs';
import {EXCHANGE_ACTION} from './research/exchange-native.mjs';
import {verifyLoanOffer,loanAdmission} from './research/reserve-test-loan.mjs';
import {askFundingInputs} from './research/reserve-limit-asks.mjs';
import {displaySettlement,reserveAsset} from './research/settlement-asset.mjs';
const show=n=>formatToken(n,'1000000');
function needsBroadcast(cmd,loan){
 if(cmd.type==='LOAN_CANCEL_UNUSED'||cmd.type==='LOAN_DRAW')return !loan;
 return !loan?.release&&!loan?.recovery&&!loan?.repayments?.[cmd.nonce];
}
export class WalletTestLoan{
 constructor(flow){
  this.flow=flow;this.t=flow.p.reserve.credit;this.asset=reserveAsset(flow.p);this.db=flow.wallet.db;
  this.db.exec('CREATE TABLE IF NOT EXISTS credit_test_outbox(pin TEXT NOT NULL,id TEXT NOT NULL,wire TEXT NOT NULL,PRIMARY KEY(pin,id))');
  this.db.exec('CREATE TABLE IF NOT EXISTS credit_seen_pledges(pin TEXT NOT NULL,loan TEXT NOT NULL,PRIMARY KEY(pin,loan))');
 }
 async status(){
  const {state}=await this.flow.current(),l=state.testLoan,t=this.t;
  const pending=this.db.prepare('SELECT id,wire FROM credit_test_outbox WHERE pin=?').all(this.flow.pin).filter(({wire})=>needsBroadcast(JSON.parse(wire).body.action.command,l)).map(v=>v.id);
  const packet=state.exchangeBook?.loanOffer;
  const localOffer=packet&&packet.offer.until>=state.money.time&&packet.evidence.body.observedAt>=state.money.time-300;
  const funded=!!state.rewards?.calendarService?.reserve?.credit;
  const admission=!l&&localOffer&&funded?loanAdmission(state,this.flow.p,packet.evidence.body.cash,packet.evidence.body.observedAt,packet.evidence.signatures.map(v=>v.observer)):null;
  const reason=!funded?'Credit inventory is not open.':admission&&!admission.available?admission.reason:null;
  const pledged=!!packet||!!this.db.prepare('SELECT 1 FROM credit_seen_pledges WHERE pin=? AND loan=?').get(this.flow.pin,t.id);
  const cashText=n=>displaySettlement(n,this.asset);
  const recovery=l?.recovery?{paid:cashText(l.recovery.cost),surplus:l.release?cashText(l.recovery.surplus):null}:null;
  return {...(l?.loss?{loss:{principal:show(l.loss.principal),interest:show(l.loss.interest),height:l.loss.height}}:{}),asset:'test '+this.asset.symbol,receiptPrefix:this.asset.addressFormat==='hex20'?'0x':'',visible:this.flow.wallet.key.publicKey===t.borrower,canReview:!reason&&(!!localOffer||!!this.flow.request),reason,id:t.id,principal:show(t.principal),interest:show(t.interest),pledged,cancelled:!!l?.cancelled,recovery,due:l?.debt?show(l.debt):null,collateral:l?.cash?cashText(l.cash):null,repaid:show(state.rewards?.calendarService?.reserve?.credit?.repaid??'0'),dueAt:l?.dueAt,returned:l?.release??null,pending};
 }
 async review(q){
  const {state}=await this.flow.current(),l=state.testLoan,t=this.t,owner=this.flow.wallet.key.publicKey;
  assert(owner===t.borrower);let cmd,summary,inputs=[];
  if(q.action==='Borrow'){
   exact(q,['action']);assert(!l);const packet=state.exchangeBook?.loanOffer;
   const received=packet&&packet.offer.until>=state.money.time&&packet.evidence.body.observedAt>=state.money.time-300?packet:await this.flow.remote('loan',{id:t.id});
   const {evidence}=received,cash=verifyLoanOffer(received,this.flow.p,state);
   this.db.prepare('INSERT OR IGNORE INTO credit_seen_pledges VALUES(?,?)').run(this.flow.pin,t.id);
   const admission=loanAdmission(state,this.flow.p,cash,evidence.body.observedAt,evidence.signatures.map(v=>v.observer));assert(admission.available,admission.reason);
   cmd={type:'LOAN_DRAW',...received};summary='Receive '+show(t.principal)+' free DUBYT. Repay '+show(admission.debt)+' DUBYT including '+show(t.interest)+' fixed interest within '+(t.duration/3600)+' hours. Pledged: '+displaySettlement(cash,this.asset)+' test '+this.asset.symbol+'.';
   if(t.maturityRecovery){
    cmd.maxRecoveryCash=admission.quote.cost;
    summary+=' After maturity, collateral can cover the outstanding DUBYT at a funded price up to '+displaySettlement(admission.quote.cost,this.asset)+' test '+this.asset.symbol+' for the full debt. Partial repayments reduce this limit proportionally. You receive the surplus.';
   }
  }else if(q.action==='Cancel unused loan'){
   exact(q,['action']);assert(!l,'This loan request is already resolved.');
   cmd={type:'LOAN_CANCEL_UNUSED',loan:t.id};
   summary='Close this loan offer permanently. Any accepted collateral will be returned to the original external wallet. No DUBYT principal has been drawn.';
  }else{
   exact(q,['action','amount']);assert.equal(q.action,'Repay');assert(l&&!l.release);const value=parseToken(q.amount,'1000000');
   assert(BigInt(value)>0n&&BigInt(value)<=BigInt(l.debt),'Repayment exceeds the outstanding debt.');
   inputs=askFundingInputs(state,owner,BigInt(value));cmd={type:'LOAN_REPAY',nonce:randomBytes(32).toString('hex'),value};
   summary='Repay '+show(value)+' DUBYT. Remaining debt: '+show(String(BigInt(l.debt)-BigInt(value)))+' DUBYT.';
  }
  const id=randomBytes(32).toString('hex');this.draft={id,cmd,inputs,until:this.flow.clock()+120};return {id,summary:summary+' DueByte fee: 0 DUBYT on this test route.'};
 }
 async confirm(q){
  exact(q,['id']);const d=this.draft;assert(d&&q.id===d.id&&this.flow.clock()<d.until,'Review the loan terms again.');this.draft=null;
  const wire=envelope(this.flow.c,{type:EXCHANGE_ACTION,command:d.cmd,inputs:d.inputs,...(this.flow.programme?{programme:this.t.id}:{})},this.flow.wallet.key),id=hash(wire);
  this.db.prepare('INSERT OR IGNORE INTO credit_test_outbox VALUES(?,?,?)').run(this.flow.pin,id,JSON.stringify(wire));return this.retry({id});
 }
 async retry(q){
  exact(q,['id']);hex(q.id);const r=this.db.prepare('SELECT wire FROM credit_test_outbox WHERE pin=? AND id=?').get(this.flow.pin,q.id);assert(r);
  const {state}=await this.flow.current(),wire=JSON.parse(r.wire),cmd=wire.body.action.command,l=state.testLoan;
  if(needsBroadcast(cmd,l))await this.flow.wallet.broadcast(wire);
  return {id:q.id,status:'Submitted. Checking DueByte confirmation.'};
 }
}
