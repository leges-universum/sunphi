import test from 'node:test';import assert from 'node:assert/strict';
import {setupReserves} from './network-reserves.test.mjs';
import {origin,stateHash} from '../core.mjs';import {hash,sign} from '../crypto.mjs';
import {ECONOMIC_POLICY_VERSION} from '../economic-policy-v2.mjs';
function ready(){const x=setupReserves();let s=origin(x.c);s=x.run(s,[x.prepare(s)]);
 const body={domain:'DUEBYTE_ECONOMIC_PREPARATION_V2',network:x.c.chainId,configHash:s.configHash,
  generation:0,notBefore:s.height+1,expires:s.height+10,version:ECONOMIC_POLICY_VERSION,
  supplyBefore:s.money.supply,unitScale:'1'};
 const action={type:'PREPARE_ECONOMY_V2',certificate:{body,approvals:x.validators.slice(0,7).map(k=>({key:k.publicKey,signature:sign(body,k.privateKey)}))},founderConsent:sign(body,x.founder.privateKey)};
 return{...x,s,action};}
test('consensus preparation preserves money and reserve custody, survives restart and is idempotent',()=>{
 const x=ready(),money=structuredClone(x.s.money),reserves=structuredClone(x.s.networkReserves);
 let s=x.run(x.s,[x.wire(x.action)]);assert.deepEqual({...s.money,height:money.height},money);
 assert.deepEqual(s.networkReserves,reserves);assert.equal(s.economicPreparation.plan.issuanceEnabled,false);
 const plan=structuredClone(s.economicPreparation);s=JSON.parse(JSON.stringify(s));stateHash(s,x.c);
 s=x.run(s,[x.wire(x.action),x.wire(x.action)]);assert.deepEqual(s.economicPreparation,plan);
 assert.equal(s.money.supply,money.supply);assert.equal(s.rewards,undefined);
 assert.throws(()=>x.run(s,[x.enable(s)]),/legacy issuance/);
 assert.throws(()=>x.run(s,[x.issue(s)]),/legacy issuance/);
});
test('six validators, duplicate validators, forged founder, wrong network and changed supply cannot prepare',()=>{
 const x=ready();const cases=[];
 for(const which of ['six','duplicate','founder','network','supply']){const a=structuredClone(x.action);
  if(which==='six')a.certificate.approvals.pop();
  if(which==='duplicate')a.certificate.approvals[6]=a.certificate.approvals[0];
  if(which==='founder')a.founderConsent=sign(a.certificate.body,x.f.bob.privateKey);
  if(which==='network')a.certificate.body.network='duebyte-trial-other';
  if(which==='supply')a.certificate.body.supplyBefore='1';
  assert.throws(()=>x.run(x.s,[x.wire(a)]),which);cases.push(which);
 }assert.equal(cases.length,5);assert.equal(x.s.money.supply,'1600');
});
test('snapshot tampering cannot change economic amounts or enable issuance',()=>{
 const x=ready(),s=x.run(x.s,[x.wire(x.action)]);
 for(const change of [p=>p.capMicro='1',p=>p.issuanceEnabled=true,p=>p.emissionStart=1000,p=>p.extra='unauthorized']){
  const bad=structuredClone(s);change(bad.economicPreparation.plan);bad.economicPreparation.planHash=hash(bad.economicPreparation.plan);
  assert.throws(()=>stateHash(bad,x.c));
 }
});
