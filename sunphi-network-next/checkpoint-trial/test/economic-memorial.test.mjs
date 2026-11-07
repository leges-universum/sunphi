import test from 'node:test';import assert from 'node:assert/strict';
import {setupReserves} from './network-reserves.test.mjs';
import {origin,stateHash,applyTx} from '../core.mjs';import {hash,sign,keys} from '../crypto.mjs';
import {makeEconomicPlan,ECONOMIC_POLICY_VERSION,emissionBudget,anniversary} from '../economic-policy-v2.mjs';
import {makeEconomicPlanV3,economicTermsHash,ECONOMIC_POLICY_VERSION_V3,MEMORIAL_MICRO,TOTAL_CAP_MICRO,emissionBudgetV3,memorialMuseumEligibility} from '../economic-policy-v3.mjs';
import {CAP,UNIT} from '../ecosystem-century-model.mjs';
import {applyEconomicPreparation} from '../economic-preparation.mjs';
import {applyMemorialAction} from '../memorial-custody.mjs';
import {memorialTerms} from '../economic-presentation-v3.mjs';
const micro=n=>String(BigInt(n)*UNIT);
export function readyMemorial(){
 const x=setupReserves();let s=origin(x.c);s=x.run(s,[x.prepare(s)]);
 const prepare=(state,version=3,extra={})=>{
  const body={domain:'DUEBYTE_ECONOMIC_PREPARATION_V'+version,network:x.c.chainId,configHash:state.configHash,generation:state.authority.generation,notBefore:state.height,expires:state.height+100,version:version===3?ECONOMIC_POLICY_VERSION_V3:ECONOMIC_POLICY_VERSION,supplyBefore:state.money.supply,unitScale:state.money.unitScale??'1',...(version===3?{previousPlanHash:state.economicPreparation?.planHash??null,termsHash:economicTermsHash(makeEconomicPlanV3(state)),memorialManager:x.founder.publicKey}:{}),...extra};
  return{type:'PREPARE_ECONOMY_V'+version,certificate:{body,approvals:x.validators.slice(0,7).map(k=>({key:k.publicKey,signature:sign(body,k.privateKey)}))},founderConsent:sign(body,x.founder.privateKey)};
 };
 const prepared=()=>applyEconomicPreparation(s,prepare(s),x.c);
 return{...x,s,prepareEconomic:prepare,prepared};
}
function decision(s,manager,successor,extra={}){
 const m=s.economicPreparation.memorial,b={domain:'DUEBYTE_MEMORIAL_SUCCESSION_V1',configHash:s.configHash,planHash:s.economicPreparation.planHash,managerEpoch:m.epoch,sequence:m.sequence+1,successor:successor.publicKey,effectiveAt:s.money.time+10,expiresAt:s.money.time+100,publicDecision:'Public appointment of the memorial reserve successor; no spending authority.',reference:hash('public instrument'),...extra};
 return{type:'PUBLISH_MEMORIAL_SUCCESSION_V1',body:b,signature:sign(b,manager.privateKey),successorConsent:sign(b,successor.privateKey)};
}
const execute=s=>({type:'EXECUTE_MEMORIAL_SUCCESSION_V1',managementEpoch:s.economicPreparation.memorial.epoch,sequence:s.economicPreparation.memorial.sequence,decisionHash:hash(s.economicPreparation.memorial.pending)});
test('memorial total is exact and ordinary annual allowances never change',()=>{
 const x=readyMemorial();for(const supply of ['0','1600','2000','5000'])for(const scale of ['1','1000000']){
  const s=structuredClone(x.s);s.money.supply=String(BigInt(supply)*BigInt(scale));s.money.unitScale=scale;
  const old=makeEconomicPlan(s),p=makeEconomicPlanV3(s);assert.equal(p.capMicro,micro(10001000000));
  assert.equal(p.programmeCapMicro,String(CAP));assert.equal(p.memorialMicro,String(MEMORIAL_MICRO));assert.deepEqual(p.annualRegularMicro,old.annualRegularMicro);
  assert.equal(['existingSupplyMicro','regularMicro','warmupMicro','developmentMicro','founderMicro','memorialMicro'].reduce((n,k)=>n+BigInt(p[k]),0n),TOTAL_CAP_MICRO);
  assert.equal(p.annualRegularMicro.reduce((n,v)=>n+BigInt(v),0n),BigInt(p.regularMicro));
 }
});
test('public and consensus beneficiary definitions exclude namesakes and require original group membership',()=>{
 const x=readyMemorial(),p=makeEconomicPlanV3(x.s).memorial;
 for(const field of ['beneficiaryDefinition','namesakeEligibility','nameOrAccountRegistrationSufficient','earlyKeyPossessionAloneSufficient','laterBitcoinContributionAloneSufficient','groupMembership','groupPayment','unresolvedCompetingClaims'])assert.deepEqual(p[field],memorialTerms[field]);
 assert.equal(p.namesakeEligibility,false);assert.equal(p.claimExecutionEnabled,false);
 assert(p.beneficiaryDefinition.includes('ORIGINAL_COCREATOR_GROUP'));
});
test('V3 consensus preparation preserves money, historical snapshots and repeat delivery',()=>{
 const x=readyMemorial(),a=x.prepareEconomic(x.s),before=structuredClone(x.s);
 const s=applyEconomicPreparation(x.s,a,x.c);stateHash(s,x.c);assert.deepEqual(x.s,before);
 assert.deepEqual(s.money,before.money);assert.deepEqual(s.networkReserves,before.networkReserves);
 assert.equal(s.economicPreparation.memorial.manager,x.founder.publicKey);assert.equal(s.economicPreparation.memorial.issued,false);
 assert.deepEqual(applyEconomicPreparation(JSON.parse(JSON.stringify(s)),a,x.c),s);
 assert.equal(stateHash(before,x.c),stateHash(x.s,x.c));
 const viaCore=x.run(x.s,[x.wire(a)]);assert.equal(viaCore.economicPreparation.plan.capMicro,micro(10001000000));
});
test('V2 upgrades explicitly without downgrade or contradictory replay',()=>{
 const x=readyMemorial(),v2=applyEconomicPreparation(x.s,x.prepareEconomic(x.s,2),x.c),a=x.prepareEconomic(v2);
 const s=applyEconomicPreparation(v2,a,x.c);assert.deepEqual(s.money,v2.money);stateHash(s,x.c);
 assert.throws(()=>applyEconomicPreparation(s,x.prepareEconomic(s,2),x.c),/downgrade/);
 assert.throws(()=>applyEconomicPreparation(v2,x.prepareEconomic(v2,3,{previousPlanHash:null}),x.c),/previous/);
 assert.throws(()=>applyEconomicPreparation(s,x.prepareEconomic(s),x.c),/conflicting/);
});
test('valid signatures cannot authorize different terms, manager, supply, denomination or network',()=>{
 const x=readyMemorial();for(const extra of [{termsHash:hash('wrong')},{memorialManager:x.f.bob.publicKey},{supplyBefore:'1599'},{unitScale:'1000000'},{network:'duebyte-trial-other'},{generation:1},{notBefore:x.s.height+1},{expires:x.s.height+101}]){
  assert.throws(()=>applyEconomicPreparation(x.s,x.prepareEconomic(x.s,3,extra),x.c));
 }
 const a=x.prepareEconomic(x.s);a.certificate.approvals.pop();assert.throws(()=>applyEconomicPreparation(x.s,a,x.c));
 const forged=x.prepareEconomic(x.s);forged.founderConsent=sign(forged.certificate.body,x.f.bob.privateKey);assert.throws(()=>applyEconomicPreparation(x.s,forged,x.c));
});
test('tampered memorial policy, supply claim and custody are rejected even with a recomputed plan hash',()=>{
 const x=readyMemorial(),s=x.prepared();
 for(const mutate of [e=>e.plan.memorialMicro='0',e=>e.plan.capMicro=micro(10001000001),e=>e.plan.memorial.ordinarySpending=true,e=>e.plan.memorial.claimExecutionEnabled=true,e=>e.plan.emissionStart=1,e=>e.memorial.issued=true,e=>e.memorial.balanceMicro='1',e=>e.memorial.transferred=true]){
  const bad=structuredClone(s);mutate(bad.economicPreparation);bad.economicPreparation.planHash=hash(bad.economicPreparation.plan);assert.throws(()=>stateHash(bad,x.c));
 }
});
test('no ordinary transfers, legacy mint or made-up memorial mint can spend a prepared memorial reserve',()=>{
 const x=readyMemorial(),s=x.prepared(),account=s.economicPreparation.plan.memorial.account;
 const i=x.f.intent({recipient:account,lastReserve:s.money.height+3,deadline:s.money.height+8});
 assert.throws(()=>x.run(s,[x.wire({type:'RESERVE',signed:{intent:i,signature:sign(i,x.f.alice.privateKey)}})]),/memorial/);
 for(const type of ['ISSUE_MEMORIAL_V1','CLAIM_MEMORIAL_V1','PAY_MEMORIAL_MUSEUM_V1'])assert.throws(()=>x.run(s,[x.wire({type})]),/public action/);
 assert.throws(()=>x.run(s,[x.enable(s)]),/legacy issuance/);assert.throws(()=>x.run(s,[x.issue(s)]),/legacy issuance/);
 const before=hash(s);assert.throws(()=>applyTx(s,Buffer.from(JSON.stringify(x.wire({type:'ISSUE_MEMORIAL_V1'}))),x.c,s.money.time));assert.equal(hash(s),before);
});
test('public succession is signed, cancelable, time-bound and changes only management',()=>{
 const x=readyMemorial(),successor=keys();let s=x.prepared();const original=structuredClone(s.money),a=decision(s,x.founder,successor);
 s=applyMemorialAction(s,a,x.founder.publicKey);assert.deepEqual(applyMemorialAction(s,a,x.founder.publicKey),s);
 stateHash(JSON.parse(JSON.stringify(s)),x.c);const run=execute(s);
 assert.throws(()=>applyMemorialAction(s,run,x.f.alice.publicKey),/execution window/);
 s=x.run(s,[],s.money.time+10);s=applyMemorialAction(s,run,x.f.alice.publicKey);stateHash(s,x.c);
 assert.equal(s.economicPreparation.memorial.manager,successor.publicKey);assert.equal(s.economicPreparation.memorial.epoch,1);
 assert.deepEqual({...s.money,height:original.height,time:original.time},original);
 assert.deepEqual(applyMemorialAction(s,run,x.f.alice.publicKey),s);
 assert.throws(()=>applyMemorialAction(s,decision(s,x.founder,keys()),x.founder.publicKey),/current memorial manager/);
 const next=decision(s,successor,keys());s=applyMemorialAction(s,next,successor.publicKey);
 const cancel={...execute(s),type:'CANCEL_MEMORIAL_SUCCESSION_V1'};
 assert.throws(()=>applyMemorialAction(s,cancel,x.founder.publicKey),/current memorial manager/);
 s=applyMemorialAction(s,cancel,successor.publicKey);assert.equal(s.economicPreparation.memorial.pending,null);stateHash(s,x.c);
 assert.throws(()=>applyMemorialAction(s,next,successor.publicKey),/sequence/);
});
test('forged consent, unpublished decision, cross-chain replay and late execution are refused',()=>{
 const x=readyMemorial(),s=x.prepared(),successor=keys(),baseHash=hash(s);
 for(const extra of [{publicDecision:''},{configHash:hash('other chain')},{planHash:hash('other plan')},{managerEpoch:1},{sequence:2},{effectiveAt:s.money.time-1}])assert.throws(()=>applyMemorialAction(s,decision(s,x.founder,successor,extra),x.founder.publicKey));
 const forged=decision(s,x.founder,successor);forged.successorConsent=forged.signature;assert.throws(()=>applyMemorialAction(s,forged,x.founder.publicKey),/consent/);
 const pending=applyMemorialAction(s,decision(s,x.founder,successor),x.founder.publicKey),run=execute(pending),late=x.run(pending,[],s.money.time+101);
 assert.throws(()=>applyMemorialAction(late,run,x.f.alice.publicKey),/execution window/);assert.equal(hash(s),baseHash);
});
test('memorial cannot subsidize ordinary rewards before or after its separate planned issuance',()=>{
 const start=Date.UTC(2028,0,1)/1000,args={calendar:{start,from:start,to:start+86400,existingSupplyMicro:micro(2000)},supplyMicro:micro(2000),futureFixedReservedMicro:micro(120000000),lifetimeRemainingMicro:micro(9879998000),operationalCapMicro:micro(1000000),ordinaryCostMicro:micro(1000000),ordinaryFeesMicro:'0',renewalCostMicro:'0',renewalFeesMicro:'0',renewalQualified:false};
 const expected=emissionBudget(args);
 assert.deepEqual(emissionBudgetV3({...args,memorialIssuedMicro:'0'}),expected);
 assert.deepEqual(emissionBudgetV3({...args,supplyMicro:micro(1002000),memorialIssuedMicro:micro(1000000)}),expected);
 assert.throws(()=>emissionBudgetV3({...args,memorialIssuedMicro:'1'}),/zero or complete/);
 assert.throws(()=>emissionBudgetV3({...args,memorialIssuedMicro:micro(1000000)}),/exceeds supply/);
 assert.equal(emissionBudgetV3({...args,supplyMicro:String(CAP-120000000n*UNIT),memorialIssuedMicro:'0'}).maximumMicro,'0');
});
test('museum boundary is the 100th anniversary, never year 200 or an automatic payment',()=>{
 const start=Date.UTC(2000,1,29)/1000,end=anniversary(start,100);
 assert.equal(new Date(end*1000).toISOString(),'2100-02-28T00:00:00.000Z');
 for(const at of [start,end-1])assert.equal(memorialMuseumEligibility({emissionStart:start,at,transferred:false}),false);
 assert.equal(memorialMuseumEligibility({emissionStart:start,at:end,transferred:false}),true);
 assert.equal(memorialMuseumEligibility({emissionStart:start,at:end,transferred:true}),false);
 assert.equal(memorialMuseumEligibility({emissionStart:null,at:end,transferred:false}),false);
});
