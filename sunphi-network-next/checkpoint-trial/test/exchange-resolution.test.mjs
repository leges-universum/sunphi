import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {resolutionFixture} from './helpers/exchange-resolution-fixture.mjs';
import {exchangeGenesis,applyExchange} from '../research/exchange-escrow.mjs';
import {BoundedNetworkInterpreter} from '../research/bounded-network-interpreter.mjs';
import {exchangeOutput} from '../research/exchange-native.mjs';
import {hash} from '../crypto.mjs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
const initial=(f,o)=>exchangeGenesis(f.p,{[o.payer.publicKey]:o.q.dubytAtomic});
for(const direction of ['BUY_DUBYT','SELL_DUBYT'])for(const asset of ['BTC','USDC']){
 test(direction+' '+asset+' paid then all observers unavailable beyond deadlines: hold and late payout once',()=>{
  const f=resolutionFixture(),o=f.order(direction,asset);let s=applyExchange(initial(f,o),o.lock,1000);s=applyExchange(s,o.arm,1010);const locked=structuredClone(s);
  assert.throws(()=>applyExchange(s,{type:'CLAIM',id:o.id,secret:o.secret},1020));assert.throws(()=>applyExchange(s,{type:'REFUND',id:o.id},5000),/outcome proof/);assert.deepEqual(s,locked);
  const cmd=o.resolve('PAYOUT',5000);s=applyExchange(s,cmd,5000);assert.equal(s.orders[o.id].status,'CLAIMED');assert.equal(s.balances[direction==='BUY_DUBYT'?f.user.publicKey:f.provider.publicKey],o.q.dubytAtomic);
  assert.equal(applyExchange(s,o.resolve('PAYOUT',5100),5100),s);assert.throws(()=>applyExchange(s,o.resolve('REFUND',5100),5100),/conflicting/);assert.throws(()=>applyExchange(s,{type:'REFUND',id:o.id},5100));
 });
 test(direction+' '+asset+' refund requires actual terminal evidence, survives native restart and replay',()=>{
  const f=resolutionFixture(),o=f.order(direction,asset),dir=fs.mkdtempSync(join(tmpdir(),'exchange-resolution-')),file=dir+'/state.sqlite';let db=BoundedNetworkInterpreter.create(file,f.s,f.c,hash(f.s));
  const step=(command,time,inputs=[])=>db.commitBlock({height:db.networkHeader().height+1,time,blockHash:hash([time,command]),txs:[f.wire(command,inputs,o.payer)]},db.root);
  try{step(o.lock,1000,[o.input]);step(o.arm,1010);const held=db.root;assert.throws(()=>step({type:'REFUND',id:o.id},5000));assert.equal(db.root,held);db.close();db=BoundedNetworkInterpreter.open(file,f.c,held);
   step(o.resolve('REFUND',5000),5000);const after=db.snapshotForAudit();assert.equal(after.exchangeBook.orders[o.id].status,'REFUNDED');assert.equal(after.money.outputs[exchangeOutput(hash(f.c),o.id,'settlement')].owner,o.payer.publicKey);assert.equal(after.money.fees,'1000');assert.equal(after.money.supply,'200000000');
   step(o.resolve('REFUND',5100),5100);assert.deepEqual(db.snapshotForAudit().money.outputs,after.money.outputs);assert.throws(()=>step(o.resolve('PAYOUT',5200),5200));
  }finally{db.close();}
 });
}

for(const direction of ['BUY_DUBYT','SELL_DUBYT'])for(const asset of ['BTC','USDC'])test(direction+' '+asset+' permanent unfunded cancellation releases once and excludes payment',()=>{
 const f=resolutionFixture(),o=f.order(direction,asset);let s=applyExchange(initial(f,o),o.lock,1000);s=applyExchange(s,o.arm,1010);
 const c=o.resolve('CANCELLED',5000);s=applyExchange(s,c,5000);assert.equal(s.orders[o.id].status,'REFUNDED');assert.equal(s.balances[o.payer.publicKey],o.q.dubytAtomic);assert.equal(s.total,o.q.dubytAtomic);
 assert.equal(applyExchange(s,o.resolve('CANCELLED',5100),5100),s);for(const kind of ['PAYOUT','REFUND'])assert.throws(()=>applyExchange(s,o.resolve(kind,5100),5100),/conflicting|different terminal/);
});
test('unarmed cancellation and ARM race; never-funded armed order remains held',()=>{
 const f=resolutionFixture(),o=f.order();let s=applyExchange(initial(f,o),o.lock,1000);
 const cancelled=applyExchange(s,{type:'REFUND',id:o.id},o.q.dubytUntil);assert.throws(()=>applyExchange(cancelled,o.arm,o.q.dubytUntil));
 s=applyExchange(s,o.arm,1010);assert.throws(()=>applyExchange(s,{type:'REFUND',id:o.id},10000000));const changed=structuredClone(o.plan);changed.index=1;assert.throws(()=>applyExchange(s,f.arm(o.q,changed),1020),/fixed/);
});
test('resolution rejects forged, missing, duplicate, stale and mismatched evidence without changes',()=>{
 const f=resolutionFixture(),o=f.order('SELL_DUBYT','USDC');let s=applyExchange(initial(f,o),o.lock,1000);s=applyExchange(s,o.arm,1010);const original=structuredClone(s);
 for(const field of ['policyHash','order','planHash','asset','network','genesis','contract','escrow','amountAtomic','recipient','refundAddress','status']){const cmd=o.resolve();cmd.receipt.body[field]='wrong';cmd.receipt=f.signReceipt(cmd.receipt.body);assert.throws(()=>applyExchange(s,cmd,2000),field);}
 for(const mutate of [r=>r.signatures.splice(1),r=>r.signatures[1]=r.signatures[0],r=>r.signatures[0].signature='00'.repeat(64),r=>r.body.expiresAt=1999]){const cmd=o.resolve();mutate(cmd.receipt);assert.throws(()=>applyExchange(s,cmd,2000));}
 assert.throws(()=>applyExchange(s,o.resolve('PAYOUT',2000),2200),/fresh/);assert.deepEqual(s,original);
});
test('only the exact plan signed by both parties can arm',()=>{const f=resolutionFixture(),o=f.order(),s=applyExchange(initial(f,o),o.lock,1000),bad=structuredClone(o.arm);bad.plan.index=1;assert.throws(()=>applyExchange(s,bad,1010));assert.equal(s.orders[o.id].plan,null);});
test('Bitcoin payout after refund time still resolves, USDC expired claim is rejected',()=>{for(const asset of ['BTC','USDC']){const f=resolutionFixture(),o=f.order('SELL_DUBYT',asset);let s=applyExchange(initial(f,o),o.lock,1000);s=applyExchange(s,o.arm,1010);const c=o.resolve();c.receipt.body.executedAt=o.q.externalUntil+1;c.receipt=f.signReceipt(c.receipt.body);if(asset==='BTC')assert.equal(applyExchange(s,c,2000).orders[o.id].status,'CLAIMED');else assert.throws(()=>applyExchange(s,c,2000),/deadline/);}});
