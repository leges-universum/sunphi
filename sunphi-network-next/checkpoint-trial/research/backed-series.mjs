import assert from 'node:assert/strict';
import {exact,hash,hex,integer,publicKey,verify} from '../crypto.mjs';
import {amount} from '../payment-model.mjs';
import {spendPolicy} from '../spend-protection.mjs';
import {validateSettlementAsset,settlementAddress,seriesAsset} from './settlement-asset.mjs';
import {applySeriesMarket,heldMarketUnits} from './series-market.mjs';

export const SERIES='DUEBYTE_ISOLATED_BACKED_SERIES_V1';
const commercialUnits={GOODS:'goods units',WORK:'work milestones',SERVICE:'service deliverables'};
export function commercialUnitLabel(order){
 if(!Object.hasOwn(order,'unit'))return 'units';
 assert(Object.hasOwn(commercialUnits,order.unit)&&typeof order.unit==='string','Unknown commercial unit.');
 return commercialUnits[order.unit];
}
const key=(config,id,role)=>hash({domain:SERIES,config,id,role});
export function validateSeries(t){
 exact(t,['id','termsHash','contributor','holder','vault','codeHash','quantity','cash',...(Object.hasOwn(t,'settlement')?['settlement']:[])]);
 for(const field of ['id','termsHash','codeHash'])hex(t[field]);
 publicKey(t.contributor);publicKey(t.holder);
 if(Object.hasOwn(t,'settlement'))validateSettlementAsset(t.settlement);
 settlementAddress(t.vault,t.settlement?.addressFormat??'hex20');
 assert(amount(t.quantity)>0n&&amount(t.cash)>0n);
}
export function cashFor(t,value){
 const product=value*amount(t.cash),units=amount(t.quantity);
 assert(value>0n&&product%units===0n,'Amount exceeds series redemption precision.');return product/units;
}
export function checkEvidence(receipt,expected,p,s,domain=SERIES){
 exact(receipt,['body','signatures']);const b=receipt.body;
 exact(b,[...Object.keys(expected),'domain','configHash','transaction','block','logIndex','observedAt']);
 for(const [field,value] of Object.entries(expected))assert.deepEqual(b[field],value);
 assert.equal(b.domain,domain+'/EVIDENCE');assert.equal(b.configHash,s.configHash);
 hex(b.transaction);hex(b.block);integer(b.logIndex);integer(b.observedAt,1);
 assert(b.observedAt<=s.money.time&&s.money.time-b.observedAt<=300,'Refresh series evidence.');
 assert(Array.isArray(receipt.signatures)&&receipt.signatures.length>=2&&receipt.signatures.length<=3);
 const seen=new Set();for(const v of receipt.signatures){exact(v,['observer','signature']);assert(!seen.has(v.observer)&&p.observers.includes(v.observer)&&verify(b,v.signature,v.observer),'Invalid series observation.');seen.add(v.observer);}
}
export function assertCustody(s,t,book){
 const open=Object.values(book.balances).reduce((n,v)=>n+amount(v),0n);
 const pending=Object.values(book.redemptions).reduce((n,v)=>n+(v.paid?0n:amount(v.units)),0n);
 const orderHolds=Object.values(book.orders??{}).reduce((n,o)=>n+(o.closed?0n:BigInt(o.quantity-o.accepted)*amount(o.unitPrice)),0n);
 const released=amount(book.released),held=open+pending+orderHolds+heldMarketUnits(s,book);
 assert.equal(held+released,amount(t.quantity),'Native series conservation.');
 assert.equal(amount(book.paidCash)*amount(t.quantity),released*amount(t.cash),'External series conservation.');
 const native=s.money.outputs[key(s.configHash,t.id,'native')];
 if(held)assert.deepEqual(native,{owner:t.contributor,value:String(held),unlock:Number.MAX_SAFE_INTEGER});
 else assert(!native);
 if(t.settlement){
  // Every current or contingent holder must be able to redeem in full, even
  // when the bounded trial history has no room for another discretionary move.
  const holders=new Set(Object.entries(book.balances).filter(([,n])=>amount(n)>0n).map(([owner])=>owner));
  let orderExits=0;
  for(const o of Object.values(book.orders))if(!o.closed){
   holders.add(o.buyer);holders.add(o.supplier);orderExits+=o.cancelRequested?1:2;
  }
  for(const o of Object.values(book.offers??{}))if(o.remaining&&o.side==='BUY')holders.add(o.maker);
  assert(Object.keys(book.receipts).length+holders.size+orderExits<=128,'Remaining capacity is reserved for full redemptions and order closure.');
 }
}
export function verifySeriesFunding(p,s,evidence){
 const t=p.reserve.series,route=seriesAsset(p);
 checkEvidence(evidence,{series:t.id,vault:t.vault,codeHash:t.codeHash,genesis:route.genesis,token:route.assetId,event:'FUNDED',cash:t.cash},p,s);
}
export function applySeries(s,a,author,c){
 const p=c.exchangeLab.policy,t=p.reserve?.series;assert(t&&(p.reserve.armAtLock||p.reserve.nativeOnly),'Series unavailable.');validateSeries(t);
 const cmd=a.command,route=seriesAsset(p),book=s.backedSeries;
 const expected={series:t.id,vault:t.vault,codeHash:t.codeHash,genesis:route.genesis,token:route.assetId};
 const held=key(s.configHash,t.id,'native');
 if(cmd.type==='SERIES_OPEN'){
  exact(cmd,['type','evidence']);assert.equal(author,t.contributor);
  if(book){assertCustody(s,t,book);return s;}
  const protection=spendPolicy(s,author);assert(!protection?.enabled&&!protection?.pending);
  verifySeriesFunding(p,s,cmd.evidence);
  let funds=0n;for(const id of a.inputs){const o=s.money.outputs[id];assert(o&&o.owner===author&&o.unlock<=s.money.time);funds+=amount(o.value);}
  const units=amount(t.quantity),fee=amount(c.exchangeLab.feeMicro);assert(funds>=units+fee,'Insufficient native series contribution.');
  for(const input of a.inputs)delete s.money.outputs[input];
  s.money.fees=String(amount(s.money.fees)+fee);s.money.outputs[held]={owner:author,value:t.quantity,unlock:Number.MAX_SAFE_INTEGER};
  if(funds>units+fee)s.money.outputs[key(s.configHash,t.id,'change')]={owner:author,value:String(funds-units-fee),unlock:0};
  s.backedSeries={frozen:false,balances:{[t.holder]:t.quantity},redemptions:{},orders:{},receipts:{},released:'0',paidCash:'0',funding:hash(cmd.evidence.body)};
  if(t.settlement){
   const id=hash({domain:SERIES,configHash:s.configHash,series:t.id,author,command:cmd});
   s.backedSeries.receipts[id]={type:'SERIES_OPEN',author,recipient:t.holder,units:t.quantity,height:s.height};
   if(s.exchangeBook)delete s.exchangeBook.seriesFundingReceipt;
  }
 }else{
  assert(book);assertCustody(s,t,book);
  if(['SERIES_OFFER','SERIES_FILL','SERIES_CLOSE_OFFER'].includes(cmd.type)){
   assert(p.reserve.nativeOnly===true||p.reserve.settlement);
   const id=hash({domain:SERIES,configHash:s.configHash,series:t.id,author,command:cmd});
   applySeriesMarket(s,book,a,author,id,t);assertCustody(s,t,book);return s;
  }
  assert(a.inputs.length===0);
  if(cmd.type==='SERIES_FREEZE'){
   exact(cmd,['type','evidence']);checkEvidence(cmd.evidence,{...expected,event:'FROZEN'},p,s);book.frozen=true;
  }else if(cmd.type==='SERIES_PAID'){
   exact(cmd,['type','id','evidence']);hex(cmd.id);const r=book.redemptions[cmd.id];assert(r,'Unknown redemption.');
   if(r.paid){assert.equal(r.paid,hash({tx:cmd.evidence.body.transaction,index:cmd.evidence.body.logIndex}));return s;}
   checkEvidence(cmd.evidence,{...expected,event:'PAID',request:cmd.id,recipient:r.recipient,cash:r.cash},p,s);
   const payment=hash({tx:cmd.evidence.body.transaction,index:cmd.evidence.body.logIndex});
   assert(!Object.values(book.redemptions).some(other=>other.paid===payment),'Payment already used for another redemption.');
   const left=amount(s.money.outputs[held].value)-amount(r.units);
   if(left)s.money.outputs[held].value=String(left);else delete s.money.outputs[held];
   s.money.outputs[key(s.configHash,cmd.id,'return')]={owner:t.contributor,value:r.units,unlock:0};
   r.paid=payment;r.height=s.height;
   r.external={transaction:cmd.evidence.body.transaction,block:cmd.evidence.body.block,logIndex:cmd.evidence.body.logIndex};
   book.released=String(amount(book.released)+amount(r.units));book.paidCash=String(amount(book.paidCash)+amount(r.cash));
  }else if(cmd.type==='SERIES_ORDER'){
   exact(cmd,['type','agreement','supplierSignature']);
   const g=cmd.agreement;
   exact(g,['domain','configHash','series','buyer','supplier','nonce','referenceHash','quantity','unitPrice',...(Object.hasOwn(g,'unit')?['unit']:[])]);commercialUnitLabel(g);
   assert.equal(g.domain,SERIES+'/ORDER');assert.equal(g.configHash,s.configHash);assert.equal(g.series,t.id);
   assert.equal(author,g.buyer);publicKey(g.supplier);assert.notEqual(g.buyer,g.supplier);hex(g.nonce);hex(g.referenceHash);
   assert(verify(g,cmd.supplierSignature,g.supplier),'Supplier agreement required.');
   const id=hash(g);if(book.orders[id])return s;
   assert(!Object.values(book.orders).some(o=>o.supplier===g.supplier&&o.referenceHash===g.referenceHash),'Merchant reference already used.');
   assert(!book.frozen&&Object.keys(book.orders).length<32);integer(g.quantity,1);assert(g.quantity<=1000000);
   cashFor(t,amount(g.unitPrice));const value=BigInt(g.quantity)*amount(g.unitPrice),balance=amount(book.balances[author]??'0');
   assert(balance>=value,'Insufficient backed units to fund order.');book.balances[author]=String(balance-value);
   book.orders[id]={buyer:g.buyer,supplier:g.supplier,referenceHash:g.referenceHash,unitPrice:g.unitPrice,quantity:g.quantity,...(g.unit?{unit:g.unit}:{}),accepted:0,cancelRequested:false,closed:false};
   const receipt=hash({domain:SERIES,configHash:s.configHash,series:t.id,author,command:cmd});
   assert(Object.keys(book.receipts).length<128);book.receipts[receipt]={type:cmd.type,author,recipient:g.supplier,order:id,accepted:0,referenceHash:g.referenceHash,height:s.height};
  }else if(['SERIES_ACCEPT','SERIES_REQUEST_CANCEL','SERIES_CONFIRM_CANCEL'].includes(cmd.type)){
   exact(cmd,cmd.type==='SERIES_ACCEPT'?['type','id','accepted']:['type','id']);hex(cmd.id);
   const o=book.orders[cmd.id];assert(o,'Unknown commercial order.');
   const credit=(who,n)=>{book.balances[who]=String(amount(book.balances[who]??'0')+BigInt(n)*amount(o.unitPrice));};
   if(cmd.type==='SERIES_ACCEPT'){
    assert.equal(author,o.buyer);integer(cmd.accepted,1);
    if(cmd.accepted===o.accepted)return s;
    assert(!book.frozen&&!o.closed&&!o.cancelRequested&&cmd.accepted>o.accepted&&cmd.accepted<=o.quantity);
    credit(o.supplier,cmd.accepted-o.accepted);o.accepted=cmd.accepted;o.closed=o.accepted===o.quantity;
   }else if(cmd.type==='SERIES_REQUEST_CANCEL'){
    assert.equal(author,o.buyer);if(o.cancelRequested)return s;assert(!o.closed);o.cancelRequested=true;
   }else{
    assert.equal(author,o.supplier);assert(o.cancelRequested);if(o.closed)return s;
    credit(o.buyer,o.quantity-o.accepted);o.closed=true;
   }
   const receipt=hash({domain:SERIES,configHash:s.configHash,series:t.id,author,command:cmd});
   assert(Object.keys(book.receipts).length<128,'Isolated series receipt capacity reached.');
   book.receipts[receipt]={type:cmd.type,author,recipient:author===o.supplier?o.buyer:o.supplier,order:cmd.id,accepted:o.accepted,referenceHash:o.referenceHash,height:s.height};
  }else{
   assert(['SERIES_TRANSFER','SERIES_REDEEM'].includes(cmd.type));exact(cmd,['type','recipient','units','nonce','referenceHash']);
   hex(cmd.nonce);hex(cmd.referenceHash);const id=hash({domain:SERIES,configHash:s.configHash,series:t.id,author,command:cmd});
   if(book.receipts[id])return s;
   assert(Object.keys(book.receipts).length<128,'Isolated series receipt capacity reached.');
   const value=amount(cmd.units),cash=String(cashFor(t,value)),balance=amount(book.balances[author]??'0');assert(balance>=value,'Insufficient available series units.');
   if(cmd.type==='SERIES_TRANSFER'){assert(!book.frozen,'Series transfers suspended.');publicKey(cmd.recipient);assert.notEqual(cmd.recipient,author);book.balances[cmd.recipient]=String(amount(book.balances[cmd.recipient]??'0')+value);}
   else{settlementAddress(cmd.recipient,route.addressFormat);assert.notEqual(cmd.recipient,t.vault);book.redemptions[id]={holder:author,recipient:cmd.recipient,units:cmd.units,cash,paid:null};}
   book.balances[author]=String(balance-value);book.receipts[id]={type:cmd.type,author,recipient:cmd.recipient,units:cmd.units,referenceHash:cmd.referenceHash,height:s.height};
  }
 }
 assertCustody(s,t,s.backedSeries);return s;
}
