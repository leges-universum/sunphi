// Conditional DUBYT leg, admitted only by explicitly pinned isolated genesis.
import assert from 'node:assert/strict';
import {hash,digest,hex,integer,publicKey,verify,exact} from '../crypto.mjs';
import {AuthenticatedRecordStore} from './authenticated-record-store.mjs';
import {EXCHANGE_V2,applyExchangeResolution,checkExchangePlan} from './exchange-resolution.mjs';
import {ETHEREUM_GENESIS,ETHEREUM_USDC} from './exchange-evm-networks.mjs';
export const EXCHANGE='DUEBYTE_CONDITIONAL_EXCHANGE_LAB_V1';
export const atomic=v=>{assert(typeof v==='string'&&/^(0|[1-9][0-9]{0,23})$/.test(v),'atomic integer string');return BigInt(v);};
export function exchangePolicy(p){
 exact(p,['domain','isolated','chain','provider','routes','minGap','maxDuration','observers']);
 assert([EXCHANGE,EXCHANGE_V2].includes(p.domain));assert.equal(p.isolated,true);assert(/^duebyte-exchange-lab-[a-z0-9-]+$/.test(p.chain),'isolated chain only');publicKey(p.provider);
 integer(p.minGap,60);integer(p.maxDuration,p.minGap*3);assert(p.maxDuration<=604800);
 assert(Array.isArray(p.observers)&&p.observers.length===3&&new Set(p.observers).size===3);for(const key of p.observers){publicKey(key);assert.notEqual(key,p.provider);}
 exact(p.routes,['BTC','USDC']);
 for(const [asset,r]of Object.entries(p.routes)){
  exact(r,['network','genesis','contract','decimals']);hex(r.genesis);
  if(asset==='USDC'&&r.network==='ethereum-mainnet'){
   // External evidence rehearsal only: the DueByte chain remains isolated.
   // Old V1 preimage settlement must never admit this route.
   assert.equal(p.domain,EXCHANGE_V2);assert.equal(r.genesis,ETHEREUM_GENESIS);assert.equal(r.contract,ETHEREUM_USDC);
   assert(p.minGap>=3600,'Ethereum evidence rehearsal requires a finality/recovery margin');
  }else assert.equal(r.network,asset==='BTC'?'bitcoin-regtest':'ethereum-local');
  assert.equal(r.decimals,asset==='BTC'?8:6);assert(asset==='BTC'?r.contract==='native':/^0x[a-f0-9]{40}$/.test(r.contract));
 }
}
export function checkExchangeQuote(p,q,now){
 exchangePolicy(p);exact(q,['domain','policyHash','chain','nonce','user','provider','direction','asset','dubytAtomic','externalAtomic','hashlock','createdAt','quoteUntil','dubytUntil','externalUntil','externalRecipient','externalRefund']);
 assert.equal(q.domain,p.domain+'/QUOTE');assert.equal(q.policyHash,hash(p));assert.equal(q.chain,p.chain);assert.equal(q.provider,p.provider);publicKey(q.user);assert.notEqual(q.user,q.provider);hex(q.nonce);hex(q.hashlock);
 assert(!p.observers.includes(q.user),'recipient cannot observe its own settlement');
 assert(['BUY_DUBYT','SELL_DUBYT'].includes(q.direction));assert(Object.hasOwn(p.routes,q.asset));assert(atomic(q.dubytAtomic)>0n&&atomic(q.externalAtomic)>0n);
 for(const x of ['createdAt','quoteUntil','dubytUntil','externalUntil'])integer(q[x],1);
 assert(q.createdAt<=now&&now<=q.quoteUntil,'quote expired');assert(q.quoteUntil>q.createdAt&&q.quoteUntil-q.createdAt<=300);
 const first=q.direction==='BUY_DUBYT'?q.externalUntil:q.dubytUntil,second=q.direction==='BUY_DUBYT'?q.dubytUntil:q.externalUntil;
 assert(second>=q.quoteUntil+p.minGap&&first>=second+p.minGap,'unsafe claim/refund deadlines');assert(first<=q.createdAt+p.maxDuration);
 for(const a of [q.externalRecipient,q.externalRefund])assert(typeof a==='string'&&(q.asset==='BTC'?/^bcrt1[ac-hj-np-z02-9]{8,87}$/.test(a):/^0x[a-f0-9]{40}$/.test(a)&&!/^0x0{40}$/.test(a)),'test address required');
 assert.notEqual(q.externalRecipient,q.externalRefund);
 return q;
}
export const exchangeAcceptance=q=>({domain:q.domain.replace(/\/QUOTE$/,'/ACCEPT'),id:hash(q)});
export function verifyExchangeFunding(p,q,receipt,now){
 exact(receipt,['body','signatures']);const b=receipt.body;exact(b,['domain','policyHash','order','asset','network','genesis','contract','transaction','block','escrow','amountAtomic','recipient','refundAddress','hashlock','refundAt','status','observedAt','expiresAt']);
 assert.equal(q.direction,'BUY_DUBYT');assert.equal(b.domain,EXCHANGE+'/FUNDING');assert.equal(b.policyHash,hash(p));assert.equal(b.order,hash(q));assert.equal(b.asset,q.asset);
 const route=p.routes[q.asset];for(const field of ['network','genesis','contract'])assert.equal(b[field],route[field]);hex(b.transaction);hex(b.block);
 assert(typeof b.escrow==='string'&&(q.asset==='BTC'?new RegExp('^'+b.transaction+':(0|[1-9][0-9]{0,5})$').test(b.escrow):new RegExp('^0x[a-f0-9]{40}:'+hash(q)+'$').test(b.escrow)),'exact funded escrow reference');
 assert.equal(b.amountAtomic,q.externalAtomic);assert.equal(b.recipient,q.externalRecipient);assert.equal(b.refundAddress,q.externalRefund);assert.equal(b.hashlock,q.hashlock);assert.equal(b.refundAt,q.externalUntil);assert.equal(b.status,'FUNDED');
 integer(b.observedAt,q.createdAt);integer(b.expiresAt,b.observedAt);assert(b.observedAt<=now&&now<=b.expiresAt&&b.expiresAt-b.observedAt<=300,'stale external funding');assert(now<q.dubytUntil&&now+p.minGap<=b.refundAt,'insufficient funding recovery window');
 assert(Array.isArray(receipt.signatures)&&receipt.signatures.length>=2&&receipt.signatures.length<=3);const seen=new Set();for(const s of receipt.signatures){exact(s,['observer','signature']);assert(p.observers.includes(s.observer)&&!seen.has(s.observer));assert(verify(b,s.signature,s.observer),'invalid funding signature');seen.add(s.observer);}
}
export function verifyExchangeSettlement(p,q,receipt,now){
 exact(receipt,['body','signatures']);const b=receipt.body;exact(b,['domain','policyHash','order','asset','network','transaction','block','amountAtomic','recipient','observedAt','expiresAt']);
 assert.equal(b.domain,EXCHANGE+'/SETTLEMENT');assert.equal(b.policyHash,hash(p));assert.equal(b.order,hash(q));assert.equal(b.asset,q.asset);assert.equal(b.network,p.routes[q.asset].network);hex(b.transaction);hex(b.block);
 assert.equal(b.amountAtomic,q.externalAtomic);assert.equal(b.recipient,q.externalRecipient);integer(b.observedAt,q.createdAt);integer(b.expiresAt,b.observedAt);assert(b.observedAt<=now&&now<=b.expiresAt&&b.expiresAt-b.observedAt<=300,'stale external settlement');
 assert(Array.isArray(receipt.signatures)&&receipt.signatures.length>=2&&receipt.signatures.length<=3);const seen=new Set();for(const s of receipt.signatures){exact(s,['observer','signature']);assert(p.observers.includes(s.observer)&&!seen.has(s.observer));assert(verify(b,s.signature,s.observer),'invalid settlement signature');seen.add(s.observer);}
}
export function exchangeGenesis(policy,balances){
 exchangePolicy(policy);assert(Object.keys(balances).length<=32);let total=0n;
 for(const [owner,n]of Object.entries(balances)){publicKey(owner);total+=atomic(n);}
 return {policy,balances:structuredClone(balances),total:String(total),time:0,orders:{},hashes:{}};
}
export function auditExchange(s){
 exchangePolicy(s.policy);let total=Object.values(s.balances).reduce((n,v)=>n+atomic(v),0n);
 assert(Object.keys(s.orders).length<=32);
 for(const [id,o]of Object.entries(s.orders)){assert.equal(id,hash(o.quote));assert(['LOCKED','CLAIMED','REFUNDED'].includes(o.status));assert.equal(s.hashes[o.quote.hashlock],id);total+=o.status==='LOCKED'?atomic(o.quote.dubytAtomic):0n;}
 assert.equal(String(total),s.total,'DUBYT conservation');
 if(s.policy.domain===EXCHANGE_V2)for(const o of Object.values(s.orders)){assert(Object.hasOwn(o,'plan'));if(o.plan)checkExchangePlan(o.quote,o.plan);if(o.status==='CLAIMED'||o.status==='REFUNDED'&&o.plan)hex(o.resolution);}
}
export function applyExchange(previous,command,now){
 if(previous.policy.domain===EXCHANGE_V2)return applyExchangeResolution(previous,command,now,{checkQuote:checkExchangeQuote,audit:auditExchange});
 integer(now,1);assert(now>=previous.time,'consensus clock regression');const s=structuredClone(previous);
 if(command.type==='LOCK'){
  exact(command,['type','quote','providerSignature','userSignature']);const q=command.quote,id=hash(q);
  // Exact retries survive expiry and do not relock an already settled order.
  assert(verify(q,command.providerSignature,s.policy.provider),'provider signature');assert(verify(exchangeAcceptance(q),command.userSignature,q.user),'user acceptance');
  if(s.orders[id])return previous;
  checkExchangeQuote(s.policy,q,now);assert(!s.hashes[q.hashlock],'one secret per order');assert(Object.keys(s.orders).length<32,'bounded lab capacity');
  const payer=q.direction==='BUY_DUBYT'?q.provider:q.user,n=atomic(q.dubytAtomic),balance=atomic(s.balances[payer]??'0');assert(balance>=n,'insufficient available DUBYT');
  s.balances[payer]=String(balance-n);s.orders[id]={quote:q,status:'LOCKED'};s.hashes[q.hashlock]=id;
 }else{
  assert(['CLAIM','REFUND'].includes(command.type));hex(command.id);const o=s.orders[command.id];assert(o,'unknown order');const q=o.quote;
  exact(command,command.type==='CLAIM'?(q.direction==='SELL_DUBYT'?['type','id','secret','settlement']:['type','id','secret','funding']):['type','id']);
  if(command.type==='CLAIM'){
   hex(command.secret);assert.equal(digest(Buffer.from(command.secret,'hex')),q.hashlock,'wrong preimage');
   if(o.status==='CLAIMED'){const proof=q.direction==='SELL_DUBYT'?'settlement':'funding';assert.equal(o[proof],hash(command[proof]));return previous;}assert.equal(o.status,'LOCKED');assert(now<q.dubytUntil,'claim deadline passed');
   // A reverted external transaction can expose the preimage without paying.
   // Require independently signed successful settlement, not preimage alone.
   if(q.direction==='SELL_DUBYT'){verifyExchangeSettlement(s.policy,q,command.settlement,now);o.settlement=hash(command.settlement);}
   else{verifyExchangeFunding(s.policy,q,command.funding,now);o.funding=hash(command.funding);}
   const receiver=q.direction==='BUY_DUBYT'?q.user:q.provider;s.balances[receiver]=String(atomic(s.balances[receiver]??'0')+atomic(q.dubytAtomic));o.status='CLAIMED';
   // Fixed recipient: relayers cannot redirect funds, even with the secret.
  }else{
   if(o.status==='REFUNDED')return previous;assert.equal(o.status,'LOCKED');assert(now>=q.dubytUntil,'refund too early');
   const payer=q.direction==='BUY_DUBYT'?q.provider:q.user;s.balances[payer]=String(atomic(s.balances[payer]??'0')+atomic(q.dubytAtomic));o.status='REFUNDED';
  }
 }
 s.time=now;auditExchange(s);return s;
}
export class ExchangeStore {
 static create(file,p,balances){return new this(AuthenticatedRecordStore.create(file,[['exchange/state',exchangeGenesis(p,balances)]]));}
 static open(file,root){return new this(new AuthenticatedRecordStore(file,root));}
 constructor(store){this.store=store;auditExchange(this.state);}
 get root(){return this.store.root;}
 get state(){return this.store.proof('exchange/state',this.root).value;}
 apply(command,now,options={}){return this.store.transact(this.root,{command,now},tx=>{tx.set('exchange/state',applyExchange(tx.get('exchange/state'),command,now));},options);}
 close(){this.store.close();}
}
