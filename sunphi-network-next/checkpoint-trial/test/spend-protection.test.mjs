import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from '../../research/transition-core-20261103/fixture.mjs';
import {keys,hash,sign} from '../crypto.mjs';
import {PROFILE,origin,block,envelope,workReceipt,stateHash} from '../core.mjs';
import {CONTROL,SPEND_FEATURE} from '../authority.mjs';
import {PROTECTION,approvalBody,checkApproval} from '../spend-protection.mjs';
import {Wallet} from '../wallet.mjs';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
function setup(){
 const f=fixture(),validators=Array.from({length:10},keys),members=Array.from({length:4},keys),approver=keys(),recovery=keys();f.state.time=1000;
 const c={profile:PROFILE,chainId:'duebyte-trial-spend-protection',initial:f.state,trialOnly:true,control:{validators:validators.map((k,i)=>({key:k.publicKey,group:hash({i})})),policy:{version:1,members:members.map((k,i)=>({key:k.publicKey,group:hash({i})})),threshold:3,maxAge:3600,notAfter:200000}}};
 const run=(s,actions=[],time=s.money.time)=>block(s,c,{height:s.height+1,blockHash:hash({height:s.height+1}),time,txs:actions.map(a=>Buffer.from(JSON.stringify(envelope(c,a,f.alice))))}).state;
 const b={domain:CONTROL+'/FEATURE',network:c.chainId,configHash:hash(c),generation:0,feature:SPEND_FEATURE,activation:4,notBefore:1,expires:2};
 const enable={type:'ENABLE_SPEND_PROTECTION_V1',certificate:{body:b,approvals:validators.slice(0,7).map(k=>({key:k.publicKey,signature:sign(b,k.privateKey)}))}};
 const policyAction=(s,{type='SET_SPEND_POLICY_V1',version=(s.spendPolicies?.[f.alice.publicKey]?.version??0)+1,nextApprover=approver,nextRecovery=recovery,current=null,enabled=true}={})=>{
  const body={domain:PROTECTION+'/'+type,configHash:hash(c),wallet:f.alice.publicKey,version,issuedAt:s.money.time,expires:s.money.time+600,...(type==='CANCEL_SPEND_RECOVERY_V1'?{}:{policy:{version,enabled,approver:nextApprover.publicKey,recovery:nextRecovery.publicKey,recoveryDelay:86400}})};
  return {type,body,signatures:{wallet:sign(body,f.alice.privateKey),current:current?sign(body,current.privateKey):null,approver:type==='CANCEL_SPEND_RECOVERY_V1'?null:sign(body,nextApprover.privateKey),recovery:type==='CANCEL_SPEND_RECOVERY_V1'?null:sign(body,nextRecovery.privateKey)}};
 };
 let s=run(origin(c),[enable]);s=run(run(run(s)));const install=policyAction(s);s=run(s,[install]);
 const intent=()=>f.intent({pid:hash({case:'protected-payment'}),value:'90',fee:'3',lastReserve:50,deadline:90,parts:[{value:'90',nodes:f.ids.slice(0,3)}]});
 const reserve=(s,i=intent(),key=approver)=>{const body=approvalBody(s,i,s.money.time+600);return {type:'RESERVE',signed:f.sign(i),approval:{body,signature:sign(body,key.privateKey)}};};
 return {f,c,s,run,enable,install,approver,recovery,policyAction,intent,reserve};
}
test('feature requires quorum; old unprotected states and signatures retain their hashes',()=>{
 const x=setup(),old=origin(x.c),expected=hash(old);assert.equal(stateHash(old,x.c),expected);assert(!old.spendPolicies);
 const bad=structuredClone(x.enable);bad.certificate.approvals.pop();assert.throws(()=>x.run(old,[bad]),/quorum/);
 assert.throws(()=>x.run(old,[x.install]),/not activated/);
 const plain=x.run(old,[{type:'RESERVE',signed:x.f.sign(x.intent())}]);assert(plain.money.requests[x.intent().pid]);assert(!plain.spendPolicies);
});
test('direct RPC cannot bypass approval and cannot substitute amount, network or approval key',()=>{
 const x=setup(),a=x.reserve(x.s);assert.throws(()=>x.run(x.s,[{type:'RESERVE',signed:a.signed}]));
 assert.throws(()=>x.run(x.s,[x.reserve(x.s,x.intent(),keys())]),/approval signature/);
 const altered=x.intent();altered.recipient=keys().publicKey;assert.throws(()=>x.run(x.s,[{...a,signed:x.f.sign(altered)}]),/payment changed/);
 const foreign=structuredClone(a);foreign.approval.body.configHash=hash('other');foreign.approval.signature=sign(foreign.approval.body,x.approver.privateKey);assert.throws(()=>x.run(x.s,[foreign]));
 const later=structuredClone(x.s);later.money.time+=600;assert.throws(()=>checkApproval(later,a.signed.intent,a.approval),/expired/);
});
test('approved reserve and duplicate settle exactly once with original money conservation',()=>{
 const x=setup(),i=x.intent(),a=x.reserve(x.s,i);let s=x.run(x.s,[a,a]);
 const receipts=i.parts.flatMap((p,index)=>p.nodes.map(node=>workReceipt(s,i.pid,index,node,{publicKey:s.money.nodes[node].key,privateKey:x.f.nodeKeys[node]})));
 const finish={type:'FINALIZE',pid:i.pid,request:hash(i),receipts};s=x.run(s,[finish,finish]);assert.equal(s.money.supply,'1600');assert.equal(s.money.fees,'3');assert.equal(s.money.requests[i.pid].status,'SETTLED');
 const balances=JSON.stringify(s.money.outputs);s=x.run(s,[a]);assert.equal(JSON.stringify(s.money.outputs),balances);
});
test('wallet signature alone cannot disable protection; policy changes invalidate old approvals',()=>{
 const x=setup(),approved=x.reserve(x.s);assert.throws(()=>x.run(x.s,[x.policyAction(x.s,{enabled:false})]),/current approval/);
 const s=x.run(x.s,[x.policyAction(x.s,{current:x.approver})]);assert.throws(()=>x.run(s,[approved]),/policy changed/);
 const disabled=x.run(s,[x.policyAction(s,{current:x.approver,enabled:false})]);assert(x.run(disabled,[{type:'RESERVE',signed:x.f.sign(x.intent())}]).money.requests[x.intent().pid]);
});
test('recovery needs separate key and consensus delay; cancellation consumes its version',()=>{
 const x=setup(),nextApprover=keys(),nextRecovery=keys();
 const request=x.policyAction(x.s,{type:'RECOVER_SPEND_POLICY_V1',current:x.recovery,nextApprover,nextRecovery});
 let s=x.run(x.s,[request]);assert.equal(s.spendPolicies[x.f.alice.publicKey].approver,x.approver.publicKey);
 const cancel=x.policyAction(s,{type:'CANCEL_SPEND_RECOVERY_V1',current:x.approver});const cancelled=x.run(s,[cancel]);assert.equal(cancelled.spendPolicies[x.f.alice.publicKey].pending,null);
 assert.throws(()=>x.run(cancelled,[request]),/policy version/);assert.throws(()=>x.run(cancelled,[cancel]),/policy version/);
 s=x.run(s,[],1000+86399);assert.equal(s.spendPolicies[x.f.alice.publicKey].approver,x.approver.publicKey);
 s=x.run(s,[],1000+86400);assert.equal(s.spendPolicies[x.f.alice.publicKey].approver,nextApprover.publicKey);assert.equal(s.spendPolicies[x.f.alice.publicKey].version,2);
 assert.throws(()=>x.run(s,[cancel]),/expired|policy version/);
});
test('wallet waits without broadcasting, verifies approval, and keeps the signed decision after restart',async()=>{
 const x=setup(),home=mkdtempSync(join(tmpdir(),'duebyte-messenger-approval-')),client={config:x.c,sync:async()=>({state:x.s})};
 const options={client,key:x.f.alice,home,routes:Object.fromEntries(Object.keys(x.c.initial.nodes).map(id=>[id,'http://127.0.0.1:1'])),url:'http://127.0.0.1:1',checkpoint:{}};
 let wallet=new Wallet(options),calls=0;wallet.broadcast=async()=>{calls++;};
 try{
  const prepared=await wallet.prepare(x.f.bob.publicKey,'1');assert.equal((await wallet.resume(prepared.pid)).status,'AWAITING_APPROVAL');assert.equal(calls,0);
  const request=await wallet.approvalRequest(prepared.pid),approval={body:request.body,signature:sign(request.body,x.approver.privateKey)};
  await assert.rejects(()=>wallet.acceptApproval(prepared.pid,{...approval,signature:sign(request.body,x.recovery.privateKey)}),/signature/);
  assert.equal((await wallet.acceptApproval(prepared.pid,approval)).status,'APPROVED');wallet.close();wallet=new Wallet(options);wallet.broadcast=async wire=>{calls++;const out=x.run(x.s,[wire.body.action]);assert.equal(out.money.requests[prepared.pid].status,'RESERVED');};
  assert.equal((await wallet.resume(prepared.pid)).status,'RESERVATION_SUBMITTED');assert.equal(calls,1);
  x.s=x.run(x.s,[x.policyAction(x.s,{current:x.approver})]);assert.equal((await wallet.resume(prepared.pid)).status,'APPROVAL_REQUIRED');assert.equal(calls,1);
 }finally{wallet.close();}
});

test('protected review survives 24 blocks but cannot bypass signature or extend the 600-block bound',async()=>{
 const x=setup();x.s.authority.resourceLimits={activation:1};
 const home=mkdtempSync(join(tmpdir(),'duebyte-human-review-')),wallet=new Wallet({client:{config:x.c,sync:async()=>({state:x.s})},key:x.f.alice,home,routes:Object.fromEntries(Object.keys(x.c.initial.nodes).map(id=>[id,'http://127.0.0.1:1'])),url:'http://127.0.0.1:1',checkpoint:{}});
 try{
  const p=await wallet.prepare(x.f.bob.publicKey,'1'),request=await wallet.approvalRequest(p.pid);assert.equal(request.intent.lastReserve,x.s.money.height+600);
  for(let n=0;n<30;n++)x.s=x.run(x.s,[],x.s.money.time+2);
  const refreshed=await wallet.approvalRequest(p.pid),approval={body:refreshed.body,signature:sign(refreshed.body,x.approver.privateKey)};
  await wallet.acceptApproval(p.pid,approval);wallet.broadcast=async wire=>{assert.equal(x.run(x.s,[wire.body.action]).money.requests[p.pid].status,'RESERVED');};
  assert.equal((await wallet.resume(p.pid)).status,'RESERVATION_SUBMITTED');
  const wire=JSON.parse(wallet.db.prepare('SELECT body FROM outgoing WHERE pid=?').get(p.pid).body);delete wire.body.action.approval;assert.throws(()=>x.run(x.s,[wire.body.action]));
  const far={...refreshed.intent,lastReserve:x.s.money.height+602,deadline:x.s.money.height+666};
  const {resourcePaymentId}=await import('../resource-limits.mjs');far.pid=resourcePaymentId(far,x.s.configHash);
  assert.throws(()=>x.run(x.s,[x.reserve(x.s,far)]),/bounded admission/);
 }finally{wallet.close();}
});

test('normal disable retains offline recovery without requiring it; replacement requires possession',()=>{
 const x=setup(),a=x.policyAction(x.s,{current:x.approver,enabled:false});a.signatures.recovery=null;
 assert.equal(x.run(x.s,[a]).spendPolicies[x.f.alice.publicKey].enabled,false);
 const changed=x.policyAction(x.s,{current:x.approver,enabled:false,nextRecovery:keys()});changed.signatures.recovery=null;
 assert.throws(()=>x.run(x.s,[changed]),/new recovery possession/);
 a.signatures.current=null;assert.throws(()=>x.run(x.s,[a]),/current approval/);
});

test('disabling protection never silently sends an already prepared protected payment',async()=>{
 const x=setup(),home=mkdtempSync(join(tmpdir(),'duebyte-disable-pending-')),options={client:{config:x.c,sync:async()=>({state:x.s})},key:x.f.alice,home,routes:Object.fromEntries(Object.keys(x.c.initial.nodes).map(id=>[id,'http://127.0.0.1:1'])),url:'http://127.0.0.1:1',checkpoint:{}};
 let wallet=new Wallet(options);const p=await wallet.prepare(x.f.bob.publicKey,'1');wallet.close();wallet=new Wallet(options);let calls=0;wallet.broadcast=async()=>{calls++;};
 try{x.s=x.run(x.s,[x.policyAction(x.s,{current:x.approver,enabled:false})]);assert.equal((await wallet.resume(p.pid)).status,'AWAITING_APPROVAL');assert.equal(calls,0);}finally{wallet.close();}
});
