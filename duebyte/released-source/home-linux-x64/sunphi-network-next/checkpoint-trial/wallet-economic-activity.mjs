import {hash} from './crypto.mjs';
import {formatToken} from './token-units.mjs';
import {WalletBackedSeries} from './wallet-backed-series.mjs';
import {programmes,programmeView,selectProgramme} from './research/reserve-portfolio.mjs';
import {displaySettlement,reserveAsset} from './research/settlement-asset.mjs';
import {LOAN} from './research/reserve-test-loan.mjs';
import {cashFor} from './research/backed-series.mjs';

const coins=value=>formatToken(String(value),'1000000')+' DUBYT';

// Project only this wallet's records from the already authenticated wallet view.
// Snapshot height and event height are distinct, including for legacy records.
export function economicActivity(flow,state){
 const owner=flow.wallet.key.publicKey,policy=flow.p,reserve=policy.reserve,rows=[];
 function add(type,id,result,summary,fields,height){
  rows.push({type,id,result,summary,fields:Object.fromEntries(Object.entries(fields).filter(([,v])=>v!=null)),...(height?{height}:{})});
 }
 const orders=state.exchangeBook?.orders??{};
 const quotes=new Map(flow.rows().map(r=>[r.id,JSON.parse(r.offer).quote]));
 for(const [id,o] of Object.entries(orders))if(o.quote.user===owner||o.quote.provider===owner)quotes.set(id,o.quote);
 for(const [id,q] of quotes){
  if(q.user!==owner&&q.provider!==owner)continue;
  const o=orders[id],user=q.user===owner,received=(q.direction==='BUY_DUBYT')===user;
  const trade=flow.present({quote:q},o);
  const result=({CLAIMED:'Confirmed',REFUNDED:'Refunded',LOCKED:'Reserved'})[o?.status]??(o?o.status:state.money.time>q.quoteUntil?'Expired without confirmation':'Awaiting confirmation');
  const settlement=trade.settlement;
  add(received?'Purchase':'Sale',id,result,trade.dubyt+' free DUBYT',{
   'Settlement network':trade.network,'Quoted amount':trade.external+' '+trade.asset,
   ...(settlement&&user?{'Quoted total':settlement.externalTotal+' '+trade.asset,'Exchange fee':settlement.exchangeFee+' '+trade.asset}:{}),
   Counterparty:user?q.provider:q.user,'Settlement evidence':o?.evidence});
 }
 for(const t of programmes(reserve,'series')){
  const scoped=reserve.portfolio?programmeView(state,policy,'series',t.id):state;
  const series=reserve.portfolio?new WalletBackedSeries({...flow,p:selectProgramme(policy,'series',t.id),programme:t.id}):flow.series;
  const s=series.presentation(scoped),book=scoped.backedSeries;
  for(const r of s.receipts??[]){
   const source=book.receipts[r.id]??book.marketReceipts?.[r.id],order=book.orders?.[r.order],offer=book.offers?.[r.offer];
   const payFree=offer&&(offer.side==='BUY')===(source?.author===owner);
   const allocation={};
   let summary=r.units?r.units+' backed DUBYT':'',type=r.status;
   if(r.status==='Exchange settled'){type='Exchange';summary=payFree?'Paid '+r.free+' free DUBYT · Received '+r.backed+' backed DUBYT':'Paid '+r.backed+' backed DUBYT · Received '+r.free+' free DUBYT';}
   else if(r.order){
    type='Order settlement';summary=r.accepted+' of '+order.quantity+' accepted';
    const unit=BigInt(order.unitPrice);
    const entitlement=n=>displaySettlement(cashFor(t,unit)*BigInt(n),series.asset)+' '+s.asset;
    allocation['Total entitlement accepted']=entitlement(r.accepted);
    allocation[r.status==='Cancellation confirmed'?'Returned to buyer':'Remaining on order']=entitlement(order.quantity-r.accepted);
   }
   else if(book.redemptions[r.id])type='Redemption';
   else if(r.status==='Transfer confirmed')type='Backed payment';
   add(type,r.id,r.status,summary,{Series:t.id,'Settlement network':s.network,Asset:s.asset,Order:r.order,Offer:r.offer,
    Buyer:order?.buyer,Supplier:order?.supplier,'Unit price':order?coins(order.unitPrice):undefined,...allocation,
    Sender:source?.author,Recipient:r.recipient??source?.recipient,Amount:r.cash==null?undefined:r.cash+' '+s.asset,
    Purpose:r.purpose,Contract:r.contract,'Settlement transaction':r.external?.transaction,'Settlement block':r.external?.block,'Event index':r.external?.logIndex},r.height);
  }
 }
 for(const t of programmes(reserve,'credit')){
  if(t.borrower!==owner)continue;
  const l=reserve.portfolio?state.exchangeBook?.positions?.[t.id]?.loan:state.testLoan;
  const asset=reserveAsset(policy),cash=n=>displaySettlement(n,asset)+' test '+asset.symbol;
  const fields={Loan:t.id,'Settlement network':asset.network,'Collateral account':t.externalOwner};
  const pin=reserve.portfolio?hash([flow.pin,t.id]):flow.pin;
  const local=flow.wallet.db.prepare('SELECT id,wire FROM credit_test_outbox WHERE pin=?').all(pin);
  const submitted=new Map();
  for(const row of local){
   const cmd=JSON.parse(row.wire).body.action.command;
   if(cmd.type==='LOAN_REPAY'){
    submitted.set(cmd.nonce,row.id);
    if(!l?.repayments?.[cmd.nonce])add('Loan repayment',cmd.nonce,l?.release||l?.recovery?'Unconfirmed request':'Awaiting confirmation',coins(cmd.value),{...fields,'Signed request':row.id});
   }else if(!l)add('Loan request',row.id,'Awaiting confirmation',cmd.type==='LOAN_DRAW'?coins(t.principal):'Cancel unused loan',fields);
  }
  if(!l)continue;
  if(l.offer)add('Loan draw',l.offer,'Confirmed',coins(t.principal),{...fields,'Fixed interest':coins(t.interest)});
  for(const [nonce,value] of Object.entries(l.repayments??{})){
   const payment={type:'LOAN_REPAY',nonce,value};
   const final=l.payoff===hash({domain:LOAN,configHash:state.configHash,loan:t.id,payment});
   add('Loan repayment',nonce,final?'Loan repaid':'Confirmed',coins(value),{...fields,'Signed request':submitted.get(nonce),'Current outstanding debt':coins(l.debt)});
  }
  if(l.loss){add('Loan loss',l.loss.transaction,'Finalized',coins(l.loss.principal),{...fields,'Interest waived':coins(l.loss.interest)},l.loss.height);continue;}
  if(l.release||l.payoff||l.cancelled){
   const amount=l.recovery?l.recovery.surplus:l.cash;
   add('Collateral return',l.payoff??l.cancelled??l.recovery.certificate,l.release?'Returned':'Awaiting collateral return',amount==null?'':cash(amount),
    {...fields,'Settlement transaction':l.release,'Current outstanding debt':l.debt==null?undefined:coins(l.debt)});
  }
 }
 return {network:flow.c.chainId,owner,verifiedThrough:state.height,rows};
}
