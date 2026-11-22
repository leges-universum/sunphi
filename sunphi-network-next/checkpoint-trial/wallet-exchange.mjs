// Local signing and a durable outbox for genesis-pinned isolated exchanges.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {exact,hash,hex,sign,verify} from './crypto.mjs';
import {envelope,stateHash} from './core.mjs';
import {parseToken,formatToken} from './token-units.mjs';
import {spendPolicy} from './spend-protection.mjs';
import {isBoundedWalletView,assertBoundedWalletView} from './research/bounded-wallet-view.mjs';
import {checkExchangeConfig,EXCHANGE_ACTION} from './research/exchange-native.mjs';
import {checkExchangeQuote,exchangeAcceptance} from './research/exchange-escrow.mjs';
import {EXCHANGE_V2,settlementAmounts} from './research/exchange-resolution.mjs';
import {askFundingInputs,askId,assertAskTerms} from './research/reserve-limit-asks.mjs';
import {reserveAsset,reserveSymbol,parseSettlement,displaySettlement} from './research/settlement-asset.mjs';
import {WalletTestLoan} from './wallet-test-loan.mjs';
import {WalletBackedSeries} from './wallet-backed-series.mjs';
import {programmes,selectProgramme,programmeView} from './research/reserve-portfolio.mjs';
import {economicActivity} from './wallet-economic-activity.mjs';
export const EXCHANGE_API='DUEBYTE_EXCHANGE_API_LAB_V1';
const done=o=>o&&['CLAIMED','REFUNDED'].includes(o.status);
const resolved=(row,state)=>done(state.exchangeBook?.orders[row.id])||(!state.exchangeBook?.orders[row.id]&&state.money.time>JSON.parse(row.offer).quote.quoteUntil);
const decimal=(value,places)=>{const s=String(value).padStart(places+1,'0'),fraction=s.slice(-places).replace(/0+$/,'');return s.slice(0,-places)+(fraction?'.'+fraction:'');};
export function exchangeLabTransport(profile,config){
 exact(profile,['configHash','url']);assert.equal(profile.configHash,hash(config));checkExchangeConfig(config);assert(config.exchangeLab);
 const u=new URL(profile.url);assert(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.pathname==='/'&&!u.username&&!u.password&&!u.search&&!u.hash,'isolated loopback exchange service required');
 return async message=>{const response=await fetch(u,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(message),signal:AbortSignal.timeout(15000)});assert(response.ok,'Exchange service unavailable. Check the saved order before retrying.');let size=0,parts=[];for await(const part of response.body){size+=part.length;assert(size<=32768,'exchange response budget');parts.push(part);}return JSON.parse(Buffer.concat(parts));};
}
export class WalletExchange{
 constructor(wallet,{request=null,clock=()=>Math.floor(Date.now()/1000)}={}){
  this.wallet=wallet;this.c=wallet.client.config;checkExchangeConfig(this.c);assert(this.c.exchangeLab,'Exchange is not activated.');this.p=this.c.exchangeLab.policy;this.request=request;this.clock=clock;this.closed=false;this.pending=new Map();
  this.pin=hash({config:hash(this.c),owner:wallet.key.publicKey});
  wallet.db.exec('CREATE TABLE IF NOT EXISTS exchange_outbox(pin TEXT NOT NULL,id TEXT NOT NULL,offer TEXT NOT NULL,wire TEXT,consent TEXT,PRIMARY KEY(pin,id))');
  if(this.p.reserve?.credit)this.loan=new WalletTestLoan(this);
  if(this.p.reserve?.series)this.series=new WalletBackedSeries(this);
  this.programmeSessions=new Map();
  if(this.p.reserve?.armAtLock)wallet.db.exec('CREATE TABLE IF NOT EXISTS exchange_ask_outbox(pin TEXT NOT NULL,id TEXT NOT NULL,wire TEXT NOT NULL,PRIMARY KEY(pin,id))');
 }
 async current(){assert(!this.closed,'Wallet locked.');const v=await this.wallet.view();assert(!this.closed,'Wallet locked.');const {state,certificate}=v;
  if(isBoundedWalletView(state))assertBoundedWalletView(state,certificate,this.c,this.wallet.key.publicKey);else assert.equal(stateHash(state,this.c),certificate.appHash,'unverified exchange state');
  assert.equal(state.height,certificate.appHeight);assert(Math.abs(this.clock()-state.money.time)<=120,'Fresh consensus state required.');return v;
 }
 rows(){return this.wallet.db.prepare('SELECT * FROM exchange_outbox WHERE pin=? ORDER BY id').all(this.pin);}
 activity(state){return economicActivity(this,state);}
 async remote(action,payload){assert(this.request,'Exchange service not connected.');const body={domain:EXCHANGE_API,configHash:hash(this.c),owner:this.wallet.key.publicKey,action,payload,nonce:randomBytes(32).toString('hex'),at:this.clock()};const r=await this.request({body,signature:sign(body,this.wallet.key.privateKey)});assert(!this.closed,'Wallet locked.');return r;}
 present(offer,order=null){const q=offer.quote,route=this.p.routes[q.asset];let settlement;
  if(this.p.reserve&&q.asset===reserveSymbol(this.p)){
   const amounts=settlementAmounts(this.p,q),buy=q.direction==='BUY_DUBYT';
   settlement={counterparty:q.provider===this.p.reserve.signer?'Network reserve':'Market operator',asset:q.asset,exchangeFee:displaySettlement(amounts.fee,route),externalTotal:displaySettlement(buy?amounts.debited:amounts.received,route),feeRecipient:this.p.reserve.feeWallet,escrow:this.p.reserve.escrow,...(this.p.reserve.settlement?{additionalCustomerFee:'0'}:{})};
  }
  return {...(settlement?{settlement}:{}),id:hash(q),isolated:true,direction:q.direction,asset:q.asset,dubyt:formatToken(q.dubytAtomic,'1000000'),external:displaySettlement(q.externalAtomic,route),network:this.p.routes[q.asset].network,recipient:q.externalRecipient,refundAddress:q.externalRefund,fee:formatToken(this.c.exchangeLab.feeMicro,'1000000'),feePayer:q.direction==='SELL_DUBYT'?'You':'Seller',expiresAt:q.quoteUntil,refundAt:q.dubytUntil,outcomeRequired:this.p.domain===EXCHANGE_V2,status:order?.status??'NOT_CONFIRMED',verified:!!order};}
 validateOffer(offer,now){exact(offer,['quote','providerSignature']);checkExchangeQuote(this.p,offer.quote,now);assert(verify(offer.quote,offer.providerSignature,offer.quote.provider),'Invalid seller signature.');assert.equal(offer.quote.user,this.wallet.key.publicKey,'Quote belongs to another wallet.');}
 funding(s,q){assert.equal(s.money.unitScale,'1000000');const owner=this.wallet.key.publicKey,policy=spendPolicy(s,owner);assert(!policy?.enabled&&!policy?.pending,'Separate exchange approval is not available for protected wallets.');const need=BigInt(q.dubytAtomic)+BigInt(this.c.exchangeLab.feeMicro),inputs=[];let sum=0n;
  const available=Object.entries(s.money.outputs).filter(([,o])=>o.owner===owner&&o.unlock<=s.money.time).sort(([a,x],[b,y])=>BigInt(x.value)===BigInt(y.value)?a.localeCompare(b):BigInt(x.value)>BigInt(y.value)?-1:1);
  for(const [id,o]of available){if(sum>=need||inputs.length===8)break;inputs.push(id);sum+=BigInt(o.value);}assert(sum>=need,'Insufficient available DUBYT including fee.');return inputs.sort();
 }
 async quote(q){exact(q,['direction','asset','amount','address']);assert(['BUY_DUBYT','SELL_DUBYT'].includes(q.direction));assert(Object.hasOwn(this.p.routes,q.asset));const dubytAtomic=parseToken(q.amount,'1000000');assert(BigInt(dubytAtomic)>0n);const offer=await this.remote('quote',{direction:q.direction,asset:q.asset,dubytAtomic,address:q.address});
  const o=offer.quote;assert.equal(o.direction,q.direction);assert.equal(o.asset,q.asset);assert.equal(o.dubytAtomic,dubytAtomic);assert.equal(o[q.direction==='BUY_DUBYT'?'externalRefund':'externalRecipient'],q.address,'Destination changed.');return this.review(offer);
 }
 async review(offer){const {state}=await this.current();this.validateOffer(offer,state.money.time);checkExchangeQuote(this.p,offer.quote,this.clock());
  for(const row of this.rows())assert(resolved(row,state),'Resolve your saved exchange before creating another.');
  if(offer.quote.direction==='SELL_DUBYT')this.funding(state,offer.quote);this.pending.clear();const review=randomBytes(32).toString('hex');this.pending.set(review,{offer:structuredClone(offer),until:this.clock()+120});return {...this.present(offer),review};
 }
 async confirm(q){exact(q,['id']);hex(q.id);const p=this.pending.get(q.id);this.pending.delete(q.id);assert(p&&this.clock()<p.until,'Review expired.');const {state}=await this.current();this.validateOffer(p.offer,state.money.time);checkExchangeQuote(this.p,p.offer.quote,this.clock());
  for(const row of this.rows())assert(resolved(row,state),'An exchange is already pending.');assert(this.rows().length<32,'Isolated exchange journal limit.');
  const quote=p.offer.quote,id=hash(quote),command={type:'LOCK',...p.offer,userSignature:sign(exchangeAcceptance(quote),this.wallet.key.privateKey)};
  const wire=quote.direction==='SELL_DUBYT'?envelope(this.c,{type:EXCHANGE_ACTION,command,inputs:this.funding(state,quote)},this.wallet.key):null;
  this.wallet.db.prepare('INSERT INTO exchange_outbox VALUES(?,?,?,?,?)').run(this.pin,id,JSON.stringify(p.offer),wire?JSON.stringify(wire):null,JSON.stringify(command));
  // Persist BEFORE network I/O. An ambiguous response must never create another order.
  return this.resume({id});
 }
 async resume(q){exact(q,['id']);hex(q.id);const row=this.rows().find(x=>x.id===q.id);assert(row,'Unknown saved exchange.');const {state}=await this.current(),order=state.exchangeBook?.orders[row.id],offer=JSON.parse(row.offer);if(order)return this.present(offer,order);
  if(state.money.time>offer.quote.quoteUntil)return {...this.present(offer),status:'EXPIRED_UNFUNDED',verified:true};
  checkExchangeQuote(this.p,offer.quote,state.money.time);checkExchangeQuote(this.p,offer.quote,this.clock());
  if(row.wire)await this.wallet.broadcast(JSON.parse(row.wire));else await this.remote('accept',JSON.parse(row.consent));
  // Mempool admission and seller replies are not proof of settlement.
  return {...this.present(offer),status:'SUBMITTED',verified:false};
 }
 async status(){const {state}=await this.current();return {isolated:true,orders:this.rows().map(row=>{const offer=JSON.parse(row.offer),o=state.exchangeBook?.orders[row.id];if(o)assert.deepEqual(o.quote,offer.quote);const awaitingOutcome=this.p.domain===EXCHANGE_V2&&o?.status==='LOCKED'&&!!o.plan;return {...this.present(offer,o),...(!o&&state.money.time>offer.quote.quoteUntil?{status:'EXPIRED_UNFUNDED',verified:true}:{}),awaitingOutcome,canRefund:o?.status==='LOCKED'&&!awaitingOutcome&&state.money.time>=o.quote.dubytUntil};})};}
 async refund(q){exact(q,['id']);hex(q.id);const row=this.rows().find(x=>x.id===q.id);assert(row);const {state}=await this.current(),o=state.exchangeBook?.orders[q.id];assert(o&&o.status==='LOCKED'&&state.money.time>=o.quote.dubytUntil,'Refund not yet available.');assert(this.p.domain!==EXCHANGE_V2||!o.plan,'Awaiting verified external outcome. DUBYT remain reserved.');await this.wallet.broadcast(envelope(this.c,{type:EXCHANGE_ACTION,command:{type:'REFUND',id:q.id},inputs:[]},this.wallet.key));return {id:q.id,status:'REFUND_SUBMITTED',verified:false};}
 async instrument(kind,method,q={}){
  const {programme,...input}=q;
  if(!this.p.reserve?.portfolio){assert(!programme);return (kind==='series'?this.series:this.loan)[method](input);}
  const options=programmes(this.p.reserve,kind).filter(t=>kind==='series'||t.borrower===this.wallet.key.publicKey);
  const term=options.find(t=>t.id===(programme??options[0]?.id));assert(term,'Programme unavailable for this wallet.');
  let session=this.programmeSessions.get(term.id);
  if(!session){
   const p=selectProgramme(this.p,kind,term.id);
   const flow={c:this.c,p,wallet:this.wallet,clock:this.clock,programme:term.id,
    pin:kind==='series'?this.pin:hash([this.pin,term.id]),
    current:async()=>{const v=await this.current();return {...v,state:programmeView(v.state,this.p,kind,term.id)};},
    remote:async()=>{throw Error('Waiting for a verified offer on DueByte.');}};
   session=kind==='series'?new WalletBackedSeries(flow):new WalletTestLoan(flow);
   this.programmeSessions.set(term.id,session);
  }
  const result=await session[method](input);
  if(method==='review')return {...result,summary:result.summary+' '+(kind==='series'?'Backed series ':'Loan ')+term.id.slice(0,12)+' · Custody '+term.vault+'.'};
  if(method==='status')return {...result,programme:term.id,programmes:options.map(t=>({id:t.id,label:(kind==='series'?t.settlement.symbol:this.p.reserve.settlement.symbol)+' · '+t.id.slice(0,12)}))};
  return result;
 }
 async loanStatus(q){return this.instrument('credit','status',q);}
 async reviewLoan(q){return this.instrument('credit','review',q);}
 async confirmLoan(q){return this.instrument('credit','confirm',q);}
 async retryLoan(q){return this.instrument('credit','retry',q);}
 async seriesStatus(q){return this.instrument('series','status',q);}
 async reviewSeries(q){return this.instrument('series','review',q);}
 async confirmSeries(q){return this.instrument('series','confirm',q);}
 async retrySeries(q){return this.instrument('series','retry',q);}
 async reviewAsk(request){
  assert(this.p.reserve?.armAtLock&&this.wallet.key.publicKey===this.p.provider,'Limit selling is unavailable for this wallet.');
  const {state}=await this.current(),owner=this.wallet.key.publicKey;
  let command,inputs=[],summary;
  if(request.cancel){
   exact(request,['cancel']);hex(request.cancel);const ask=state.exchangeBook?.asks?.[request.cancel];
   assert(ask?.maker===owner&&!ask.closed,'Sell order is already closed.');
   command={type:'CLOSE_ASK',id:request.cancel};summary='Cancel the sell order and release up to '+decimal(ask.remaining,6)+' DUBYT. A fill confirmed first keeps its allocation.';
  }else{
   exact(request,['amount','price','hours']);assert(Number.isInteger(request.hours)&&request.hours>=1&&request.hours<=168);
   const terms={nonce:randomBytes(32).toString('hex'),quantity:parseToken(request.amount,'1000000'),price:parseSettlement(request.price,reserveAsset(this.p)),expires:state.money.time+3600*request.hours};
   assertAskTerms(terms,state.money.time);const protection=spendPolicy(state,owner);assert(!protection?.enabled&&!protection?.pending,'Protected wallet requires separate consent.');
   const fee=BigInt(this.c.exchangeLab.feeMicro);inputs=askFundingInputs(state,owner,BigInt(terms.quantity)+fee);
   command={type:'PLACE_ASK',terms};
   summary='Reserve '+decimal(terms.quantity,6)+' DUBYT for up to '+request.hours+' hours at a minimum of '+displaySettlement(terms.price,reserveAsset(this.p))+' test '+reserveSymbol(this.p)+' per DUBYT. Partial fills are allowed. Placement fee: '+decimal(fee,6)+' DUBYT. Each fill costs the seller '+decimal(fee,6)+' DUBYT.';
  }
  const id=randomBytes(32).toString('hex');this.askDraft={id,command,inputs,until:this.clock()+120};
  return {id,summary};
 }
 async confirmAsk(request){
  exact(request,['id']);hex(request.id);const draft=this.askDraft;
  assert(draft&&request.id===draft.id&&this.clock()<draft.until,'Review the sell order again.');
  this.askDraft=null;await this.current();const wire=envelope(this.c,{type:EXCHANGE_ACTION,command:draft.command,inputs:draft.inputs},this.wallet.key);
  const id=draft.command.id??askId(hash(this.c),this.wallet.key.publicKey,draft.command.terms);
  this.wallet.db.prepare('INSERT INTO exchange_ask_outbox VALUES(?,?,?) ON CONFLICT(pin,id) DO UPDATE SET wire=excluded.wire').run(this.pin,id,JSON.stringify(wire));
  return this.retryAsk({id});
 }
 async retryAsk(request){
  exact(request,['id']);hex(request.id);assert(this.p.reserve?.armAtLock);
  const row=this.wallet.db.prepare('SELECT wire FROM exchange_ask_outbox WHERE pin=? AND id=?').get(this.pin,request.id);assert(row,'Unknown sell order.');
  const wire=JSON.parse(row.wire),cmd=wire.body.action.command,{state}=await this.current(),o=state.exchangeBook?.asks?.[request.id];
  if(o&&(cmd.type==='PLACE_ASK'||o.closed))return {id:request.id,status:o.closed?'Closed':'Open'};
  if(cmd.type==='PLACE_ASK')assertAskTerms(cmd.terms,state.money.time);
  await this.wallet.broadcast(wire);return {id:request.id,status:'Submitted. Waiting for network confirmation.'};
 }
 async asks(){
  assert(this.p.reserve?.armAtLock&&this.wallet.key.publicKey===this.p.provider);
  const {state}=await this.current();
  const rows=this.wallet.db.prepare('SELECT id,wire FROM exchange_ask_outbox WHERE pin=? ORDER BY id').all(this.pin);
  const local=new Map(rows.map(row=>[row.id,JSON.parse(row.wire).body.action.command]));
  const book=state.exchangeBook?.asks??{},ids=new Set([...Object.keys(book),...local.keys()]);
  return [...ids].map(id=>{
   const o=book[id],cmd=local.get(id),terms=o?.terms??cmd?.terms;
   const expired=terms.expires<=state.money.time,pending=(!o&&!expired)||(cmd?.type==='CLOSE_ASK'&&!o?.closed);
   return {id,asset:reserveSymbol(this.p),price:displaySettlement(terms.price,reserveAsset(this.p)),quantity:decimal(terms.quantity,6),remaining:decimal(o?.remaining??'0',6),allocated:decimal(o?.allocated??'0',6),released:decimal(o?.released??'0',6),expires:terms.expires,
    pending,canCancel:!!o&&!o.closed&&!pending,status:pending?'Awaiting network confirmation':o?.closed?'Closed':expired?(o?'Expired · release available':'Expired before confirmation'):'Open'};
  });
 }
 close(){this.closed=true;this.pending.clear();this.askDraft=null;}
}
