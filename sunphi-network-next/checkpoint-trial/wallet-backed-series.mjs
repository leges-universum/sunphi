import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {receiptNote,savedReceiptNotes,storeReceiptNotes} from './wallet-receipt-notes.mjs';
import {exact,hash,hex,publicKey} from './crypto.mjs';
import {parseToken,formatToken} from './token-units.mjs';
import {envelope} from './core.mjs';
import {EXCHANGE_ACTION} from './research/exchange-native.mjs';
import {SERIES,cashFor,commercialUnitLabel,verifySeriesFunding} from './research/backed-series.mjs';
import {parsePaymentLink} from './backed-payment-link.mjs';
import {seriesAsset,settlementAddress,displaySettlement} from './research/settlement-asset.mjs';
import {askFundingInputs} from './research/reserve-limit-asks.mjs';
const display=value=>formatToken(String(value),'1000000');
function marketConflict(wire,state){
 const {command:c,inputs}=wire.body.action,offer=state.backedSeries?.offers?.[c.offer];
 if(!['SERIES_OFFER','SERIES_FILL','SERIES_CLOSE_OFFER'].includes(c.type))return null;
 if(c.type==='SERIES_OFFER'&&c.expires<=state.money.time)return 'Offer expired before confirmation';
 if(c.type==='SERIES_FILL'&&(!offer||offer.status!=='Open'||offer.remaining<c.lots||offer.expires<=state.money.time))return 'Offer no longer available';
 if(c.type==='SERIES_CLOSE_OFFER'&&offer?.status!=='Open')return 'Offer already closed';
 if(inputs.some(id=>!state.money.outputs[id]))return 'Funding changed. Review a new offer.';
 return null;
}

export class WalletBackedSeries{
 constructor(flow){
  this.flow=flow;this.t=flow.p.reserve.series;this.db=flow.wallet.db;this.owner=flow.wallet.key.publicKey;
  this.asset=seriesAsset(flow.p);this.assetLabel='test '+this.asset.symbol;
  this.db.exec('CREATE TABLE IF NOT EXISTS backed_outbox(pin TEXT NOT NULL,id TEXT NOT NULL,wire TEXT NOT NULL,note TEXT NOT NULL,PRIMARY KEY(pin,id))');
 }
 outbox(columns){
  const rows=this.db.prepare('SELECT '+columns+' FROM backed_outbox WHERE pin=?').all(this.flow.pin);
  return rows.filter(r=>JSON.parse(r.wire).body.action.programme===this.flow.programme);
 }
 note(id,value){
  return receiptNote(this.flow.wallet.key,this.flow.pin,id,value);
 }
 async status(){
  return this.presentation((await this.flow.current()).state);
 }
 presentation(state){
  const b=state.backedSeries;
  if(!b){
   if(!this.t.settlement||![this.t.holder,this.t.contributor].includes(this.owner))return {available:false};
   const evidence=state.exchangeBook?.seriesFundingReceipt,observed=evidence?.body.observedAt;
   const current=Number.isSafeInteger(observed)&&observed<=state.money.time&&state.money.time-observed<=300;
   if(this.owner===this.t.contributor){
    const rows=this.outbox('id,wire');
    const prior=rows.find(({wire})=>{const cmd=JSON.parse(wire).body.action.command;return cmd.type==='SERIES_OPEN'&&cmd.evidence.body.observedAt>=state.money.time-300;});
    if(prior)return {available:true,opening:true,canOpen:false,retryOpening:prior.id,openingStatus:'Activation submitted. Waiting for DueByte confirmation.'};
   }
   return {available:true,opening:true,canOpen:current&&this.owner===this.t.contributor,openingStatus:!current?'Waiting for verified backing.':this.owner===this.t.contributor?'Backing verified. Review the native DUBYT lock.':'Backing verified. Waiting for the contributor to lock DUBYT.'};
  }
  const saved=new Map(savedReceiptNotes(this.db,this.flow.pin).map(r=>[r.id,r.note]));
  const pending=this.outbox('id,note,wire');
  const notes=new Map(),newlyConfirmed=[];
  for(const {id,note} of [...saved].map(([id,note])=>({id,note})).concat(pending)){
   const r=b.receipts[id];if(r?.author!==this.owner||!['SERIES_TRANSFER','SERIES_REDEEM'].includes(r.type))continue;
   const content=this.note(id,note);
   if(hash(content)!==r.referenceHash)continue;
   notes.set(id,{purpose:content.purpose,contract:content.contract});
   if(!saved.has(id))newlyConfirmed.push({id,note});
  }
  if(newlyConfirmed.length)storeReceiptNotes(this.db,this.flow.pin,newlyConfirmed);
  const receipts=Object.entries({...b.receipts,...b.marketReceipts}).filter(([,r])=>r.author===this.owner||r.recipient===this.owner).map(([id,r])=>{
   const redemption=b.redemptions[id],note=notes.get(id);notes.delete(id);
   if(r.offer)return {id,height:r.height,offer:r.offer,free:display(r.free),backed:display(r.backed),status:({SERIES_OFFER:'Offer placed',SERIES_FILL:'Exchange settled',SERIES_CLOSE_OFFER:'Offer closed'})[r.type]};
   if(r.order)return {id,order:r.order,height:r.height,status:({SERIES_ORDER:'Order funded',SERIES_ACCEPT:'Delivery accepted',SERIES_REQUEST_CANCEL:'Cancellation requested',SERIES_CONFIRM_CANCEL:'Cancellation confirmed'})[r.type],accepted:r.accepted};
   return {id,units:display(r.units),height:redemption?.paid?redemption.height:r.height,recipient:r.recipient,...note,
    status:r.type==='SERIES_OPEN'?'Backed balance activated':redemption?(redemption.paid?'External payment confirmed':'External payment pending'):'Transfer confirmed',cash:displaySettlement(cashFor(this.t,BigInt(r.units)),this.asset),external:redemption?.external??null};
  });
  for(const {id,wire} of pending){
   if(b.receipts[id]||b.marketReceipts?.[id])continue;
   const conflict=marketConflict(JSON.parse(wire),state);
   receipts.push({id,status:conflict??'Awaiting DueByte confirmation',pending:!conflict});
  }
  const orders=Object.entries(b.orders).filter(([,o])=>[o.buyer,o.supplier].includes(this.owner)).map(([id,o])=>({id,quantity:o.quantity,unitLabel:commercialUnitLabel(o),accepted:o.accepted,closed:o.closed,cancelRequested:o.cancelRequested,role:o.buyer===this.owner?'Buyer':'Supplier',remaining:displaySettlement(o.closed?0n:cashFor(this.t,BigInt(o.unitPrice)) * BigInt(o.quantity-o.accepted),this.asset)}));
  const balance=BigInt(b.balances[this.owner]??0);
  const orderHold=Object.values(b.orders).filter(o=>o.buyer===this.owner&&!o.closed).reduce((n,o)=>n+BigInt(o.quantity-o.accepted)*BigInt(o.unitPrice),0n);
  const marketHold=Object.values(b.offers??{}).filter(o=>o.maker===this.owner&&o.side==='BUY').reduce((n,o)=>n+BigInt(o.remaining)*BigInt(o.backedPerLot),0n);
  const redeemHold=Object.values(b.redemptions).filter(r=>r.holder===this.owner&&!r.paid).reduce((n,r)=>n+BigInt(r.units),0n);
  const offers=Object.entries(b.offers??{}).filter(([,o])=>o.status==='Open').sort(([id,a],[other,bid])=>{
   if(a.side!==bid.side)return a.side==='SELL'?-1:1;
   const difference=BigInt(a.backedPerLot)*BigInt(bid.freePerLot)-BigInt(bid.backedPerLot)*BigInt(a.freePerLot);
   if(difference)return (difference<0n?-1:1)*(a.side==='SELL'?1:-1);
   return (b.marketReceipts[id].height-b.marketReceipts[other].height)||id.localeCompare(other);
  }).map(([id,o])=>({id,side:o.side,own:o.maker===this.owner,expired:o.expires<=state.money.time,remaining:o.remaining,free:display(o.freePerLot),backed:display(o.backedPerLot)}));
  receipts.sort((a,b)=>(b.height??Number.MAX_SAFE_INTEGER)-(a.height??Number.MAX_SAFE_INTEGER)||a.id.localeCompare(b.id));
  return {available:true,series:this.t.id,network:this.asset.network,asset:this.assetLabel,accountFormat:this.asset.addressFormat,vault:this.t.vault,frozen:b.frozen,balance:display(balance),holds:{orders:display(orderHold),offers:display(marketHold),redemptions:display(redeemHold)},cash:displaySettlement(balance?cashFor(this.t,balance):0n,this.asset),receipts,orders,offers,nativeMarket:(this.flow.p.reserve.nativeOnly===true||!!this.flow.p.reserve.settlement)};
 }
 async review(q){
  const {state}=await this.flow.current(),b=state.backedSeries;
  if(q.action==='Activate backed balance'){
   exact(q,['action']);assert(!b&&this.t.settlement&&this.owner===this.t.contributor);
   const evidence=state.exchangeBook?.seriesFundingReceipt;assert(evidence,'Waiting for verified backing.');verifySeriesFunding(this.flow.p,state,evidence);
   const fee=BigInt(this.flow.c.exchangeLab.feeMicro),inputs=askFundingInputs(state,this.owner,BigInt(this.t.quantity)+fee);
   const id=randomBytes(32).toString('hex');this.draft={id,command:{type:'SERIES_OPEN',evidence},inputs,note:{},until:this.flow.clock()+120};
   return {id,summary:'Lock '+display(this.t.quantity)+' free DUBYT against '+displaySettlement(this.t.cash,this.asset)+' '+this.assetLabel+' in '+this.t.vault+' on '+this.asset.network+'. '+this.t.holder+' receives '+display(this.t.quantity)+' backed DUBYT. You pay the DueByte fee of '+display(fee)+' DUBYT.'};
  }
  assert(b,'Series unavailable.');
  const cashText=n=>displaySettlement(n,this.asset)+' '+this.assetLabel;
  let command,description,note={},inputs=[];
  if(['Place offer','Fill offer','Close offer'].includes(q.action)){
   assert((this.flow.p.reserve.nativeOnly===true||!!this.flow.p.reserve.settlement));const placing=q.action==='Place offer';
   const o=placing?null:b.offers?.[q.offer];
   if(!placing)assert(o?.status==='Open','Offer closed.');
   if(q.action==='Close offer'){
    exact(q,['action','offer']);assert(o.maker===this.owner||state.money.time>=o.expires);
    command={type:'SERIES_CLOSE_OFFER',offer:q.offer};
    description='Release the unfilled balance to the maker: '+display(BigInt(o.remaining)*BigInt(o.side==='BUY'?o.backedPerLot:o.freePerLot))+(o.side==='BUY'?' backed':' free')+' DUBYT.';
   }else{
    exact(q,placing?['action','side','free','backed','lots','hours']:['action','offer','lots']);
    assert(!b.frozen&&Number.isSafeInteger(q.lots)&&q.lots>=1&&q.lots<=1000000,'Invalid lot count.');
    const side=placing?q.side:o.side,freePerLot=placing?parseToken(q.free,'1000000'):o.freePerLot,backedPerLot=placing?parseToken(q.backed,'1000000'):o.backedPerLot;
    const f=BigInt(freePerLot)*BigInt(q.lots),u=BigInt(backedPerLot)*BigInt(q.lots);
    assert(f>0n&&['BUY','SELL'].includes(side));cashFor(this.t,BigInt(backedPerLot));
    if(placing)assert(Number.isInteger(q.hours)&&q.hours>=1&&q.hours<=168);
    else assert(o.maker!==this.owner&&state.money.time<o.expires&&q.lots<=o.remaining,'Offer unavailable.');
    const payingFree=placing?side==='SELL':side==='BUY';
    if(payingFree)inputs=askFundingInputs(state,this.owner,f);
    else assert(BigInt(b.balances[this.owner]??0)>=u,'Insufficient available backed DUBYT.');
    const freeText=display(f)+' free DUBYT',backedText=display(u)+' backed DUBYT (claim on '+cashText(cashFor(this.t,u))+')';
    description=placing?'Reserve '+(payingFree?freeText:backedText)+' for '+q.hours+' hours. A full fill pays you '+(payingFree?backedText:freeText)+'.':'Pay '+(payingFree?freeText:backedText)+'. Receive '+(payingFree?backedText:freeText)+' in the same DueByte transaction.';
    const nonce=randomBytes(32).toString('hex');
    command=placing?{type:'SERIES_OFFER',side,freePerLot,backedPerLot,lots:q.lots,expires:state.money.time+3600*q.hours,nonce}:{type:'SERIES_FILL',offer:q.offer,lots:q.lots,nonce};
   }
  }else if(q.action==='Fund order'){
   exact(q,['action','link']);const parsed=parsePaymentLink(q.link,state.configHash,this.t,this.owner);command=parsed.command;
   const g=command.agreement,value=BigInt(g.unitPrice)*BigInt(g.quantity);
   assert(!b.frozen&&!b.orders[parsed.id]&&value<=BigInt(b.balances[this.owner]??'0'),'Order already funded or balance unavailable.');
   description='Reserve '+display(value)+' backed DUBYT for '+g.quantity+' '+commercialUnitLabel(g)+' from '+g.supplier+'. The order holds '+cashText(cashFor(this.t,value))+' in redemption rights. Delivery requires your acceptance.';
  }else if(['Transfer','Redeem'].includes(q.action)){
   exact(q,['action','recipient','amount','purpose','contract']);
   for(const field of ['purpose','contract'])assert(typeof q[field]==='string'&&q[field].length<=160,'Payment details are too long.');
   const units=parseToken(q.amount,'1000000'),value=BigInt(units),cash=cashText(cashFor(this.t,value));
   assert(value<=BigInt(b.balances[this.owner]??0),'Insufficient available series units.');
   const redeem=q.action==='Redeem',recipient=redeem&&this.asset.addressFormat==='hex20'?q.recipient.toLowerCase():q.recipient;
   if(redeem){settlementAddress(recipient,this.asset.addressFormat);assert.notEqual(recipient,this.t.vault);}
   else{publicKey(recipient);assert(recipient!==this.owner&&!b.frozen,'Transfer unavailable.');}
   note={purpose:q.purpose,contract:q.contract,salt:randomBytes(32).toString('hex')};const nonce=randomBytes(32).toString('hex');
   command={type:redeem?'SERIES_REDEEM':'SERIES_TRANSFER',units,recipient,nonce,referenceHash:hash(note)};
   description=redeem?'Redeem '+display(units)+' backed DUBYT. Receive '+cash+' at '+recipient+'. Confirmation requires a verified payment receipt.':'Transfer '+display(units)+' backed DUBYT to '+recipient+'. The recipient takes the claim on '+cash+'.';
  }else{
   hex(q.order);const o=b.orders[q.order];assert(o&&!o.closed,'Order closed.');
   if(q.action==='Accept'){
    exact(q,['action','order','accepted']);assert(this.owner===o.buyer&&!o.cancelRequested&&!b.frozen);assert(Number.isInteger(q.accepted)&&q.accepted>o.accepted&&q.accepted<=o.quantity);
    command={type:'SERIES_ACCEPT',id:q.order,accepted:q.accepted};
    const price=cashFor(this.t,BigInt(o.unitPrice));description='Accept '+q.accepted+' of '+o.quantity+' '+commercialUnitLabel(o)+' in total. Supplier receives the claim on '+cashText(price*BigInt(q.accepted-o.accepted))+'. Remaining on order: '+cashText(price*BigInt(o.quantity-q.accepted))+'.';
   }else{
    exact(q,['action','order']);const request=q.action==='Request cancellation';
    assert(request||q.action==='Confirm cancellation');assert(request?this.owner===o.buyer&&!o.cancelRequested:this.owner===o.supplier&&o.cancelRequested);
    command={type:request?'SERIES_REQUEST_CANCEL':'SERIES_CONFIRM_CANCEL',id:q.order};
    description=request?'Request cancellation of the undelivered remainder. The supplier must confirm.':'Return the undelivered remainder to the buyer’s backed balance.';
   }
  }
  const id=randomBytes(32).toString('hex');this.draft={id,command,note,inputs,until:this.flow.clock()+120};
  return {id,summary:description+' DueByte fee: 0 DUBYT on this test route.'};
 }
 async confirm(q){
  exact(q,['id']);const d=this.draft;assert(d&&q.id===d.id&&this.flow.clock()<d.until,'Review the payment again.');this.draft=null;
  const {state}=await this.flow.current();
  const id=hash({domain:SERIES,configHash:state.configHash,series:this.t.id,author:this.owner,command:d.command});
  const wire=envelope(this.flow.c,{type:EXCHANGE_ACTION,command:d.command,inputs:d.inputs,...(this.flow.programme?{programme:this.t.id}:{})},this.flow.wallet.key);
  this.db.prepare('INSERT OR IGNORE INTO backed_outbox VALUES(?,?,?,?)').run(this.flow.pin,id,JSON.stringify(wire),this.note(id,d.note));return this.retry({id});
 }
 async retry(q){
  exact(q,['id']);hex(q.id);const {state}=await this.flow.current(),r=this.db.prepare('SELECT wire FROM backed_outbox WHERE pin=? AND id=?').get(this.flow.pin,q.id);
  assert(r,'Unknown saved action.');const wire=JSON.parse(r.wire);assert.equal(wire.body.action.programme,this.flow.programme);const c=wire.body.action.command,o=state.backedSeries?.orders[c.id];
  if(!state.backedSeries?.receipts[q.id]&&!state.backedSeries?.marketReceipts?.[q.id]&&!(c.type==='SERIES_ACCEPT'&&o?.accepted>=c.accepted)&&!(c.type==='SERIES_REQUEST_CANCEL'&&o?.cancelRequested)&&!(c.type==='SERIES_CONFIRM_CANCEL'&&o?.closed)){
   const conflict=marketConflict(wire,state);if(conflict)return {id:q.id,status:conflict};
   await this.flow.wallet.broadcast(wire);
  }
  return {id:q.id,status:'Submitted. Checking DueByte confirmation.'};
 }
}
