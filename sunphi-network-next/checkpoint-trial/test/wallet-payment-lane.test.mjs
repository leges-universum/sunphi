import test from 'node:test';import assert from 'node:assert/strict';
import {WalletPaymentLane} from '../wallet-session-drain.mjs';
test('payment reserves the lane across background completion and executes once',async()=>{
 const lane=new WalletPaymentLane();let busy=true,wake,finish,calls=0;
 const task=lane.run({busy:()=>busy,valid:()=>true,pause:()=>new Promise(r=>wake=r),execute:async()=>{calls++;await new Promise(r=>finish=r);return 42;}});
 assert(lane.pending);await assert.rejects(lane.run({}),/already/);assert.equal(calls,0);
 busy=false;wake();await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert(lane.pending);await assert.rejects(lane.run({}),/already/);
 finish();assert.equal(await task,42);assert(!lane.pending);
});
test('timeout makes no payment and releases lane for retry',async()=>{
 const lane=new WalletPaymentLane();let time=0,calls=0;
 await assert.rejects(lane.run({busy:()=>true,valid:()=>true,execute:()=>calls++,timeoutMs:100,now:()=>time,pause:async ms=>time+=ms}),/No new payment/);
 assert.equal(calls,0);assert(!lane.pending);await lane.run({busy:()=>false,valid:()=>true,execute:()=>calls++});assert.equal(calls,1);
});
test('session switch, disconnect or expired confirmation cancels waiting operation',async()=>{
 const lane=new WalletPaymentLane();let valid=true,busy=true,calls=0;
 await assert.rejects(lane.run({busy:()=>busy,valid:()=>valid,pause:async()=>{valid=false;busy=false;},execute:()=>calls++}),/session or confirmation changed/);
 assert.equal(calls,0);assert(!lane.pending);
});
test('failed execution releases lane without retrying side effects',async()=>{
 const lane=new WalletPaymentLane();let calls=0;
 await assert.rejects(lane.run({busy:()=>false,valid:()=>true,execute:async()=>{calls++;throw Error('upstream failure');}}),/upstream/);
 assert.equal(calls,1);assert(!lane.pending);
});
