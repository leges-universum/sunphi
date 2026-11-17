import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setup} from './payment-liability.test.mjs';
import {Wallet,balances,outgoingStatus} from '../wallet.mjs';
import {paymentQuote,validatePaymentReview,paymentAmounts,monetaryAnalytics} from '../wallet-amounts.mjs';
import {previewTokenPrecision} from '../precision-preview.mjs';
import {hash,keys,sign} from '../crypto.mjs';
import {stateHash} from '../core.mjs';
import {REWARDS,walletConsent,rewardSummary,auditRewards} from '../node-rewards.mjs';
import {Store} from '../store.mjs';
import {feeFor,releaseFeeFor,validateIntentShape} from '../payment-model.mjs';
import {CONTROL,DELAYED_FEATURE} from '../authority.mjs';

const review=(s,value,recipient)=>{const q=paymentQuote(s,value,String(s.money.unitScale??'1'));return {recipient,value,unitScale:q.unitScale,fee:q.fee,abortFee:q.abortFee};};
function walletAt(x,getState,home=mkdtempSync(join(tmpdir(),'duebyte-fraction-wallet-'))){return new Wallet({client:{config:x.c,sync:async()=>{const state=getState();return {state,certificate:{appHeight:state.height,appHash:stateHash(state,x.c)}};}},key:x.f.alice,home,routes:Object.fromEntries(Object.keys(x.c.initial.nodes).map(id=>[id,'http://127.0.0.1:1'])),url:'http://127.0.0.1:1',checkpoint:{}});}
const saved=(w,pid)=>JSON.parse(w.db.prepare('SELECT body FROM outgoing WHERE pid=?').get(pid).body);
function enableFees(x,state,extra={}){
 const body={domain:REWARDS+'/ENABLE_NODE_REWARDS_V1',network:x.c.chainId,configHash:state.configHash,generation:state.authority.generation,notBefore:state.height+1,expires:state.height+2,activation:state.height+4,coefficients:{version:1,periodBlocks:10,workerWeight:1,witnessWeight:1,alphaPPM:0,periodMintLimit:'0',lifetimeMintLimit:'0',workMeasure:'payment_value_v2',...extra},allowedPeers:[]};
 let s=x.run(state,[x.wire({type:'ENABLE_NODE_REWARDS_V1',certificate:{body,approvals:x.approvals(body)}})]);while(s.height<body.activation)s=x.run(s);return s;
}
function bind(x,s,node,wallets){const manager=x.key(node),body={domain:REWARDS+'/BIND',configHash:s.configHash,node,sequence:1,payouts:wallets.map(k=>({wallet:k.publicKey,weight:1}))};return x.run(s,[x.wire({type:'BIND_REWARD_WALLETS_V1',body,signature:sign(body,manager.privateKey),consents:wallets.map(k=>sign(walletConsent(s.configHash,node,k.publicKey),k.privateKey))},manager)]);}

test('API quotes are exact, bounded, scale-bound and never use floating point',()=>{
 const x=setup(),s=previewTokenPrecision(x.s).state;
 for(const [input,value,fee,release] of [['0.000001','1','1','1'],['0.000034','34','2','2'],['1.234567','1234567','37038','37038'],['33.333334','33333334','1000001','1000000'],['9007199254.740993','9007199254740993','270215977642230','1000000']]){
  const q=paymentQuote(s,input,'1000000');assert.equal(q.value,value);assert.equal(q.fee,fee);assert.equal(q.abortFee,release);assert.equal(BigInt(q.total),BigInt(value)+BigInt(fee));assert.equal(q.display.value,input);
 }
 assert.equal(paymentQuote(x.s,'1').fee,'1');assert.throws(()=>paymentQuote(x.s,'1.2'),/precision/);
 for(const value of ['0','-1','1e3','1,2','01','NaN','0.0000001',' 1','1 ','1.','9'.repeat(100),1,0.1,'18446744073709.551615'])assert.throws(()=>paymentQuote(s,value,'1000000'));
 const q=review(s,'1.234567',x.f.bob.publicKey);assert.equal(validatePaymentReview(s,q).total,'1271605');
 for(const change of [{unitScale:'1'},{fee:'1'},{abortFee:'1'},{fee:37038},{unitScale:1000000}])assert.throws(()=>validatePaymentReview(s,{...q,...change}));
 assert.throws(()=>validatePaymentReview(s,{recipient:q.recipient,value:'1'}),/units changed/);
});

test('wallet signs reviewed decimal amounts only after rechecking verified denomination',async()=>{
 const x=setup();let s=x.s;const w=walletAt(x,()=>s);
 try{
  const q={recipient:x.f.bob.publicKey,value:'1',unitScale:'1'};s=previewTokenPrecision(s).state;
  await assert.rejects(()=>w.prepareTokens(q),/units changed/);assert.equal(w.db.prepare('SELECT count(*) n FROM outgoing').get().n,0);
  const p=await w.prepareTokens(review(s,'1.234567',x.f.bob.publicKey)),wire=saved(w,p.pid),i=wire.body.action.signed.intent;
  assert.equal(i.value,'1234567');assert.equal(i.fee,'37038');assert.equal(i.abortFee,'37038');assert.equal(i.unitScale,'1000000');validateIntentShape(i);
  assert.throws(()=>validateIntentShape({...i,abortFee:'1'}),/release fee/);
  s=x.run(s,[wire]);s=x.run(s,[x.finish(s,i)]);assert.equal(balances(s,x.f.bob.publicKey).available,'1234567');assert.equal(s.money.fees,'37038');stateHash(s,x.c);
 }finally{w.close();}
});

test('old and new payment history retain their denominations; analytics normalize before adding',()=>{
 const x=setup(),i=x.intent(x.s);let old=x.run(x.s,[x.reserve(i)]);old=x.run(old,[x.finish(old,i)]);old=x.drain(old,i.pid);const s=previewTokenPrecision(old).state;
 const r=paymentAmounts(i,i.fee);assert.equal(r.unitScale,'1');assert.equal(r.display.value,'100');assert.equal(r.display.fee,'3');
 const copy=structuredClone(s);copy.money.requests.extra={status:'SETTLED',intent:{value:'1234567',unitScale:'1000000'}};
 assert.equal(monetaryAnalytics(copy).display.volume,'101.234567');assert.equal(monetaryAnalytics(copy).display.supply,'1600');
 assert.equal(paymentAmounts({value:'1',abortFee:'1',unitScale:'1000000'},null).display.fee,null);
 const rewarded=enableFees(x,s);assert.equal(rewarded.rewards.collected,'3000000');assert.equal(rewarded.rewards.minted,'0');auditRewards(rewarded);
 const claims=Object.values(rewarded.rewards.nodes).reduce((n,r)=>n+BigInt(r.earned),0n)+BigInt(rewarded.rewards.carry);assert.equal(claims,3000000n);
});

test('unsubmitted old outbox is retained but never broadcast under a changed denomination',async()=>{
 const x=setup();let s=x.s;const w=walletAt(x,()=>s);try{
  const p=await w.prepare(x.f.bob.publicKey,'1'),wire=saved(w,p.pid);s=previewTokenPrecision(s).state;
  assert.equal(outgoingStatus(s,wire.body.action.signed.intent),'REVIEW_REQUIRED');let calls=0;w.broadcast=async()=>{calls++;};
  assert.equal((await w.resume(p.pid)).status,'REVIEW_REQUIRED');assert.equal(calls,0);assert.deepEqual(saved(w,p.pid),wire);
 }finally{w.close();}
});

test('fractional fees reach selected reward wallets once, survive restart, and conserve all dust without minting',async()=>{
 const x=setup();let s=enableFees(x,previewTokenPrecision(x.s).state);const recipients=[keys(),keys()],home=mkdtempSync(join(tmpdir(),'duebyte-fraction-e2e-'));let w=walletAt(x,()=>s,home);
 try{
  const p=await w.prepareTokens(review(s,'1.234567',x.f.bob.publicKey)),wire=saved(w,p.pid),i=wire.body.action.signed.intent;
  for(const id of new Set(i.parts.flatMap(p=>p.nodes)))s=bind(x,s,id,recipients);
  // A local transport failure must leave the exact signed instruction in the outbox.
  w.broadcast=async()=>{throw Error('synthetic partition');};await assert.rejects(()=>w.resume(p.pid),/partition/);assert.deepEqual(saved(w,p.pid),wire);
  w.close();w=walletAt(x,()=>s,home);assert.deepEqual(saved(w,p.pid),wire);
  s=x.run(s,[wire,wire]);const finish=x.finish(s,i);s=x.run(s,[finish,finish]);assert.equal(s.rewards.collected,'37038');
  const end=s.rewards.period.end;while(s.height<end+1)s=x.run(s);
  assert.equal(balances(s,recipients[0].publicKey).available,'18519');assert.equal(balances(s,recipients[1].publicKey).available,'18519');assert.equal(s.money.supply,'1600000000');assert.equal(s.rewards.minted,'0');
  const node=i.parts[0].nodes[0],summary=rewardSummary(s,node);assert.equal(summary.unitScale,'1000000');assert.equal(summary.display.paid,'0.012346');
  const before=hash(s.money.outputs),dbpath=join(home,'replica.sqlite');let db=new Store(dbpath,x.c);db.restore(s);db.close();db=new Store(dbpath,x.c);s=db.state;db.close();
  for(let n=0;n<12;n++)s=x.run(s);assert.equal(hash(s.money.outputs),before,'no duplicate payout after restart');auditRewards(s);stateHash(s,x.c);
  // A new one-micro payment leaves an indivisible fee in carry, not in thin air.
  const tiny=await w.prepareTokens(review(s,'0.000001',x.f.bob.publicKey)),t=saved(w,tiny.pid),ti=t.body.action.signed.intent;s=x.run(s,[t]);s=x.run(s,[x.finish(s,ti)]);const nextEnd=s.rewards.period.end;while(s.height<nextEnd+1)s=x.run(s);
  const earned=Object.values(s.rewards.nodes).reduce((n,r)=>n+BigInt(r.earned),0n);assert.equal(earned+BigInt(s.rewards.carry)+BigInt(s.rewards.period.fees),37039n);assert.equal(s.money.supply,'1600000000');stateHash(s,x.c);
 }finally{w.close();}
});

test('fractional legacy emission cannot bypass the unactivated century programme',()=>{
 const x=setup(),s=previewTokenPrecision(x.s).state;
 for(const extra of [{alphaPPM:1},{periodMintLimit:'1'},{lifetimeMintLimit:'1'}])assert.throws(()=>enableFees(x,s,extra),/fee-only/);
 const n=enableFees(x,s);assert.throws(()=>x.run(n,[x.wire({type:'OPEN_REWARD_WORK_V1'})]),/century executor/);
});

test('fractional expiry refunds principal, charges the reviewed release fee, and cannot refund twice',async()=>{
 const x=setup();let s=previewTokenPrecision(x.s).state;const w=walletAt(x,()=>s);try{
  const p=await w.prepareTokens(review(s,'1.000001',x.f.bob.publicKey)),wire=saved(w,p.pid),i=wire.body.action.signed.intent;s=x.run(s,[wire]);s=x.drain(s,i.pid);
  assert.equal(s.money.requests[i.pid].status,'EXPIRED');assert.equal(s.money.fees,'30001');assert.equal(balances(s,x.f.alice.publicKey).available,'999969999');
  const financial=hash(s.money.outputs);s=x.run(s,[x.wire({type:'EXPIRE',pid:i.pid,request:hash(i)})]);assert.equal(hash(s.money.outputs),financial);assert.equal(s.money.supply,'1600000000');
 }finally{w.close();}
});

test('fractional delayed payments cancel or execute once at the committed time with the reviewed fees',async()=>{
 for(const cancel of [true,false]){
  const x=setup();let s=previewTokenPrecision(x.s).state;
  const body={domain:CONTROL+'/FEATURE',network:x.c.chainId,configHash:s.configHash,generation:0,feature:DELAYED_FEATURE,notBefore:s.height+1,expires:s.height+2,activation:s.height+4};
  s=x.run(s,[x.wire({type:'ENABLE_DELAYED_PAYMENTS',certificate:{body,approvals:x.approvals(body)}})]);while(s.height<body.activation)s=x.run(s);
  const w=walletAt(x,()=>s);try{
   const p=await w.prepareTokens({...review(s,'1.234567',x.f.bob.publicKey),delayed:true}),wire=saved(w,p.pid),i=wire.body.action.signed.intent;
   s=x.run(s,[wire]);s=x.run(s,[x.finish(s,i)]);assert.equal(s.money.requests[i.pid].status,'SCHEDULED');assert.equal(balances(s,x.f.bob.publicKey).available,'0');
   if(cancel){w.broadcast=async wire=>{s=x.run(s,[wire]);return {admitted:true};};await w.cancel(i.pid);assert.equal(s.money.requests[i.pid].status,'CANCELLED');assert.equal(s.money.fees,'37038');assert.equal(balances(s,x.f.alice.publicKey).available,'999962962');}
   else{s=x.run(s,[],s.money.requests[i.pid].executeAt);assert.equal(s.money.requests[i.pid].status,'SETTLED');assert.equal(balances(s,x.f.bob.publicKey).available,'1234567');assert.equal(s.money.fees,'37038');}
   const snapshot=hash(s.money.outputs);s=x.run(s,[],s.money.time+86400);assert.equal(hash(s.money.outputs),snapshot);assert.equal(s.money.supply,'1600000000');stateHash(s,x.c);
  }finally{w.close();}
 }
});
