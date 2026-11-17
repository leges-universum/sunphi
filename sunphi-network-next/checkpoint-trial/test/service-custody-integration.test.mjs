// Monetary-adapter qualification. Test-only instance interception invokes the
// internal adapter inside the REAL bounded monetary frame and SQLite commit.
// This does NOT qualify a public work-admission/allocation activation contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {hash,sign,keys} from '../crypto.mjs';
import {issuanceFixture,certify} from './century-issuance.test.mjs';
import {rig} from './bounded-century.test.mjs';
import {ISSUE_CENTURY,START_CENTURY,applyCenturyIssuance} from '../century-issuance.mjs';
import {reserveServiceCustody,creditServiceCustody,serviceFundingAvailable} from '../research/service-custody.mjs';
import {REWARDS,walletConsent,rewardNodeId} from '../node-rewards.mjs';
import {guardCustodyRequest} from '../research/bounded-century-context.mjs';

function fixture(withHome=false){
 const x=issuanceFixture({utc:true,...(withHome?{expanded:true,workerCount:10}:{} )});let s=applyCenturyIssuance(x.s,certify(x,x.s,ISSUE_CENTURY,{supplyBefore:x.s.money.supply}),x.c,x.founder.publicKey);
 s=applyCenturyIssuance(s,certify(x,s,START_CENTURY,{settings:{controllerPolicy:{maximumRiseMicroPerSecond:'1000',operationalRateMicroPerSecond:'10000',intervalSeconds:600},maxPaymentMicro:'1234567',timeBasis:x.c.obligationClock,ttlSeconds:120}}),x.c,x.founder.publicKey);
 const r=rig(x,s,false,false);let operation;
 let home=null;
 if(withHome){
  home={identity:keys(),work:keys(),management:keys()};home.node=rewardNodeId(s.configHash,home.work.publicKey);
  const peer=createHash('sha256').update(Buffer.from(home.identity.publicKey,'base64url')).digest('hex').slice(0,40);
  const body={domain:REWARDS+'/ALLOW_REWARD_NODES_V1',network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:r.s.height+1,expires:r.s.height+3,peers:[peer]};
  r.step([x.wire({type:'ALLOW_REWARD_NODES_V1',certificate:{body,approvals:x.approvals(body)}})]);
  const b={domain:REWARDS+'/REGISTER',configHash:s.configHash,identity:home.identity.publicKey,work:home.work.publicKey,management:home.management.publicKey};
  r.step([x.wire({type:'REGISTER_REWARD_NODE_V1',body:b,identitySignature:sign(b,home.identity.privateKey),workSignature:sign(b,home.work.privateKey),managementSignature:sign(b,home.management.privateKey)},home.work)]);
 }
 const install=()=>{const original=r.db._action.bind(r.db);r.db._action=(s,t,rules,tx)=>{
  if(t.body.action.adapterTest){assert(operation);operation(s,tx);return s;}return original(s,t,rules,tx);
 };};install();
 const marker=x.wire({type:'REGISTER_REWARD_NODE_V1',adapterTest:true});
 return {x,r,home,marker,install,run(fn){operation=fn;try{return r.step([marker]);}finally{operation=null;}},set(fn){operation=fn;}};
}
const rows=(s,total='200000000')=>{
 const nodes=Object.keys(s.rewards.nodes).sort(),n=BigInt(nodes.length),v=BigInt(total);
 return nodes.map((node,i)=>({node,valueMicro:String(v/n+(BigInt(i)<v%n?1n:0n))}));
};
const owned=(s,owner)=>Object.values(s.money.outputs).filter(o=>o.owner===owner).reduce((n,o)=>n+BigInt(o.value),0n);

test('preissued service uses real custody, existing earned/paid queue and unchanged supply',()=>{
 const f=fixture(true),{x,r,home}=f;
 try{
  assert.equal(Object.keys(r.s.rewards.nodes).length,11);
  for(const node of Object.keys(r.s.rewards.nodes)){const key=node===home.node?home.management:x.key(node),body={domain:REWARDS+'/BIND',configHash:r.s.configHash,node,sequence:1,payouts:[{wallet:x.f.bob.publicKey,weight:1}]};
   r.step([x.wire({type:'BIND_REWARD_WALLETS_V1',body,signature:sign(body,key.privateKey),consents:[sign(walletConsent(r.s.configHash,node,x.f.bob.publicKey),x.f.bob.privateKey)]},key)]);}
  const supply=r.s.money.supply,fees=r.s.rewards.collected,minted=r.s.rewards.minted,before=owned(r.s,x.f.bob.publicKey);
  f.run(s=>reserveServiceCustody(s,'200000000'));
  const awards=rows(r.s);f.run(s=>creditServiceCustody(s,awards,'200000000'));
  assert.equal(r.s.money.supply,supply);assert.equal(r.s.rewards.collected,fees);assert.equal(r.s.rewards.minted,minted);
  assert.equal(r.s.rewards.preissuedServiceMicro,'200000000');assert.equal(r.s.centuryWarmup.serviceFunding.reservedMicro,'0');
  r.reopen();f.install();r.step();
  assert.equal(owned(r.s,x.f.bob.publicKey)-before,200000000n);
  assert(Object.values(r.s.rewards.nodes).every(n=>n.earned===n.paid));assert.equal(r.s.money.supply,supply);
  const last=r.step();assert(r.db.commitBlock(last.request,r.db.root).value.duplicate);assert.equal(owned(r.s,x.f.bob.publicKey)-before,200000000n);
 }finally{r.db.close();}
});

test('insufficient free source never creates unbacked claims; ordinary top-ups stay forbidden',()=>{
 const f=fixture(),{r}=f;try{
  const free=serviceFundingAvailable(r.s.centuryWarmup,r.s.money);
  f.run(s=>reserveServiceCustody(s,String(free)));
  assert.equal(serviceFundingAvailable(r.s.centuryWarmup,r.s.money),0n);
  const root=r.db.root,supply=r.s.money.supply;
  assert.throws(()=>f.run(s=>reserveServiceCustody(s,'200000000')),/insufficient/);assert.equal(r.db.root,root);
  assert.throws(()=>guardCustodyRequest(r.s,{domain:'DUEBYTE_TRANSITION_MODEL_V1/INTENT',sender:keys().publicKey,recipient:r.s.centuryWarmup.accounts[0]}),/programme custody/);
  assert.equal(r.s.money.supply,supply);assert(Object.values(r.s.rewards.nodes).every(n=>n.earned==='0'));
 }finally{r.db.close();}
});

test('failed SQLite commit cannot debit source or persist earned claims; restart resumes exact amount',()=>{
 const f=fixture(),{r}=f;try{
  f.run(s=>reserveServiceCustody(s,'200000000'));const awards=rows(r.s),root=r.db.root,before=hash(r.s);
  const request={height:r.s.height+1,time:r.s.money.time,blockHash:hash('service adapter crash'),txs:[Buffer.from(JSON.stringify(f.marker))]};
  f.set(s=>creditServiceCustody(s,awards,'200000000'));
  assert.throws(()=>r.db.commitBlock(request,root,{beforeCommit:()=>{throw Error('storage interrupted');}}),/storage interrupted/);
  assert.equal(r.db.root,root);r.reopen();f.install();assert.equal(hash(r.s),before);
  f.run(s=>creditServiceCustody(s,awards,'200000000'));r.reopen();f.install();
  assert.equal(r.s.rewards.preissuedServiceMicro,'200000000');assert.equal(r.s.centuryWarmup.serviceFunding.spentMicro,'200000000');
  const after=r.db.root;assert.throws(()=>f.run(s=>creditServiceCustody(s,awards,'200000000')),/unbacked/);assert.equal(r.db.root,after);
 }finally{r.db.close();}
});

test('bad recipients, duplicate rows, altered sum and source counters fail atomically',()=>{
 const f=fixture(),{r}=f;try{
  f.run(s=>reserveServiceCustody(s,'200000000'));const root=r.db.root,awards=rows(r.s);
  for(const invalid of [awards.toReversed(),[awards[0],awards[0]],[{node:hash('unregistered'),valueMicro:'200000000'}]]){
   assert.throws(()=>f.run(s=>creditServiceCustody(s,invalid,'200000000')));assert.equal(r.db.root,root);
  }
  assert.throws(()=>f.run(s=>creditServiceCustody(s,awards,'200000001')),/credit total/);assert.equal(r.db.root,root);
  assert.throws(()=>f.run(s=>{s.rewards.preissuedServiceMicro='1';creditServiceCustody(s,awards,'200000000');}),/source binding/);assert.equal(r.db.root,root);
 }finally{r.db.close();}
});
