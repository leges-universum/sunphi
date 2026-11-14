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
import {EXCHANGE_V2} from './research/exchange-resolution.mjs';
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
 }
 async current(){assert(!this.closed,'Wallet locked.');const v=await this.wallet.view();assert(!this.closed,'Wallet locked.');const {state,certificate}=v;
  if(isBoundedWalletView(state))assertBoundedWalletView(state,certificate,this.c,this.wallet.key.publicKey);else assert.equal(stateHash(state,this.c),certificate.appHash,'unverified exchange state');
  assert.equal(state.height,certificate.appHeight);assert(Math.abs(this.clock()-state.money.time)<=120,'Fresh consensus state required.');return v;
 }
 rows(){return this.wallet.db.prepare('SELECT * FROM exchange_outbox WHERE pin=? ORDER BY id').all(this.pin);}
 async remote(action,payload){assert(this.request,'Exchange service not connected.');const body={domain:EXCHANGE_API,configHash:hash(this.c),owner:this.wallet.key.publicKey,action,payload,nonce:randomBytes(32).toString('hex'),at:this.clock()};const r=await this.request({body,signature:sign(body,this.wallet.key.privateKey)});assert(!this.closed,'Wallet locked.');return r;}
 present(offer,order=null){const q=offer.quote;return {id:hash(q),isolated:true,direction:q.direction,asset:q.asset,dubyt:formatToken(q.dubytAtomic,'1000000'),external:decimal(q.externalAtomic,this.p.routes[q.asset].decimals),network:this.p.routes[q.asset].network,recipient:q.externalRecipient,refundAddress:q.externalRefund,fee:formatToken(this.c.exchangeLab.feeMicro,'1000000'),feePayer:q.direction==='SELL_DUBYT'?'You':'Seller',expiresAt:q.quoteUntil,refundAt:q.dubytUntil,outcomeRequired:this.p.domain===EXCHANGE_V2,status:order?.status??'NOT_CONFIRMED',verified:!!order};}
 validateOffer(offer,now){exact(offer,['quote','providerSignature']);checkExchangeQuote(this.p,offer.quote,now);assert(verify(offer.quote,offer.providerSignature,this.p.provider),'Invalid seller signature.');assert.equal(offer.quote.user,this.wallet.key.publicKey,'Quote belongs to another wallet.');}
 funding(s,q){assert.equal(s.money.unitScale,'1000000');const owner=this.wallet.key.publicKey,policy=spendPolicy(s,owner);assert(!policy?.enabled&&!policy?.pending,'Separate exchange approval is not available for protected wallets.');const need=BigInt(q.dubytAtomic)+BigInt(this.c.exchangeLab.feeMicro),inputs=[];let sum=0n;
  const available=Object.entries(s.money.outputs).filter(([,o])=>o.owner===owner&&o.unlock<=s.money.time).sort(([a,x],[b,y])=>BigInt(x.value)===BigInt(y.value)?a.localeCompare(b):BigInt(x.value)>BigInt(y.value)?-1:1);
  for(const [id,o]of available){if(sum>=need||inputs.length===8)break;inputs.push(id);sum+=BigInt(o.value);}assert(sum>=need,'Insufficient available DUBYT including fee.');return inputs.sort();
 }
 async quote(q){exact(q,['direction','asset','amount','address']);assert(['BUY_DUBYT','SELL_DUBYT'].includes(q.direction));assert(['BTC','USDC'].includes(q.asset));const dubytAtomic=parseToken(q.amount,'1000000');assert(BigInt(dubytAtomic)>0n);const offer=await this.remote('quote',{direction:q.direction,asset:q.asset,dubytAtomic,address:q.address});
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
 close(){this.closed=true;this.pending.clear();}
}
