import test from 'node:test';import assert from 'node:assert/strict';
import {issuanceFixture} from './century-issuance.test.mjs';
import {hash,verify,keys} from '../crypto.mjs';import {stateHash} from '../core.mjs';
import {WalletCollateral,collateralOptions} from '../wallet-collateral.mjs';
function fixture(){const x=issuanceFixture({utc:true});let s=x.s,now=0;const wallet={key:x.f.alice,client:{config:x.c},view:async()=>({state:s,certificate:{appHash:stateHash(s,x.c),appHeight:s.height,height:s.height+1}})},flow=new WalletCollateral(wallet,{now:()=>now}),q={node:x.f.ids[0],amount:'1.234567',unitScale:'1000000'};return {x,wallet,flow,q,get s(){return s;},set s(v){s=v;},set now(v){now=v;}};}
test('wallet review signs exact owned collateral without broadcasting or changing balances',async()=>{
 const f=fixture(),before=hash(f.s),r=await f.flow.review(f.q);assert.equal(r.display.collateral,'1.234567');assert(r.display.remainingAvailable);const c=await f.flow.confirm({id:r.id});assert(verify(c.body,c.ownerSignature,f.x.f.alice.publicKey));assert(c.workerSignatureRequired&&!c.submitted);assert.equal(hash(f.s),before);await assert.rejects(f.flow.confirm({id:r.id}),/expired/);
});
test('stale consent, balance changes, node key changes and cleared sessions never sign',async()=>{
 for(const mutate of [f=>f.now=120001,f=>f.s.money.time+=300,f=>{const id=Object.keys(f.s.money.outputs).find(id=>f.s.money.outputs[id].owner===f.x.f.alice.publicKey);delete f.s.money.outputs[id];},f=>f.s.money.nodes[f.q.node].key=keys().publicKey,f=>f.flow.clear()]){
  const f=fixture(),r=await f.flow.review(f.q);mutate(f);await assert.rejects(f.flow.confirm({id:r.id}));
 }
 const f=fixture(),r=await f.flow.review(f.q);await f.flow.review({...f.q,amount:'2'});await assert.rejects(f.flow.confirm({id:r.id}),/expired/);
});
test('unverified view, unsupported scale and invalid user fields are rejected',async()=>{
 const f=fixture();f.wallet.view=async()=>({state:f.s,certificate:{appHash:hash('forged'),appHeight:f.s.height}});await assert.rejects(f.flow.review(f.q),/unverified/);
 for(const patch of [{amount:'0'},{amount:'-1'},{amount:'1,2'},{amount:'0.0000001'},{amount:'999999999999'},{unitScale:'1'},{owner:keys().publicKey}]){const g=fixture();await assert.rejects(g.flow.review({...g.q,...patch}));}
 const g=fixture();g.s.money.unitScale='1';assert(!collateralOptions(g.s,g.x.f.alice.publicKey).enabled);
});
