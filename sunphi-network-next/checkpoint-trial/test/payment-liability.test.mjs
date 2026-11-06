import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture} from '../../research/transition-core-20261103/fixture.mjs';
import {PROFILE,origin,block,envelope,stateHash,workReceipt} from '../core.mjs';
import {keys,hash,sign,canonical} from '../crypto.mjs';
import {CONTROL,RESOURCE_FEATURE} from '../authority.mjs';
import {resourcePaymentId,maintainResources} from '../resource-limits.mjs';
import {RESERVES,reserveConsent,unrestrictedDevelopmentControls} from '../network-reserves.mjs';
import {LIABILITY,liabilityConsent,attestationBody,liabilityAttestation,eligibleLiabilityWorker} from '../payment-liability.mjs';
import {protectionSummary} from '../protection-reserve.mjs';
import {recoveryBody} from '../reserve-recovery.mjs';
import {prepareRecoveryRequest} from '../reserve-management-vault.mjs';
import {prepareFounderAction} from '../reserve-custody.mjs';
import {audit,oid,SCHEDULE_DOMAIN} from '../payment-model.mjs';
import {plan,balances} from '../wallet.mjs';
import {Store} from '../store.mjs';

function setup({prepare=true,consent=true,founderNodes=[],sameGroup=false,penaltyBps=2000,challengeBlocks=3,suspensionBlocks=8}={}){
 const f=fixture(),validators=Array.from({length:10},keys),members=Array.from({length:4},keys),founder=keys(),backups=Array.from({length:3},keys);f.state.time=1000;
 if(sameGroup)for(const n of Object.values(f.state.nodes))n.operator=hash('one-owner');
 const c={profile:PROFILE,chainId:'duebyte-trial-protection-tests',trialOnly:true,initial:f.state,control:{validators:validators.map((k,i)=>({key:k.publicKey,group:hash({i})})),policy:{version:1,members:members.map((k,i)=>({key:k.publicKey,group:hash({i})})),threshold:3,maxAge:3600,notAfter:200000}}};
 const wire=(a,k=f.alice)=>envelope(c,a,k),run=(s,txs=[],time=s.money.time)=>block(s,c,{height:s.height+1,blockHash:hash({height:s.height+1}),time,txs:txs.map(t=>Buffer.from(JSON.stringify(t)))}).state;
 const approvals=b=>validators.slice(0,7).map(k=>({key:k.publicKey,signature:sign(b,k.privateKey)}));
 const resourceBody={domain:CONTROL+'/FEATURE',network:c.chainId,configHash:hash(c),generation:0,feature:RESOURCE_FEATURE,activation:4,notBefore:1,expires:2};
 const reservePolicy={warmup:{allocation:'100000000',dailyFeeBudget:'6',maxPayment:'90',intervalSeconds:5,ttlBlocks:10},development:{allocation:'1000000000',manager:founder.publicKey,controls:unrestrictedDevelopmentControls(),recovery:{keys:backups.map(k=>k.publicKey).sort(),threshold:2,delaySeconds:86400}}};
 const rb={domain:RESERVES+'/PREPARE_NETWORK_RESERVES_V1',network:c.chainId,configHash:hash(c),generation:0,notBefore:1,expires:3,policy:reservePolicy},rc=reserveConsent(hash(c),reservePolicy);
 let s=run(origin(c),[wire({type:'ENABLE_RESOURCE_LIMITS',certificate:{body:resourceBody,approvals:approvals(resourceBody)}}),wire({type:'PREPARE_NETWORK_RESERVES_V1',certificate:{body:rb,approvals:approvals(rb)},founderConsent:sign(rc,founder.privateKey),recoveryConsents:backups.map(k=>({key:k.publicKey,signature:sign(rc,k.privateKey)})).sort((a,b)=>a.key<b.key?-1:1)})]);while(s.height<4)s=run(s);
 const policy={version:1,activation:10,challengeBlocks,suspensionBlocks,exceptionDelaySeconds:86400,penaltyBps,maxOpen:32,founderKey:founder.publicKey,founderGroup:hash('founder-group'),founderNodes:founderNodes.map(i=>f.ids[i])};
 const body={domain:LIABILITY+'/POLICY',network:c.chainId,configHash:hash(c),generation:0,notBefore:5,expires:7,policy},prepareAction={type:'PREPARE_PAYMENT_LIABILITY_V1',certificate:{body,approvals:approvals(body)},founderConsent:sign(body,founder.privateKey)};
 const key=node=>({publicKey:s.money.nodes[node].key,privateKey:f.nodeKeys[node]});
 if(prepare){s=run(s,[wire(prepareAction)]);if(consent)s=run(s,f.ids.map(node=>wire({type:'ACCEPT_PAYMENT_LIABILITY_V1',node,signature:sign(liabilityConsent(s.money,node),f.nodeKeys[node])},key(node))));while(s.height<policy.activation)s=run(s);}
 const intent=(state,over={})=>{const i=f.intent({lastReserve:state.money.height+4,deadline:state.money.height+20,...over});i.pid=resourcePaymentId(i,hash(c));return i;};
 const reserve=i=>wire({type:i.domain===SCHEDULE_DOMAIN?'SCHEDULE_PAYMENT_V1':'RESERVE',signed:f.sign(i)});
 const finish=(state,i)=>wire({type:'FINALIZE',pid:i.pid,request:hash(i),receipts:i.parts.flatMap((p,index)=>p.nodes.map(node=>workReceipt(state,i.pid,index,node,key(node))))});
 const fault=(state,i,index=0,node=i.parts[index].nodes[0],claim={recipient:f.bob.publicKey,value:'999',partValue:i.parts[index].value})=>{const body=attestationBody(state.money,i.pid,index,node,claim);return {type:'REPORT_PAYMENT_FAULT_V1',attestation:{body,signature:sign(body,f.nodeKeys[node])}};};
 const drain=(state,pid)=>{let guard=0;while(state.money.liability.records[pid]){assert(guard++<200);state=run(state);}return state;};
 const queue=(state,over={})=>({type:'QUEUE_PROTECTION_PAYMENT_V1',managementEpoch:state.networkReserves.development.access.epoch,sequence:state.money.liability.protection.sequence+1,recipient:f.bob.publicKey,value:'2',purpose:'Exceptional incident support',reference:hash('public incident evidence'),validUntil:state.money.time+300,...over});
 const funded=()=>{const i=intent(s);let state=run(s,[reserve(i)]);state=run(state,[wire(fault(state,i))]);state=drain(state,i.pid);return {s:state,i};};
 return {f,c,validators,founder,backups,s,policy,run,wire,key,intent,reserve,finish,fault,drain,queue,funded,prepareAction,approvals};
}

test('preparation and opt-in require signed future policy, quorum, founder and worker authority; mint remains off',()=>{
 const x=setup({prepare:false});assert.equal(x.s.money.supply,'1600');assert.equal(x.s.networkReserves.issued,null);
 for(const mutation of [a=>a.certificate.approvals.pop(),a=>a.founderConsent=sign(a.certificate.body,keys().privateKey),a=>a.certificate.body.network+='-other',a=>a.certificate.body.policy.activation=6]){const a=structuredClone(x.prepareAction);mutation(a);assert.throws(()=>x.run(x.s,[x.wire(a)]));}
 let s=x.run(x.s,[x.wire(x.prepareAction)]);assert.deepEqual(s.money.outputs,x.s.money.outputs);assert.equal(s.money.liability.pool,'0');assert.throws(()=>x.run(s,[x.wire(x.prepareAction)]));
 const node=x.f.ids[0],a={type:'ACCEPT_PAYMENT_LIABILITY_V1',node,signature:sign(liabilityConsent(s.money,node),x.f.nodeKeys[node])};assert.throws(()=>x.run(s,[x.wire(a)]),/consent author/);s=x.run(s,[x.wire(a,x.key(node))]);assert(s.money.liability.consents[node]);
});

test('unconsenting workers cannot be selected or reserved; policy never penalizes legacy assignments',()=>{
 const x=setup({consent:false});assert.throws(()=>plan(x.s.money,'10'));assert.throws(()=>x.run(x.s,[x.reserve(x.intent(x.s))]),/consent/);
 const y=setup({prepare:false}),i=y.intent(y.s);let s=y.run(y.s,[y.reserve(i),y.wire(y.prepareAction)]);while(s.height<10)s=y.run(s);assert(!s.money.liability.records[i.pid]);s=y.run(s,[y.finish(s,i)]);assert.equal(s.money.requests[i.pid].status,'SETTLED');assert.equal(s.money.liability.pool,'0');assert(Object.values(s.money.nodes).every(n=>n.taskHeld==='0'));
});

test('honest payment settles atomically; collateral releases automatically after consensus-block window',()=>{
 const x=setup(),i=x.intent(x.s);let s=x.run(x.s,[x.reserve(i)]);s=x.run(s,[x.finish(s,i)]);assert.equal(s.money.outputs[oid(i.pid,'recipient')].value,'100');assert.equal(s.money.nodes[x.f.ids[0]].taskHeld,'50');const release=s.money.liability.records[i.pid].release;
 assert.throws(()=>x.run(s,[x.wire({type:'RESOLVE_PAYMENT_FAULT_V1',pid:i.pid})]),/release window/);
 while(s.height<release)s=x.run(s);assert(!s.money.liability.records[i.pid]);assert(Object.values(s.money.nodes).every(n=>n.taskHeld==='0'&&n.stake==='100'));assert.equal(s.money.liability.pool,'0');assert.equal(s.money.supply,'1600');
});

test('forged signatures, correct statements, cross-network and unrelated evidence cannot punish anyone',()=>{
 const x=setup(),i=x.intent(x.s),s=x.run(x.s,[x.reserve(i)]),before=hash(s),node=i.parts[0].nodes[0];const correct={type:'REPORT_PAYMENT_FAULT_V1',attestation:liabilityAttestation(s.money,i.pid,0,node,x.key(node))};assert.throws(()=>x.run(s,[x.wire(correct)]),/not a fault/);
 for(const change of [a=>a.attestation.signature=sign(a.attestation.body,keys().privateKey),a=>a.attestation.body.network+='-other',a=>a.attestation.body.pid=hash('wrong payment'),a=>a.attestation.body.index=9,a=>a.recipient=x.f.alice.publicKey,a=>a.attestation.body.claim.value='-1']){const a=x.fault(s,i);change(a);assert.throws(()=>x.run(s,[x.wire(a)]));assert.equal(hash(s),before);}
});

test('single proved liar: refund principal, compensate only abort fee, retain fine in separate reserve',()=>{
 const x=setup(),i=x.intent(x.s);let s=x.run(x.s,[x.reserve(i)]);const a=x.fault(s,i),node=i.parts[0].nodes[0];s=x.run(s,[x.wire(a)]);assert(!eligibleLiabilityWorker(s.money,node));assert.throws(()=>x.run(s,[x.wire(a)]),/duplicate fault/);assert.equal(s.money.nodes[node].stake,'100');
 s=x.drain(s,i.pid);assert.equal(s.money.requests[i.pid].status,'EXPIRED');assert.equal(s.money.outputs[oid(i.pid,'refund')].value,'999');assert.equal(balances(s,x.f.alice.publicKey).available,'1000');assert.equal(s.money.nodes[node].stake,'90');assert.equal(s.money.liability.pool,'9');assert.equal(s.money.liability.protection.collected,'10');assert.equal(s.money.liability.protection.compensated,'1');assert.equal(s.money.fees,'1');assert.equal(s.money.supply,'1600');assert.equal(s.networkReserves.issued,null);assert(!s.rewards);assert.throws(()=>x.run(s,[x.wire(a)]),/assignment/);audit(s.money);
});

test('valid corrected receipts allow settlement after false evidence, without imaginary principal compensation',()=>{
 const x=setup(),i=x.intent(x.s);let s=x.run(x.s,[x.reserve(i)]);s=x.run(s,[x.wire(x.fault(s,i))]);s=x.run(s,[x.finish(s,i)]);s=x.drain(s,i.pid);assert.equal(s.money.outputs[oid(i.pid,'recipient')].value,'100');assert.equal(s.money.liability.pool,'10');assert.equal(s.money.liability.protection.compensated,'0');
});

test('three colluding workers still cannot settle false payment facts; compensation is paid once',()=>{
 const x=setup(),i=x.intent(x.s);let s=x.run(x.s,[x.reserve(i)]);const bad=x.finish(s,i).body.action;for(let j=0;j<3;j++)bad.receipts[j].attestation=x.fault(s,i,0,i.parts[0].nodes[j]).attestation.signature;assert.throws(()=>x.run(s,[x.wire(bad)]),/fault signature/);
 s=x.run(s,i.parts[0].nodes.map(node=>x.wire(x.fault(s,i,0,node))));s=x.drain(s,i.pid);assert.equal(s.money.liability.protection.collected,'30');assert.equal(s.money.liability.protection.compensated,'1');assert.equal(s.money.liability.pool,'29');assert(!s.money.outputs[oid(i.pid,'recipient')]);assert.throws(()=>x.run(s,[x.wire({type:'RESOLVE_PAYMENT_FAULT_V1',pid:i.pid})]));audit(s.money);
});

test('repeated proof within one payment is not a second incident; readmission requires settlement and cooling',()=>{
 const x=setup({suspensionBlocks:30}),nodes=x.f.ids.slice(0,3),i=x.intent(x.s,{parts:[{value:'50',nodes},{value:'50',nodes:x.f.ids.slice(3)}]});let s=x.run(x.s,[x.reserve(i)]),node=nodes[0];s=x.run(s,[x.wire(x.fault(s,i))]);const readmit=()=>x.wire({type:'READMIT_PAYMENT_WORKER_V1',node},x.key(node));assert.throws(()=>x.run(s,[readmit()]),/suspension/);s=x.drain(s,i.pid);while(s.height<s.money.liability.discipline[node].until)s=x.run(s);s=x.run(s,[readmit()]);assert(eligibleLiabilityWorker(s.money,node));
 const next=x.intent(s,{inputs:[oid(i.pid,'refund')],value:'50',fee:'2',parts:[{value:'50',nodes}]});s=x.run(s,[x.reserve(next)]);s=x.run(s,[x.wire(x.fault(s,next))]);s=x.drain(s,next.pid);assert.equal(s.money.liability.discipline[node].incidents.length,2);assert.throws(()=>x.run(s,[readmit()]),/permanently/);
});

test('founder exception permits explicit same-owner workers but never bypasses collateral, proof or opt-in',()=>{
 const x=setup({sameGroup:true,founderNodes:[0,1,2]});const parts=plan(x.s.money,'50');assert.equal(parts.length,1);const i=x.intent(x.s,{value:'50',fee:'2',parts});let s=x.run(x.s,[x.reserve(i)]);s=x.run(s,[x.wire(x.fault(s,i))]);s=x.drain(s,i.pid);assert.equal(s.money.liability.pool,'9');assert.throws(()=>plan(x.s.money,'1000'));
 const y=setup({sameGroup:true});assert.throws(()=>plan(y.s.money,'50'));assert.throws(()=>y.run(y.s,[y.reserve(y.intent(y.s))]),/operator separation/);
});

test('fractional penalty rounds up and cannot mint or draw unrelated pool for fee farming',()=>{
 const x=setup({penaltyBps:1}),i=x.intent(x.s,{value:'1',fee:'1',parts:[{value:'1',nodes:x.f.ids.slice(0,3)}]});let s=x.run(x.s,[x.reserve(i)]);s=x.run(s,[x.wire(x.fault(s,i))]);s=x.drain(s,i.pid);assert.equal(s.money.liability.protection.collected,'1');assert.equal(s.money.liability.pool,'0');assert.equal(balances(s,x.f.alice.publicKey).available,'1000');
});

test('founder exceptional payment needs purpose, signature, funds and full delay; cancellation and replay work',()=>{
 const x=setup();let {s}=x.funded();const original=s.money.supply,q=x.queue(s);assert.throws(()=>x.run(s,[x.wire(q)]),/management signature/);for(const over of [{value:'10'},{value:'0'},{purpose:' '},{reference:'no'},{managementEpoch:99},{validUntil:1}])assert.throws(()=>x.run(s,[x.wire({...q,...over},x.founder)]));
 const prepared=prepareFounderAction({config:x.c,state:s,key:x.founder,action:q});assert.equal(prepared.preview.name,'DueByte Protection Reserve');s=x.run(s,[prepared.wire]);assert.equal(s.money.liability.pool,'9');assert.throws(()=>x.run(s,[x.wire(q,x.founder)]),/pending/);assert.throws(()=>x.run(s,[x.wire({type:'EXECUTE_PROTECTION_PAYMENT_V1',sequence:1})]),/window/);
 s=x.run(s,[x.wire({type:'CANCEL_PROTECTION_PAYMENT_V1',sequence:1,managementEpoch:0},x.founder)]);assert.equal(s.money.liability.pool,'9');assert.throws(()=>x.run(s,[prepared.wire]),/equal/);
 s=x.run(s,[x.wire(x.queue(s),x.founder)]);const at=s.money.liability.protection.pending.executeAt;s=x.run(s,[x.wire({type:'EXECUTE_PROTECTION_PAYMENT_V1',sequence:2})],at);assert.equal(s.money.liability.pool,'7');assert.equal(s.money.liability.protection.exceptional,'2');assert.equal(balances(s,x.f.bob.publicKey).available,'2');assert.equal(s.money.supply,original);assert.throws(()=>x.run(s,[x.wire({type:'EXECUTE_PROTECTION_PAYMENT_V1',sequence:2})]));assert.equal(protectionSummary(s).authorityExpiresAt,null);
});

test('expired founder instruction cannot be executed and releases pending allocation',()=>{
 const x=setup();let {s}=x.funded();s=x.run(s,[x.wire(x.queue(s),x.founder)]);s=x.run(s,[],s.money.liability.protection.pending.expiresAt+1);assert.equal(s.money.liability.protection.pending,null);assert.equal(s.money.liability.pool,'9');assert.equal(s.money.liability.protection.recent.at(-1).reason,'EXPIRED');
});

test('manager rotation cancels queued payment immediately; old key and epoch lose spending authority',()=>{
 const x=setup();let {s}=x.funded();s=x.run(s,[x.wire(x.queue(s),x.founder)]);const manager=keys(),a={type:'ROTATE_DEVELOPMENT_MANAGER_V1',managementEpoch:0,manager:manager.publicKey};a.newConsent=sign(recoveryBody(s,a.type,{manager:a.manager}),manager.privateKey);s=x.run(s,[x.wire(a,x.founder)]);assert.equal(s.money.liability.protection.pending,null);assert.equal(protectionSummary(s).manager,manager.publicKey);assert.throws(()=>x.run(s,[x.wire(x.queue(s),x.founder)]),/signature/);s=x.run(s,[x.wire(x.queue(s),manager)]);assert(s.money.liability.protection.pending);
});

test('two-of-three founder recovery freezes exceptional spending but does not confiscate balances',()=>{
 const x=setup();let {s}=x.funded();s=x.run(s,[x.wire(x.queue(s),x.founder)]);const moneyBefore=structuredClone(s.money),a=prepareRecoveryRequest({state:s,manager:keys(),recoveryKeys:Array.from({length:3},keys),authorizingKeys:x.backups.slice(0,2),expiresAt:s.money.time+300});s=x.run(s,[x.wire(a)]);assert.equal(s.money.liability.protection.pending,null);assert.equal(s.money.liability.pool,'9');assert.deepEqual(s.money.outputs,moneyBefore.outputs);assert.equal(s.money.supply,moneyBefore.supply);assert.throws(()=>x.run(s,[x.wire(x.queue(s),x.founder)]),/recovery pending/);
});

test('restart/snapshot retains evidence, protection balance and exactly-once delayed settlement',()=>{
 const x=setup(),i=x.intent(x.s);let s=x.run(x.s,[x.reserve(i)]);s=x.run(s,[x.wire(x.fault(s,i))]);while(s.money.requests[i.pid].status==='RESERVED')s=x.run(s);const file=join(mkdtempSync(join(tmpdir(),'duebyte-liability-')),'state.sqlite');let db=new Store(file,x.c);db.restore(s);db.close();db=new Store(file,x.c);const restored=db.state;db.close();assert.equal(stateHash(restored,x.c),stateHash(s,x.c));const a=x.drain(s,i.pid),b=x.drain(restored,i.pid);assert.equal(stateHash(a,x.c),stateHash(b,x.c));assert.equal(a.money.liability.protection.compensated,'1');
});

test('tampered snapshot assignments, pool, proof and counters fail validation',()=>{
 const x=setup(),i=x.intent(x.s);let s=x.run(x.s,[x.reserve(i)]);s=x.run(s,[x.wire(x.fault(s,i))]);for(const change of [q=>q.money.liability.pool='100',q=>q.money.liability.records[i.pid].assignments[0].partValue='1',q=>q.money.liability.records[i.pid].sender=x.f.bob.publicKey,q=>q.money.liability.height++,q=>q.money.liability.records[i.pid].faults['0:'+x.f.ids[0]].evidence.signature='bad']){const bad=structuredClone(s);change(bad);assert.throws(()=>stateHash(bad,x.c));}assert(Buffer.byteLength(canonical(s))<200000);
});

test('32-part covered payment stays within existing wire limit and all 96 receipts settle',()=>{
 const x=setup(),i=x.intent(x.s,{value:'32',fee:'1',parts:Array.from({length:32},()=>({value:'1',nodes:x.f.ids.slice(0,3)}))});let s=x.run(x.s,[x.reserve(i)]);const finish=x.finish(s,i);assert(Buffer.byteLength(JSON.stringify(finish))<=65536);s=x.run(s,[finish]);s=x.drain(s,i.pid);assert.equal(s.money.outputs[oid(i.pid,'recipient')].value,'32');assert(Object.values(s.money.nodes).every(n=>n.taskHeld==='0'));audit(s.money);
});

test('multiple false parts in one payment count as one incident, and timeout alone is never slashable',()=>{
 const x=setup(),nodes=x.f.ids.slice(0,3),i=x.intent(x.s,{value:'40',fee:'2',parts:[{value:'20',nodes},{value:'20',nodes}]});let s=x.run(x.s,[x.reserve(i)]);s=x.run(s,[x.wire(x.fault(s,i,0)),x.wire(x.fault(s,i,1))]);assert.equal(s.money.liability.discipline[nodes[0]].incidents.length,1);s=x.drain(s,i.pid);assert.equal(s.money.nodes[nodes[0]].stake,'92');assert.equal(s.money.liability.protection.compensated,'1');
 const y=setup(),honest=y.intent(y.s);let t=y.run(y.s,[y.reserve(honest)]);t=y.drain(t,honest.pid);assert.equal(t.money.liability.pool,'0');assert.equal(t.money.liability.protection.compensated,'0');assert.equal(t.money.fees,'1');assert.deepEqual(t.money.liability.discipline,{});assert(Object.values(t.money.nodes).every(n=>n.stake==='100'));
});

test('proven collateral survives pruning pressure and an unavailable caller; no manual release needed',()=>{
 const x=setup({challengeBlocks:100}),i=x.intent(x.s);let s=x.run(x.s,[x.reserve(i)]);s=x.run(s,[x.wire(x.fault(s,i))]);s=x.run(s,[x.finish(s,i)]);const terminal=structuredClone(s.money.requests[i.pid]);
 // Synthetic valid terminal history forces this oldest request past retention.
 for(let j=0;j<40;j++){const q=structuredClone(terminal);q.intent.pid=hash({older:j});q.digest=hash(q.intent);q.terminalHeight=s.money.height;s.money.requests[q.intent.pid]=q;}
 s.money.requests[i.pid].terminalHeight=1;s.money=maintainResources(s.money);assert(s.money.requests[i.pid]);s=x.drain(s,i.pid);assert.equal(s.money.liability.pool,'10');assert.equal(s.money.nodes[x.f.ids[0]].taskHeld,'0');
});

test('partition-style lack of committed blocks cannot execute a queued exception early',()=>{
 const x=setup();let {s}=x.funded();s=x.run(s,[x.wire(x.queue(s),x.founder)]);const oldHash=stateHash(s,x.c),copy=JSON.parse(JSON.stringify(s));assert.equal(stateHash(copy,x.c),oldHash);assert.equal(copy.money.liability.protection.exceptional,'0');assert.throws(()=>x.run(copy,[x.wire({type:'EXECUTE_PROTECTION_PAYMENT_V1',sequence:1})]),/window/);
 const at=s.money.liability.protection.pending.executeAt,a=x.run(s,[x.wire({type:'EXECUTE_PROTECTION_PAYMENT_V1',sequence:1})],at),b=x.run(copy,[x.wire({type:'EXECUTE_PROTECTION_PAYMENT_V1',sequence:1})],at);assert.equal(stateHash(a,x.c),stateHash(b,x.c));assert.equal(a.money.liability.protection.exceptional,'2');
});
