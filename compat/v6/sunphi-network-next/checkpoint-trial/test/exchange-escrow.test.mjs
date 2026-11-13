import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {keys,hash,digest,sign} from '../crypto.mjs';
import {EXCHANGE,exchangeGenesis,exchangeAcceptance,applyExchange,ExchangeStore} from '../research/exchange-escrow.mjs';
import {fundingFixture} from './helpers/exchange-funding-fixture.mjs';
function fixture(direction='BUY_DUBYT',asset='BTC'){
 const observers=[keys(),keys(),keys()];
 const provider=keys(),user=keys(),secret='ab'.repeat(32),p={domain:EXCHANGE,isolated:true,chain:'duebyte-exchange-lab-unit',provider:provider.publicKey,minGap:300,maxDuration:86400,routes:{BTC:{network:'bitcoin-regtest',genesis:'1'.repeat(64),contract:'native',decimals:8},USDC:{network:'ethereum-local',genesis:'2'.repeat(64),contract:'0x'+'3'.repeat(40),decimals:6}}};
 const q={domain:EXCHANGE+'/QUOTE',policyHash:hash(p),chain:p.chain,nonce:'4'.repeat(64),provider:provider.publicKey,user:user.publicKey,direction,asset,dubytAtomic:'10000001',externalAtomic:'123456',hashlock:digest(Buffer.from(secret,'hex')),createdAt:1000,quoteUntil:1100,dubytUntil:direction==='BUY_DUBYT'?1700:2200,externalUntil:direction==='BUY_DUBYT'?2200:1700,externalRecipient:asset==='BTC'?'bcrt1q'+'q'.repeat(40):'0x'+'4'.repeat(40),externalRefund:asset==='BTC'?'bcrt1q'+'p'.repeat(40):'0x'+'5'.repeat(40)};
 p.observers=observers.map(k=>k.publicKey);q.policyHash=hash(p);
 const body={domain:EXCHANGE+'/SETTLEMENT',policyHash:hash(p),order:hash(q),asset,network:p.routes[asset].network,transaction:'8'.repeat(64),block:'9'.repeat(64),amountAtomic:q.externalAtomic,recipient:q.externalRecipient,observedAt:1200,expiresAt:1400};
 const settlement={body,signatures:observers.slice(0,2).map(k=>({observer:k.publicKey,signature:sign(body,k.privateKey)}))};
 const claim={type:'CLAIM',id:hash(q),secret,...(direction==='SELL_DUBYT'?{settlement}:{funding:fundingFixture(p,q,observers,1200)})};
 const lock=()=>({type:'LOCK',quote:q,providerSignature:sign(q,provider.privateKey),userSignature:sign(exchangeAcceptance(q),user.privateKey)}),balances={[provider.publicKey]:'50000000',[user.publicKey]:'50000000'};
 return {provider,user,secret,p,q,lock,claim,settlement,observers,balances,state:exchangeGenesis(p,balances)};
}
for(const direction of ['BUY_DUBYT','SELL_DUBYT'])for(const asset of ['BTC','USDC'])test(direction+' '+asset+' preserves fractional balances, fixed recipient and retry',()=>{
 const f=fixture(direction,asset),id=hash(f.q),s=applyExchange(f.state,f.lock(),1000),payer=direction==='BUY_DUBYT'?f.provider:f.user,recipient=direction==='BUY_DUBYT'?f.user:f.provider;
 assert.equal(s.balances[payer.publicKey],'39999999');assert.throws(()=>applyExchange(s,{type:'CLAIM',id,secret:'cd'.repeat(32)},1200));
 const c=f.claim,end=applyExchange(s,c,1200);assert.equal(end.balances[recipient.publicKey],'60000001');assert.deepEqual(applyExchange(end,c,2400),end);assert.deepEqual(applyExchange(end,f.lock(),2400),end);assert.throws(()=>applyExchange(end,{type:'REFUND',id},2400));
 assert.throws(()=>applyExchange(s,{...c,recipient:f.provider.publicKey},1200));
});
test('expiry refunds payer once; wrong chain, terms, deadlines and signatures rejected',()=>{
 const f=fixture(),id=hash(f.q),s=applyExchange(f.state,f.lock(),1000);assert.throws(()=>applyExchange(s,{type:'REFUND',id},1699));const end=applyExchange(s,{type:'REFUND',id},1700);assert.deepEqual(end.balances,f.balances);assert.deepEqual(applyExchange(end,{type:'REFUND',id},1800),end);assert.throws(()=>applyExchange(end,{type:'CLAIM',id,secret:f.secret},1800));
 for(const patch of [{chain:'duebyte-live'},{dubytAtomic:'50000001'},{dubytAtomic:'1.5'},{externalUntil:1800},{quoteUntil:900}]){const x=fixture();Object.assign(x.q,patch);assert.throws(()=>applyExchange(x.state,x.lock(),1000));}
 const bad=f.lock();bad.quote.externalAtomic='1';assert.throws(()=>applyExchange(f.state,bad,1000));assert.throws(()=>applyExchange(s,f.lock(),999));
});
test('reuse of hashlock and concurrent overspend rejected',()=>{
 const f=fixture(),s=applyExchange(f.state,f.lock(),1000);f.q.nonce='6'.repeat(64);assert.throws(()=>applyExchange(s,f.lock(),1001));f.q.hashlock='7'.repeat(64);f.q.dubytAtomic='40000000';assert.throws(()=>applyExchange(s,f.lock(),1001));
});
test('persistent independent replay, reopen and stale-root rejection',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'exchange-escrow-')),f=fixture('SELL_DUBYT','USDC');let a,b;
 try{a=ExchangeStore.create(path.join(dir,'a'),f.p,f.balances);b=ExchangeStore.create(path.join(dir,'b'),f.p,f.balances);const old=a.root,commands=[[f.lock(),1000],[f.claim,1200]];for(const [c,t]of commands){a.apply(c,t);b.apply(c,t);assert.equal(a.root,b.root);}const root=a.root;a.close();a=null;assert.throws(()=>ExchangeStore.open(path.join(dir,'a'),old));a=ExchangeStore.open(path.join(dir,'a'),root);assert.equal(a.state.orders[hash(f.q)].status,'CLAIMED');}finally{a?.close();b?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('leaked preimage from reverted external payment cannot collect DUBYT',()=>{
 const f=fixture('SELL_DUBYT','USDC'),s=applyExchange(f.state,f.lock(),1000);
 assert.throws(()=>applyExchange(s,{type:'CLAIM',id:hash(f.q),secret:f.secret},1200));
 for(const mutate of [r=>r.signatures.pop(),r=>r.signatures[1]=r.signatures[0],r=>r.body.recipient=f.q.externalRefund,r=>r.body.amountAtomic='1',r=>r.body.order='a'.repeat(64)]){const c=structuredClone(f.claim);mutate(c.settlement);assert.throws(()=>applyExchange(s,c,1200));}
 assert.throws(()=>applyExchange(s,f.claim,1401));assert.equal(applyExchange(s,f.claim,1200).orders[hash(f.q)].status,'CLAIMED');
});
test('buyer secret without exact quorum-attested external funding cannot collect inventory',()=>{
 for(const asset of ['BTC','USDC']){
  const f=fixture('BUY_DUBYT',asset),s=applyExchange(f.state,f.lock(),1000);
  assert.throws(()=>applyExchange(s,{type:'CLAIM',id:hash(f.q),secret:f.secret},1200));
  for(const patch of [{amountAtomic:'1'},{recipient:f.q.externalRefund},{refundAddress:f.q.externalRecipient},{refundAt:f.q.dubytUntil},{hashlock:'e'.repeat(64)},{genesis:'a'.repeat(64)},{contract:'wrong'},{status:'REFUNDED'},{order:'b'.repeat(64)},{escrow:'unrelated'}]){
   const c=structuredClone(f.claim);Object.assign(c.funding.body,patch);c.funding.signatures=f.observers.slice(0,2).map(k=>({observer:k.publicKey,signature:sign(c.funding.body,k.privateKey)}));assert.throws(()=>applyExchange(s,c,1200));
  }
  for(const mutate of [r=>r.signatures.pop(),r=>r.signatures[1]=r.signatures[0],r=>r.body.block='f'.repeat(64)]){const c=structuredClone(f.claim);mutate(c.funding);assert.throws(()=>applyExchange(s,c,1200));}
  assert.throws(()=>applyExchange(s,f.claim,1381));assert.equal(applyExchange(s,f.claim,1200).orders[hash(f.q)].status,'CLAIMED');assert.equal(s.orders[hash(f.q)].status,'LOCKED');
 }
});
