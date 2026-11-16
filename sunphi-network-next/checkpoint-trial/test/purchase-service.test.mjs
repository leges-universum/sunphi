import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {hash} from '../crypto.mjs';
import {nativeFixture} from './helpers/purchase-native-fixture.mjs';
import {checkRefundDeposits,freshObservationTime,ProtectedRefundExecutor,observeCommitted} from '../research/purchase-service.mjs';
function fixture(){
 const now=Math.floor(Date.now()/1000),f=nativeFixture(now-10),q=f.reserve({},now-10),txid=hash('deposit'),block=hash('block'),event=hash({network:'bitcoin-regtest',txid,index:0});
 const order={offer:q.offer,status:'PAYMENT_REVIEW',received:[{event,amountAtomic:'5000',paidAt:now-5,observedAt:now,confirmations:6}]};order.refundIntent=f.refundIntent(order,now).body;
 const rpc=async(method,args)=>{if(method==='getblockchaininfo')return {chain:'regtest'};if(method==='getblockhash')return args[0]===0?f.policy.rpcPins.BTC.genesis:block;if(method==='getrawtransaction')return {txid,blockhash:block,vout:[{n:0,value:0.00005,scriptPubKey:{address:q.offer.destination}}]};if(method==='getblockheader')return {hash:block,height:1,time:now-5};if(method==='getblockcount')return 6;throw Error(method);};
 return {f,order,rpc,refs:[{txid,index:0}],now};
}
test('deposit checker rejects argument injection, duplicates and missing references',async()=>{
 const x=fixture(),args={...x,policy:x.f.policy};await checkRefundDeposits(args);
 for(const field of ['rpc','offer','kind','policy','now'])await assert.rejects(()=>checkRefundDeposits({...args,refs:[{...x.refs[0],[field]:'injected'}]}),/exact fields/);
 await assert.rejects(()=>checkRefundDeposits({...args,refs:[] }));
 const changed=structuredClone(x.order);changed.received[0].amountAtomic='6000';await assert.rejects(()=>checkRefundDeposits({...args,order:changed}));
 await assert.rejects(()=>checkRefundDeposits({...args,rpc:async(m,p)=>m==='getblockcount'?1:x.rpc(m,p)}),/lost confirmation/);
});
test('observation time must be recent and cannot be in the future',()=>{
 assert.equal(freshObservationTime(100,100),100);assert.throws(()=>freshObservationTime(101,100));assert.throws(()=>freshObservationTime(69,100));
});
test('independent tips agree at required depth without upgrading immature evidence',async()=>{
 const x=fixture(),reader={policy:x.f.policy,read:()=>x.order},key=x.f.attesters[0],request={proof:{},id:hash(x.order.offer),kind:'PAYMENT',now:x.now,...x.refs[0]};
 const observe=height=>observeCommitted({reader,key,request,rpcs:{BTC:async(m,p)=>m==='getblockcount'?height:x.rpc(m,p)}});
 const a=await observe(6),b=await observe(8),early=await observe(5);assert.deepEqual(a,b);assert.equal(early.body.confirmations,5);
});
test('exclusive executor lease, spending limits, concurrent requests and restart recovery',async()=>{
 const x=fixture(),home=fs.mkdtempSync(join(tmpdir(),'purchase-service-')),txid=hash('refund');let prepared=0,broadcast=0,known=false,release,started;
 const began=new Promise(r=>{started=r;}),gate=new Promise(r=>{release=r;});
 const adapter={async prepare(){prepared++;started();await gate;return {raw:'aabb',txid};},async inspect(){return {txid,destination:x.order.offer.refundDestination,amountAtomic:'5000',network:'bitcoin-regtest',asset:'native'};},async known(){return known;},async broadcast(){broadcast++;known=true;throw Error('lost response');}};
 const args={home,reader:{policy:x.f.policy,configHash:hash(x.f.c),read(){return x.order;}},rpcs:{BTC:x.rpc},adapters:{BTC:()=>adapter},maxAtomic:{BTC:'4999'}};
 let service=new ProtectedRefundExecutor(args);const request={id:hash(x.order.offer),proof:{},deposits:x.refs};
 try{
  assert.throws(()=>new ProtectedRefundExecutor(args),/locked/);await assert.rejects(()=>service.execute(request),/spending limit/);assert.equal(prepared,0);
  args.maxAtomic.BTC='10000';const first=service.execute(request);await began;await assert.rejects(()=>service.execute(request),/busy/);release();await assert.rejects(()=>first,/lost response/);
  service.close();service=new ProtectedRefundExecutor(args);assert.equal((await service.execute(request)).txid,txid);assert.equal(prepared,1);assert.equal(broadcast,1);
 }finally{release();service.close();}
});
