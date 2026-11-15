import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {fragmentedFixture,inputCertificate,inputRig} from './helpers/payment-input-fixture.mjs';import {Wallet,balances} from '../wallet.mjs';import {selectWalletInputs} from '../wallet-inputs.mjs';import {INPUT_FEATURE,BLOCK_INPUTS,inputBudget,paymentInputLimit} from '../payment-input-policy.mjs';import {hash,keys,sign} from '../crypto.mjs';import {stateHash} from '../core.mjs';import {validateIntentShape,policyId,policy} from '../payment-model.mjs';import {resourcePaymentId} from '../resource-limits.mjs';
import {execFileSync} from 'node:child_process';import {BoundedNetworkInterpreter} from '../research/bounded-network-interpreter.mjs';import {DatabaseSync} from 'node:sqlite';import {CONTROL,DELAYED_FEATURE} from '../authority.mjs';import {SCHEDULE_DOMAIN} from '../payment-model.mjs';
function wallet(x,r){return new Wallet({client:{config:x.c,sync:async()=>({state:r.state,certificate:{appHeight:r.state.height,height:r.state.height+1,appHash:stateHash(r.state,x.c)}})},key:x.f.alice,home:fs.mkdtempSync(join(tmpdir(),'inputs-wallet-')),url:'http://127.0.0.1:1'});}
const wire=(w,p)=>JSON.parse(w.db.prepare('SELECT body FROM outgoing WHERE pid=?').get(p.pid).body);
test('real 162-reward distribution: quote rejects preactivation without writing; one 3-token payment after activation',async()=>{
 const x=fragmentedFixture(),r=inputRig(x),w=wallet(x,r);try{
  assert.equal(balances(r.state,x.f.alice.publicKey).available,'3889998');await assert.rejects(w.quote('3','1000000'),e=>e.code==='PAYMENT_INPUT_CAPACITY'&&e.paymentOutcome==='not_created');assert.equal(w.db.prepare('select count(*) n from outgoing').get().n,0);
  r.enable();const q=await w.quote('3','1000000');assert.equal(q.fee,'5000');const p=await w.prepareTokens({recipient:x.f.bob.publicKey,value:'3',unitScale:q.unitScale,fee:q.fee,abortFee:q.abortFee,feeSchedule:q.feeSchedule,partsCount:q.partsCount});
  const t=wire(w,p),i=t.body.action.signed.intent;assert(i.inputs.length>8&&i.inputs.length<=162);assert.equal(i.inputPolicy,INPUT_FEATURE);assert.equal(i.policy,policyId);const before=BigInt(balances(r.state,x.f.bob.publicKey).available);r.step([t]);r.reopen();r.step([x.finish(r.state,i)]);assert.equal(r.state.money.requests[p.pid].status,'SETTLED');assert.equal(BigInt(balances(r.state,x.f.bob.publicKey).available),before+3000000n);assert.equal(balances(r.state,x.f.alice.publicKey).available,'884998');r.reopen();assert.equal(r.state.money.supply,x.s.money.supply);
 }finally{w.close();r.close();}
});

test('two owners share exactly 512 input reads; excess waits for the next block',async()=>{
 const x=fragmentedFixture(Array(513).fill('10000')),ids=Object.entries(x.s.money.outputs).filter(([,o])=>o.owner===x.f.alice.publicKey).map(([id])=>id).sort();
 for(const id of ids.slice(256,512))x.s.money.outputs[id].owner=x.f.bob.publicKey;
 const r=inputRig(x),w=wallet(x,r);try{r.enable();const q=await w.quote('1','1000000'),p=await w.prepareTokens({recipient:x.f.bob.publicKey,value:'1',unitScale:q.unitScale,fee:q.fee,abortFee:q.abortFee,feeSchedule:q.feeSchedule,partsCount:q.partsCount}),base=wire(w,p).body.action.signed.intent;
 const make=(key,inputs,value='1000000')=>{const i={...base,sender:key.publicKey,recipient:x.f.alice.publicKey,inputs,value,parts:base.parts.map(p=>({...p,value})),inputPolicy:INPUT_FEATURE};i.pid=resourcePaymentId(i,r.state.configHash);return {i,t:x.wire({type:'RESERVE',signed:{intent:i,signature:sign(i,key.privateKey)}},key)};};
 const a=make(x.f.alice,ids.slice(0,256)),b=make(x.f.bob,ids.slice(256,512)),c=make(x.f.alice,ids.slice(512),'1000');
 assert.deepEqual(r.step([a.t,b.t,c.t],{filter:true}).codes,[0,0,1]);assert(!r.state.money.requests[c.i.pid]);assert(r.state.money.outputs[ids[512]]);r.reopen();assert.deepEqual(r.step([c.t]).codes,[0]);
 r.step([a,b,c].map(p=>x.finish(r.state,p.i)));assert([a,b,c].every(p=>r.state.money.requests[p.i.pid].status==='SETTLED'));assert.equal(r.state.money.supply,x.s.money.supply);
 }finally{w.close();r.close();}
});

test('expanded intents require active feature, unlocked owned inputs and valid sender signature',async()=>{
 const x=fragmentedFixture(Array(512).fill('10000')),ids=Object.entries(x.s.money.outputs).filter(([,o])=>o.owner===x.f.alice.publicKey).map(([id])=>id).sort();x.s.money.outputs[ids[0]].unlock=x.s.money.time+1000;
 const r=inputRig(x),w=wallet(x,r);try{
 const i=x.intent(r.state,{inputs:ids,unitScale:'1000000',value:'3000000',fee:'5000',abortFee:'500',parts:[{value:'3000000',nodes:x.f.ids.slice(0,3)}],inputPolicy:INPUT_FEATURE});
 const t=x.wire({type:'RESERVE',signed:{intent:i,signature:sign(i,x.f.alice.privateKey)}});assert.deepEqual(r.step([t],{filter:true}).codes,[1]);r.enable();
 const q=await w.quote('3','1000000'),p=await w.prepareTokens({recipient:x.f.bob.publicKey,value:'3',unitScale:q.unitScale,fee:q.fee,abortFee:q.abortFee,feeSchedule:q.feeSchedule,partsCount:q.partsCount}),base=wire(w,p).body.action.signed.intent;
 const locked={...base,inputs:ids};locked.pid=resourcePaymentId(locked,r.state.configHash);const lockedWire=x.wire({type:'RESERVE',signed:{intent:locked,signature:sign(locked,x.f.alice.privateKey)}});
 const badSignature=x.wire({type:'RESERVE',signed:{intent:base,signature:sign(base,x.f.bob.privateKey)}}),before=structuredClone(r.state.money.outputs);assert.deepEqual(r.step([lockedWire],{filter:true}).codes,[1]);assert.deepEqual(r.step([badSignature],{filter:true}).codes,[1]);assert.deepEqual(r.state.money.outputs,before);
 r.step([wire(w,p)]);assert.deepEqual(r.step([wire(w,p)]).codes,[0]);assert.equal(Object.keys(r.state.money.requests).length,1);
 }finally{w.close();r.close();}
});

test('512-input reserve survives abrupt exits before and after durable commit and replays once',async()=>{
 const x=fragmentedFixture(Array(512).fill('10000')),r=inputRig(x),w=wallet(x,r);let db;try{
 r.enable();const q=await w.quote('3','1000000'),p=await w.prepareTokens({recipient:x.f.bob.publicKey,value:'3',unitScale:q.unitScale,fee:q.fee,abortFee:q.abortFee,feeSchedule:q.feeSchedule,partsCount:q.partsCount}),t=wire(w,p),i=t.body.action.signed.intent;
 i.inputs=Object.entries(r.state.money.outputs).filter(([,o])=>o.owner===x.f.alice.publicKey).map(([id])=>id).sort();i.pid=resourcePaymentId(i,r.state.configHash);t.body.action.signed.signature=sign(i,x.f.alice.privateKey);const tx=x.wire(t.body.action);
 const state=structuredClone(r.state),pin=r.db.root,sequence=r.db.store.meta.sequence,file=join(r.directory,'crash.sqlite');r.db.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');fs.copyFileSync(r.file,file);
 const request={height:state.height+1,blockHash:hash('input-crash'),time:state.money.time,txs:[Buffer.from(JSON.stringify(tx))]},module=new URL('../research/bounded-network-interpreter.mjs',import.meta.url).href;
 const child=after=>`import {BoundedNetworkInterpreter} from ${JSON.stringify(module)};const db=BoundedNetworkInterpreter.open(${JSON.stringify(file)},${JSON.stringify(x.c)},${JSON.stringify(pin)});const request=${JSON.stringify({...request,txs:[JSON.stringify(tx)]})};request.txs=request.txs.map(t=>Buffer.from(t));db.commitBlock(request,db.root,${after?'{}':'{beforeCommit:()=>process.exit(77)}'});process.exit(78);`;
 assert.throws(()=>execFileSync(process.execPath,['--input-type=module'],{input:child(false),stdio:['pipe','pipe','pipe'],windowsHide:true}),e=>e.status===77);db=BoundedNetworkInterpreter.open(file,x.c,pin);assert.deepEqual(db.snapshotForAudit(),state);assert.equal(db.store.meta.sequence,sequence);db.close();db=null;
 assert.throws(()=>execFileSync(process.execPath,['--input-type=module'],{input:child(true),stdio:['pipe','pipe','pipe'],windowsHide:true}),e=>e.status===78);const sql=new DatabaseSync(file,{readOnly:true}),committed=sql.prepare('select rootHash from meta where id=1').get().rootHash;sql.close();db=BoundedNetworkInterpreter.open(file,x.c,committed);assert(db.commitBlock(request,committed).value.duplicate);assert.equal(db.store.meta.sequence,sequence+1);assert.equal(db.snapshotForAudit().money.requests[i.pid].status,'RESERVED');assert.equal(db.snapshotForAudit().money.supply,state.money.supply);
 }finally{db?.close();w.close();r.close();}
});
test('quorum activation is prospective; missing signature and repeated activation are rejected',()=>{
 const x=fragmentedFixture(),r=inputRig(x);try{const a=inputCertificate(x,r.state),bad=structuredClone(a);bad.certificate.approvals=bad.certificate.approvals.slice(0,6);assert.deepEqual(r.step([x.wire(bad)],{filter:true}).codes,[1]);r.step([x.wire(a)]);assert.equal(paymentInputLimit(r.state),8);while(r.state.height<a.certificate.body.activation)r.step();assert.equal(paymentInputLimit(r.state),512);assert.deepEqual(r.step([x.wire(a)],{filter:true}).codes,[1]);}finally{r.close();}
});
test('selection distinguishes lack of funds, locked or foreign outputs, and capacity; largest first is deterministic',()=>{
 const x=fragmentedFixture(),s=x.s,owner=x.f.alice.publicKey;assert.throws(()=>selectWalletInputs(s,owner,4000000n),e=>e.code==='INSUFFICIENT_FUNDS');s.authority.sharedPaymentInputs={activation:s.height};const a=selectWalletInputs(s,owner,3005000n);assert(a.inputs.length>8);const reordered=structuredClone(s);reordered.money.outputs=Object.fromEntries(Object.entries(reordered.money.outputs).reverse());assert.deepEqual(selectWalletInputs(reordered,owner,3005000n).inputs,a.inputs);for(const id of a.inputs)s.money.outputs[id].unlock=s.money.time+1;assert.throws(()=>selectWalletInputs(s,owner,3005000n),e=>e.code==='INSUFFICIENT_FUNDS');
});
test('per-block input work stays 512, independently of transaction count, and resets each block',()=>{
 const s={height:5,authority:{sharedPaymentInputs:{activation:5}}},b=inputBudget(),a=n=>({type:'RESERVE',signed:{intent:{inputs:Array(n)}}});b.consume(s,a(256));b.consume(s,a(256));assert.equal(b.used,512);assert.throws(()=>b.consume(s,a(1)),/block payment input budget/);assert.equal(b.used,512);inputBudget().consume(s,a(512));assert.throws(()=>inputBudget().consume(s,a(513)),/payment input count/);assert.equal(policy.maxInputs,8);
});
test('other action families cannot bypass shared work through collateral, programme or finalization actions',()=>{
 const s={height:5,authority:{sharedPaymentInputs:{activation:5}}},a=n=>({type:'RESERVE',signed:{intent:{inputs:Array(n)}}});
 for(const type of ['FUND_PAYMENT_WORKER_V1','EXECUTE_PURCHASE_LAB_V1','EXECUTE_EXCHANGE_LAB_V1','RUN_CENTURY_WARMUP_V1','FINALIZE','ENABLE_SHARED_PAYMENT_INPUTS_V1','FUTURE_ACTION']){
  const full=inputBudget();full.consume(s,a(512));assert.throws(()=>full.consume(s,{type}),/block payment input budget/);
  const mixed=inputBudget();mixed.consume(s,a(504));mixed.consume(s,{type});assert.equal(mixed.used,512);
 }
 const legacy=inputBudget();for(let n=0;n<64;n++)legacy.consume(s,{type:'FINALIZE'});assert.equal(legacy.used,512);assert.throws(()=>legacy.consume(s,{type:'FINALIZE'}),/block payment input budget/);
});
test('512-input reserve/finalize stays within indexed bounds; duplicate, foreign and 513 inputs fail atomically',async()=>{
 const x=fragmentedFixture(Array(513).fill('10000')),r=inputRig(x),w=wallet(x,r);try{r.enable();const q=await w.quote('3','1000000'),p=await w.prepareTokens({recipient:x.f.bob.publicKey,value:'3',unitScale:q.unitScale,fee:q.fee,abortFee:q.abortFee,feeSchedule:q.feeSchedule,partsCount:q.partsCount}),base=wire(w,p).body.action.signed.intent,ids=Object.entries(r.state.money.outputs).filter(([,o])=>o.owner===x.f.alice.publicKey).map(([id])=>id).sort();
 const make=inputs=>{const i={...base,inputs,inputPolicy:INPUT_FEATURE};i.pid=resourcePaymentId(i,r.state.configHash);return {i,t:x.wire({type:'RESERVE',signed:{intent:i,signature:sign(i,x.f.alice.privateKey)}})};};
 for(const inputs of [ids,[...ids.slice(0,511),ids[0]],[...ids.slice(0,511),hash('synthetic remainder')]]){const {t}=make(inputs),before=structuredClone(r.state.money.outputs);assert.deepEqual(r.step([t],{filter:true}).codes,[1]);assert.deepEqual(r.state.money.outputs,before);}
 const {i,t}=make(ids.slice(0,512));validateIntentShape(i);assert(Buffer.byteLength(JSON.stringify(t))<=65536);r.step([t]);r.reopen();r.step([x.finish(r.state,i)]);assert.equal(r.state.money.requests[i.pid].status,'SETTLED');r.reopen();assert.equal(r.state.money.supply,x.s.money.supply);assert(r.timings.every(t=>t.recordsRead<=16384));
 }finally{w.close();r.close();}
});

for(const outcome of ['SETTLED','EXPIRED','CANCELLED'])test('512 inputs and 32 covered parts preserve '+outcome+' after restart',async()=>{
 const x=fragmentedFixture(Array(512).fill('10000')),r=inputRig(x),w=wallet(x,r);try{
 r.enable();if(outcome==='CANCELLED'){const body={domain:CONTROL+'/FEATURE',network:x.c.chainId,configHash:r.state.configHash,generation:r.state.authority.generation,feature:DELAYED_FEATURE,notBefore:r.state.height+1,expires:r.state.height+2,activation:r.state.height+4};r.step([x.wire({type:'ENABLE_DELAYED_PAYMENTS',certificate:{body,approvals:x.approvals(body)}})]);while(r.state.height<body.activation)r.step();}
 const q=await w.quote('3','1000000'),p=await w.prepareTokens({recipient:x.f.bob.publicKey,value:'3',unitScale:q.unitScale,fee:q.fee,abortFee:q.abortFee,feeSchedule:q.feeSchedule,partsCount:q.partsCount}),i=wire(w,p).body.action.signed.intent;
 i.inputs=Object.entries(r.state.money.outputs).filter(([,o])=>o.owner===x.f.alice.publicKey).map(([id])=>id).sort();i.parts=Array.from({length:32},()=>({value:'93750',nodes:x.f.ids.slice(0,3)}));if(outcome==='EXPIRED'){i.lastReserve=r.state.money.time+10;i.deadline=r.state.money.time+20;}if(outcome==='CANCELLED'){i.domain=SCHEDULE_DOMAIN;i.sendDelay=86400;}i.pid=resourcePaymentId(i,r.state.configHash);
 const t=x.wire({type:outcome==='CANCELLED'?'SCHEDULE_PAYMENT_V1':'RESERVE',signed:{intent:i,signature:sign(i,x.f.alice.privateKey)}});assert(Buffer.byteLength(JSON.stringify(t))<=65536);const before=BigInt(balances(r.state,x.f.alice.publicKey).available);r.step([t]);r.reopen();
 if(outcome==='EXPIRED')r.step([],{time:i.deadline+1});else{const finish=x.finish(r.state,i);assert(Buffer.byteLength(JSON.stringify(finish))<=65536);r.step([finish]);if(outcome==='CANCELLED')r.step([x.wire({type:'CANCEL_SCHEDULED_PAYMENT_V1',pid:i.pid,request:hash(i)})]);}
 assert.equal(r.state.money.requests[i.pid].status,outcome);assert.equal(BigInt(balances(r.state,x.f.alice.publicKey).available),before-(outcome==='SETTLED'?3005000n:500n));r.reopen();assert.equal(r.state.money.supply,x.s.money.supply);
 }finally{w.close();r.close();}
});
