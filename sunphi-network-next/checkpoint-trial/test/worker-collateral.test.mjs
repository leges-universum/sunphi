// Disposable synthetic balances only; never submits to a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {issuanceFixture} from './century-issuance.test.mjs';
import {rig} from './bounded-century.test.mjs';
import {hash,keys,sign} from '../crypto.mjs';
import {FUND_WORKER,COLLATERAL_DOMAIN,collateralChangeId,fundWorker} from '../worker-collateral.mjs';
import {REWARDS,walletConsent} from '../node-rewards.mjs';
function action(x,s,over={},owner=x.f.alice){
 const node=x.f.ids[0],body={domain:COLLATERAL_DOMAIN,configHash:s.configHash,node,owner:owner.publicKey,sequence:(s.workerFunding?.accounts[node]?.sequence??0)+1,issuedAt:s.money.time,expires:s.money.time+300,unitScale:'1000000',inputs:Object.entries(s.money.outputs).filter(([,o])=>o.owner===owner.publicKey).map(([id])=>id).sort().slice(0,8),valueMicro:'1234567',...over};
 return {type:FUND_WORKER,body,ownerSignature:sign(body,owner.privateKey),workerSignature:sign(body,x.key(node).privateKey)};
}
test('funding conserves fractional value, preserves holds and never enables issuance or rewards',()=>{
 const x=issuanceFixture({utc:true}),r=rig(x,x.s,false,false),a=action(x,r.s),before=structuredClone(r.s),node=a.body.node;
 try{
  const total=a.body.inputs.reduce((v,id)=>v+BigInt(before.money.outputs[id].value),0n);
  r.step([x.wire(a)]);assert.equal(r.s.money.nodes[node].stake,String(BigInt(before.money.nodes[node].stake)+1234567n));
  assert.equal(r.s.money.outputs[collateralChangeId(a.body)].value,String(total-1234567n));
  for(const f of ['consensusHeld','taskHeld','tier'])assert.equal(r.s.money.nodes[node][f],before.money.nodes[node][f]);
  assert.equal(r.s.money.supply,before.money.supply);assert.equal(r.s.money.fees,before.money.fees);assert(!r.s.centuryFunds.execution);assert.equal(r.s.rewards.minted,'0');
  const stake=r.s.money.nodes[node].stake;r.step([x.wire(a)]);assert.equal(r.s.money.nodes[node].stake,stake);r.reopen();
  r.step([x.wire(action(x,r.s,{valueMicro:'1'}))]);assert.equal(r.s.money.nodes[node].stake,String(BigInt(stake)+1n));r.reopen();assert(r.reads.every(n=>n<60));
 }finally{r.db.close();}
});
test('funding rejects theft, replay changes, bad consent, wrong chain, precision and expiry atomically',()=>{
 const x=issuanceFixture({utc:true}),r=rig(x,x.s,false,false);
 try{
  const a=action(x,r.s);
  for(const over of [{configHash:hash('other')},{node:hash('unknown')},{sequence:2},{valueMicro:'0'},{valueMicro:'9999999999999999'},{unitScale:'1'},{expires:r.s.money.time},{issuedAt:r.s.money.time+1},{inputs:[hash('missing')]},{inputs:[a.body.inputs[0],a.body.inputs[0]]}])r.reject(x.wire(action(x,r.s,over)));
  r.reject(x.wire({...a,ownerSignature:sign(a.body,keys().privateKey)}));r.reject(x.wire({...a,workerSignature:sign(a.body,keys().privateKey)}));r.reject(x.wire(a,keys()));
  r.step([x.wire(a)]);r.reject(x.wire(action(x,r.s,{sequence:1,valueMicro:'2'})));r.reopen();
 }finally{r.db.close();}
});
test('funding interrupted commit and mixed failing block retain balances after restart',()=>{
 const x=issuanceFixture({utc:true}),r=rig(x,x.s,false,false),root=r.db.root,before=hash(r.s),a=action(x,r.s);
 try{
  const request={height:r.s.height+1,time:r.s.money.time,blockHash:hash('funding interrupted'),txs:[Buffer.from(JSON.stringify(x.wire(a)))]};
  assert.throws(()=>r.db.commitBlock(request,root,{beforeCommit:()=>{throw Error('storage interrupted');}}),/interrupted/);r.reopen();assert.equal(hash(r.s),before);
  request.txs.push(Buffer.from(JSON.stringify(x.wire(action(x,r.s,{sequence:3})))));assert.throws(()=>r.db.commitBlock(request,root));r.reopen();assert.equal(hash(r.s),before);
 }finally{r.db.close();}
});
test('locked funds and protected wallets cannot be converted into collateral',()=>{
 const x=issuanceFixture({utc:true}),a=action(x,x.s),s=structuredClone(x.s);
 s.money.outputs[a.body.inputs[0]].unlock=s.money.time+1;assert.throws(()=>fundWorker(s,a,x.f.alice.publicKey),/locked/);
 const p=structuredClone(x.s);p.spendPolicies={[x.f.alice.publicKey]:{enabled:true}};assert.throws(()=>fundWorker(p,a,x.f.alice.publicKey),/protected/);
});
test('server payout management and recipient consent remain separate from funded work keys',()=>{
 const x=issuanceFixture({utc:true}),r=rig(x,x.s,false,false),node=x.f.ids[0],work=x.key(node),manager=keys();
 try{
  r.step([x.wire(action(x,r.s))]);
  const rotation={domain:REWARDS+'/MANAGEMENT',configHash:r.s.configHash,node,sequence:1,management:manager.publicKey};
  const rotate={type:'SET_REWARD_MANAGEMENT_V1',body:rotation,signature:sign(rotation,work.privateKey),newSignature:sign(rotation,manager.privateKey)};
  r.reject(x.wire({...rotate,newSignature:sign(rotation,keys().privateKey)},work));r.step([x.wire(rotate,work)]);
  const body={domain:REWARDS+'/BIND',configHash:r.s.configHash,node,sequence:2,payouts:[{wallet:x.f.alice.publicKey,weight:1}]};
  const binding={type:'BIND_REWARD_WALLETS_V1',body,signature:sign(body,manager.privateKey),consents:[sign(walletConsent(r.s.configHash,node,x.f.alice.publicKey),x.f.alice.privateKey)]};
  r.reject(x.wire(binding,work));r.reject(x.wire({...binding,consents:[sign(walletConsent(r.s.configHash,hash('different worker'),x.f.alice.publicKey),x.f.alice.privateKey)]},manager));
  r.step([x.wire(binding,manager)]);r.step([x.wire(binding,manager)]);r.reopen();assert.deepEqual(r.s.rewards.nodes[node].payouts,body.payouts);assert.equal(r.s.rewards.nodes[node].management,manager.publicKey);assert.equal(r.s.money.supply,x.s.money.supply);
 }finally{r.db.close();}
});
test('same-block consecutive funding and exact spend leave a consistent wallet index',()=>{
 const x=issuanceFixture({utc:true}),r=rig(x,x.s,false,false);
 try{
  const first=action(x,r.s,{valueMicro:'1'}),copy=structuredClone(r.s);fundWorker(copy,first,x.f.alice.publicKey);
  const left=Object.values(copy.money.outputs).filter(o=>o.owner===x.f.alice.publicKey).reduce((v,o)=>v+BigInt(o.value),0n),second=action(x,copy,{valueMicro:String(left)});
  r.step([x.wire(first),x.wire(second)]);r.reopen();assert.equal(Object.values(r.s.money.outputs).filter(o=>o.owner===x.f.alice.publicKey).length,0);assert.equal(r.s.money.supply,x.s.money.supply);
 }finally{r.db.close();}
});
