import assert from 'node:assert/strict';
import {exact,hash,hex,integer} from '../crypto.mjs';
import {amount} from '../payment-model.mjs';
import {spendPolicy} from '../spend-protection.mjs';

const output=(configHash,id,role)=>hash({domain:'DUEBYTE_NATIVE_SERIES_MARKET_V1',configHash,id,role});
const held=(maker,value)=>({owner:maker,value:String(value),unlock:Number.MAX_SAFE_INTEGER});
const free=(s,id,owner,value)=>{if(value)s.money.outputs[id]={owner,value:String(value),unlock:0};};
function spendFree(s,author,inputs,value,id){
 const policy=spendPolicy(s,author);assert(!policy?.enabled&&!policy?.pending,'Separate spending consent required.');
 let sum=0n;
 for(const input of inputs){
  const coin=s.money.outputs[input];assert(coin?.owner===author&&coin.unlock<=s.money.time,'Free DUBYT unavailable.');
  sum+=amount(coin.value);
 }
 assert(sum>=value,'Insufficient free DUBYT.');
 for(const input of inputs)delete s.money.outputs[input];
 free(s,output(s.configHash,id,'change'),author,sum-value);
}
function moveBacked(book,owner,delta){
 const next=BigInt(book.balances[owner]??0)+delta;
 assert(next>=0n,'Insufficient available backed DUBYT.');
 book.balances[owner]=String(next);
}
export function heldMarketUnits(s,book){
 let total=0n;
 for(const [id,offer] of Object.entries(book.offers??{})){
  const hold=s.money.outputs[output(s.configHash,id,'hold')];
  if(offer.side==='SELL'&&offer.remaining)assert.deepEqual(hold,held(offer.maker,BigInt(offer.remaining)*amount(offer.freePerLot)));
  else assert(!hold);
  if(offer.side==='BUY')total+=BigInt(offer.remaining)*amount(offer.backedPerLot);
 }
 return total;
}

export function applySeriesMarket(s,book,action,author,id,terms){
 const cmd=action.command;
 const receipts=book.marketReceipts??={};
 if(receipts[id])return;
 const offers=book.offers??={};
 let other=author,freeAmount,backedAmount,offerId;
 if(cmd.type==='SERIES_OFFER'){
  exact(cmd,['type','side','freePerLot','backedPerLot','lots','expires','nonce']);hex(cmd.nonce);
  assert(!book.frozen&&['BUY','SELL'].includes(cmd.side));integer(cmd.lots,1);assert(cmd.lots<=1000000);
  integer(cmd.expires,s.money.time+1);assert(cmd.expires<=s.money.time+7*86400);
  const f=amount(cmd.freePerLot),b=amount(cmd.backedPerLot);
  assert(f>0n&&b>0n&&b*amount(terms.cash)%amount(terms.quantity)===0n,'Invalid lot precision.');
  freeAmount=f*BigInt(cmd.lots);backedAmount=b*BigInt(cmd.lots);amount(String(freeAmount));amount(String(backedAmount));
  assert(Object.keys(offers).length<32&&Object.keys(receipts).length<128,'Test offer capacity reached.');
  if(cmd.side==='SELL'){
   spendFree(s,author,action.inputs,freeAmount,id);
   s.money.outputs[output(s.configHash,id,'hold')]=held(author,freeAmount);
  }else{assert(!action.inputs.length);moveBacked(book,author,-backedAmount);}
  offers[id]={maker:author,side:cmd.side,freePerLot:cmd.freePerLot,backedPerLot:cmd.backedPerLot,lots:cmd.lots,remaining:cmd.lots,expires:cmd.expires,status:'Open'};
  offerId=id;
 }else{
  hex(cmd.offer);offerId=cmd.offer;const o=offers[offerId];assert(o&&o.status==='Open','Offer closed.');
  const hold=output(s.configHash,offerId,'hold');other=o.maker;
  if(cmd.type==='SERIES_CLOSE_OFFER'){
   exact(cmd,['type','offer']);assert(!action.inputs.length&&(author===o.maker||s.money.time>=o.expires));
   freeAmount=BigInt(o.remaining)*amount(o.freePerLot);backedAmount=BigInt(o.remaining)*amount(o.backedPerLot);
   if(o.side==='BUY')moveBacked(book,o.maker,backedAmount);
   else{delete s.money.outputs[hold];free(s,output(s.configHash,offerId,'release'),o.maker,freeAmount);}
   o.remaining=0;o.status=s.money.time>=o.expires?'Expired':'Cancelled';
  }else{
   exact(cmd,['type','offer','lots','nonce']);hex(cmd.nonce);integer(cmd.lots,1);
   assert(!book.frozen&&author!==o.maker&&s.money.time<o.expires&&cmd.lots<=o.remaining,'Offer unavailable.');
   assert(Object.keys(receipts).length<128,'Test fill capacity reached.');
   freeAmount=BigInt(cmd.lots)*amount(o.freePerLot);backedAmount=BigInt(cmd.lots)*amount(o.backedPerLot);
   if(o.side==='BUY'){
    spendFree(s,author,action.inputs,freeAmount,id);free(s,output(s.configHash,id,'fill'),o.maker,freeAmount);moveBacked(book,author,backedAmount);
   }else{
    assert(!action.inputs.length);moveBacked(book,author,-backedAmount);moveBacked(book,o.maker,backedAmount);
    delete s.money.outputs[hold];free(s,output(s.configHash,id,'fill'),author,freeAmount);
    if(o.remaining>cmd.lots)s.money.outputs[hold]=held(o.maker,BigInt(o.remaining-cmd.lots)*amount(o.freePerLot));
   }
   o.remaining-=cmd.lots;if(!o.remaining)o.status='Filled';
  }
 }
 receipts[id]={type:cmd.type,offer:offerId,author,recipient:other,free:String(freeAmount),backed:String(backedAmount),height:s.height};
}
