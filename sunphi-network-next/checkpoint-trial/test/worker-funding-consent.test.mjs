import test from 'node:test';
import assert from 'node:assert/strict';
import {issuanceFixture} from './century-issuance.test.mjs';
import {rig} from './bounded-century.test.mjs';
import {hash,keys,sign,verify} from '../crypto.mjs';
import {WalletCollateral} from '../wallet-collateral.mjs';
import {signWorkerFunding} from '../worker-funding-consent.mjs';
import {loadBoundedWalletView} from '../research/bounded-wallet-view.mjs';
import {queryBounded} from '../research/bounded-query.mjs';

export async function fixture(){
 const x=issuanceFixture({utc:true}),r=rig(x,x.s,false,false),node=x.f.ids[0];
 const view=async({rewardIds=[node]}={})=>{
  const height=r.db.networkHeader().height,root=r.db.root;
  const {state}=await loadBoundedWalletView(async(req,anchor)=>queryBounded(r.db,req,anchor),
   {root,height,configHash:hash(x.c),owner:x.f.alice.publicKey,rewardIds,allowIsolated:true});
  return {state,certificate:{appHash:root,appHeight:height,height:height+1}};
 };
 const wallet={key:x.f.alice,client:{config:x.c},view},flow=new WalletCollateral(wallet);
 const review=await flow.review({node,amount:'90',unitScale:'1000000'}),consent=await flow.confirm({id:review.id});
 const options={config:x.c,key:x.key(node),scope:{configHash:r.s.configHash,node,owner:x.f.alice.publicKey,valueMicro:'90000000'},view,now:()=>r.s.money.time*1000};
 return {x,r,consent,options};
}
test('funding handoff: Home and worker sign the same body; commit, restart and lost response do not spend twice',async()=>{
 const f=await fixture();try{
  const before=hash(f.r.s),supply=f.r.s.money.supply,stake=BigInt(f.r.s.money.nodes[f.options.scope.node].stake);
  const result=await signWorkerFunding(f.consent,f.options);assert.equal(result.status,'SIGNED_NOT_SUBMITTED');assert.equal(hash(f.r.s),before);
  assert(verify(result.action.body,result.action.workerSignature,f.options.key.publicKey));
  f.r.step([f.x.wire(result.action,f.x.f.alice)]);f.r.reopen();
  assert.equal(BigInt(f.r.s.money.nodes[f.options.scope.node].stake),stake+90000000n);assert.equal(f.r.s.money.supply,supply);
  const committed=hash(f.r.s),again=await signWorkerFunding(f.consent,f.options);
  assert.equal(again.status,'ALREADY_COMMITTED');assert.equal(again.action,null);assert.equal(hash(f.r.s),committed);
  const bad=structuredClone(f.consent);bad.body.expires++;bad.ownerSignature=sign(bad.body,f.x.f.alice.privateKey);
  await assert.rejects(signWorkerFunding(bad,f.options),/conflicting/);
  f.r.step([],f.consent.body.expires+1);f.r.reopen();
  assert.equal((await signWorkerFunding(f.consent,f.options)).status,'ALREADY_COMMITTED');
 }finally{f.r.db.close();}
});

test('funding handoff: concurrent worker consents cannot spend the same owner output twice',async()=>{
 const f=await fixture();try{
  const node=f.x.f.ids[1],flow=new WalletCollateral({key:f.x.f.alice,client:{config:f.x.c},view:f.options.view});
  const review=await flow.review({node,amount:'90',unitScale:'1000000'}),other=await flow.confirm({id:review.id});
  assert.deepEqual(other.body.inputs,f.consent.body.inputs);
  const options={...f.options,key:f.x.key(node),scope:{...f.options.scope,node}};
  const signedOther=await signWorkerFunding(other,options),first=await signWorkerFunding(f.consent,f.options);
  f.r.step([f.x.wire(first.action,f.x.f.alice)]);f.r.reopen();
  const committed=hash(f.r.s);
  await assert.rejects(signWorkerFunding(other,options));
  f.r.reject(f.x.wire(signedOther.action,f.x.f.alice));
  assert.equal(hash(f.r.s),committed);
 }finally{f.r.db.close();}
});

test('funding handoff: input changes during proof loading cannot change an approved signature',async()=>{
 const f=await fixture();try{
  const consent=structuredClone(f.consent),originalHash=hash(consent.body);
  const result=await signWorkerFunding(consent,{...f.options,view:async request=>{
   consent.body.valueMicro='1';consent.ownerSignature='changed';return f.options.view(request);
  }});
  assert.equal(hash(result.action.body),originalHash);
  assert(verify(result.action.body,result.action.ownerSignature,f.options.scope.owner));
 }finally{f.r.db.close();}
});
test('funding handoff: changed scope, forged signature, stale proof, clock expiry and wrong worker fail closed',async()=>{
 const f=await fixture();try{
  const before=hash(f.r.s);
  for(const patch of [{owner:keys().publicKey},{node:hash('other node')},{valueMicro:'90000001'},{configHash:hash('other chain')}]){
   const bad=structuredClone(f.consent);Object.assign(bad.body,patch);await assert.rejects(signWorkerFunding(bad,f.options));
  }
  await assert.rejects(signWorkerFunding({...f.consent,ownerSignature:sign(f.consent.body,keys().privateKey)},f.options),/owner signature/);
  await assert.rejects(signWorkerFunding(f.consent,{...f.options,key:keys()}),/worker signing key/);
  await assert.rejects(signWorkerFunding(f.consent,{...f.options,now:()=>f.r.s.money.time*1000+61000}),/stale/);
  await assert.rejects(signWorkerFunding(f.consent,{...f.options,view:async()=>({state:f.r.s,certificate:{appHash:hash('forged'),appHeight:f.r.s.height}})}),/unverified/);
  const expired=structuredClone(f.consent);expired.body.issuedAt=f.r.s.money.time-300;expired.body.expires=f.r.s.money.time;expired.ownerSignature=sign(expired.body,f.x.f.alice.privateKey);
  await assert.rejects(signWorkerFunding(expired,f.options),/expired/);
  const future=structuredClone(f.consent);future.body.issuedAt++;future.ownerSignature=sign(future.body,f.x.f.alice.privateKey);
  await assert.rejects(signWorkerFunding(future,f.options),/premature/);assert.equal(hash(f.r.s),before);
 }finally{f.r.db.close();}
});
