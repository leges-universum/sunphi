import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {hash,sign,keys} from '../crypto.mjs';
import {nativeFixture} from './helpers/purchase-native-fixture.mjs';
import {PurchaseBroker,servePurchaseBroker,API_DOMAIN} from '../research/purchase-api.mjs';
import {WalletPurchase} from '../wallet-protected-purchase.mjs';
import {RefundOutbox} from '../research/purchase-refund-worker.mjs';
import {sealPurchaseCustody,openPurchaseCustody,writePurchaseCustody} from '../research/purchase-custody.mjs';
const directory=()=>fs.mkdtempSync(join(tmpdir(),'purchase-api-custody-'));
test('authenticated API, seller/buyer binding, lost reply and wallet restart preserve one order',async()=>{
 const dir=directory(),now=Math.floor(Date.now()/1000),f=nativeFixture(now),orders=new Map();let prepared=0,submitted=0,lose=true;
 const args={file:join(dir,'seller.sqlite'),config:f.c,clock:()=>now,
  quote:async p=>{const q=f.reserve({...p,payAtomic:'10000',feeAtomic:'100',destination:'bcrt1qsellerdestination'},now);return {offer:q.offer,sellerSignature:q.sellerSignature};},
  prepare:async command=>{prepared++;return Buffer.from(JSON.stringify(command));},
  submit:async wire=>{submitted++;const q=JSON.parse(wire),id=hash(q.offer);orders.set(id,{offer:q.offer,status:'AWAITING_PAYMENT'});if(lose){lose=false;throw Error('lost response');}},proof:async id=>orders.get(id)};
 let broker=new PurchaseBroker(args),server=await servePurchaseBroker(broker);
 const reader=()=>({configHash:hash(f.c),policy:f.policy,read:(p,id)=>{assert.equal(hash(p.offer),id);return p;},close(){}});
 const options=()=>({file:join(dir,'wallet.sqlite'),config:f.c,key:f.buyer,reader:reader(),url:server.url,clock:()=>now});let wallet=new WalletPurchase(options());
 const body={domain:API_DOMAIN,configHash:hash(f.c),buyer:f.buyer.publicKey,action:'quote',payload:{dubytMicro:'10000000',route:'BTC',refundDestination:'bcrt1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'},nonce:hash('request'),at:now};
 try{
  await assert.rejects(()=>broker.handle({body,signature:sign(body,f.seller.privateKey)}));
  const wrong={...body,configHash:hash('other')};await assert.rejects(()=>broker.handle({body:wrong,signature:sign(wrong,f.buyer.privateKey)}));
  const quote=await wallet.handle('quote',{amount:'10',route:'BTC',refundDestination:body.payload.refundDestination});assert(!quote.destination);
  const outsider=keys(),foreign={...body,buyer:outsider.publicKey,action:'order',payload:{id:quote.id}};await assert.rejects(()=>broker.handle({body:foreign,signature:sign(foreign,outsider.privateKey)}),/unknown buyer/);
  assert.throws(()=>new WalletPurchase(options()),/locked/);
  await assert.rejects(()=>wallet.handle('accept',{id:quote.id}));assert.equal(prepared,1);assert.equal(orders.size,1);
  wallet.close();await server.close();broker.close();broker=new PurchaseBroker(args);server=await servePurchaseBroker(broker);wallet=new WalletPurchase(options());
  const availability=await wallet.handle('availability',{});assert.equal(availability.activeOrder.id,quote.id);assert.equal(availability.activeOrder.destination,'bcrt1qsellerdestination');assert.equal(prepared,1);assert.equal(submitted,1);
  await wallet.handle('accept',{id:quote.id});assert.equal(prepared,1);assert.equal(orders.size,1);
  await assert.rejects(()=>wallet.handle('quote',{amount:'1',route:'BTC',refundDestination:body.payload.refundDestination}),/existing purchase/);
  assert.throws(()=>new PurchaseBroker(args),/locked/);
 }finally{wallet.close();await server.close();broker.close();}
});
test('wallet rejects altered seller terms and does not publish a late response after locking',async()=>{
 const dir=directory(),now=Math.floor(Date.now()/1000),f=nativeFixture(now);let release,started,alter=true;
 const gate=new Promise(r=>release=r),began=new Promise(r=>started=r);
 const broker=new PurchaseBroker({file:join(dir,'seller.sqlite'),config:f.c,clock:()=>now,quote:async p=>{started();await gate;const q=f.reserve({...p,dubytMicro:alter?'20000000':p.dubytMicro},now);return {offer:q.offer,sellerSignature:q.sellerSignature};}}),server=await servePurchaseBroker(broker);
 let closes=0;const reader={configHash:hash(f.c),policy:f.policy,close(){closes++;}},args={file:join(dir,'wallet.sqlite'),config:f.c,key:f.buyer,reader,url:server.url,clock:()=>now};let wallet=new WalletPurchase(args);
 const input={amount:'10',route:'USDC',refundDestination:'0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'};
 try{
  const first=wallet.handle('quote',input);await began;await assert.rejects(()=>wallet.handle('quote',input),/busy/);wallet.close();release();await assert.rejects(()=>first);assert.equal(closes,1);
  wallet=new WalletPurchase(args);await assert.rejects(()=>wallet.handle('quote',input));assert.equal(wallet.db.prepare('SELECT count(*) AS n FROM purchases').get().n,0);
  alter=false;const quote=await wallet.handle('quote',input);assert.equal(quote.dubyt,'10');assert(!quote.destination);assert.equal(quote.refundDestination,input.refundDestination.toLowerCase());
 }finally{release();wallet.close();await server.close();broker.close();}
});
test('live config cannot enable purchase API; custody corruption and stale backup fail closed',async()=>{
 const dir=directory(),f=nativeFixture(1000),configHash=hash(f.c),policyHash=hash(f.policy),password='test-only-password-never-operational';
 assert.throws(()=>new PurchaseBroker({file:join(dir,'live.sqlite'),config:{chainId:'live'}}),/disabled/);
 let state=f.genesis(),q=f.reserve();state=f.apply(state,q,1000);state=f.apply(state,f.evidence(q,{amountAtomic:'5000'}),1010);
 const order=state.orders[hash(q.offer)];order.refundIntent=f.refundIntent(order,1011).body;const txid=hash('refund');let prepared=0,known=false,broadcast=0;
 const adapter={async prepare(){prepared++;return {raw:'aabb',txid};},async inspect(){return {txid,destination:q.offer.refundDestination,amountAtomic:'5000',network:'bitcoin-regtest',asset:'native'};},async known(){return known;},async broadcast(){known=true;broadcast++;throw Error('lost reply');}};
 const box=new RefundOutbox(join(dir,'outbox.sqlite')),args={configHash,policy:f.policy,order,adapter};
 const stale=box.snapshot(configHash);await assert.rejects(()=>box.execute(args),/lost reply/);const snapshot=box.snapshot(configHash);
 const input={configHash,policyHash,secrets:[{name:'test-signer',kind:'ed25519-private-key',data:Buffer.from(f.seller.privateKey).toString('base64')}],outbox:snapshot};
 const bundle=sealPurchaseCustody(input,password),file=join(dir,'custody.json');writePurchaseCustody(file,bundle);assert(!fs.readFileSync(file,'utf8').includes(f.seller.privateKey));assert.throws(()=>writePurchaseCustody(file,bundle));
 assert.throws(()=>openPurchaseCustody(bundle,'incorrect-password-value',{configHash,policyHash}));
 const damaged={...bundle,tag:'0'.repeat(32)};assert.throws(()=>openPurchaseCustody(damaged,password,{configHash,policyHash}));assert.throws(()=>openPurchaseCustody(bundle,password,{configHash:hash('other'),policyHash}));
 box.close();const restored=new RefundOutbox(join(dir,'restored.sqlite')),old=new RefundOutbox(join(dir,'stale.sqlite'));
 try{restored.restore(openPurchaseCustody(bundle,password,{configHash,policyHash}).outbox,configHash);assert.equal((await restored.execute(args)).txid,txid);assert.equal(prepared,1);assert.equal(broadcast,1);
  old.restore(stale,configHash);await assert.rejects(()=>old.execute(args),/reconciliation/);assert.equal(prepared,1);assert.throws(()=>restored.restore(snapshot,configHash),/empty/);
 }finally{restored.close();old.close();}
});
