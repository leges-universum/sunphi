// Isolated fixtures use existing synthetic balances; never production custody.
import {setup} from './liability-fixture.mjs';
import {previewTokenPrecision} from '../../precision-preview.mjs';
import {hash,sign,keys} from '../../crypto.mjs';
import {REWARDS,walletConsent} from '../../node-rewards.mjs';
import {UTC_REWARDS} from '../../economic-clock.mjs';
import {UTC_OBLIGATIONS} from '../../obligation-clock.mjs';
import {applyEconomicPreparation} from '../../economic-preparation.mjs';
import {makeEconomicPlanV4,economicTermsHash,centuryWarmupAccounts} from '../../economic-policy-v3.mjs';
import {initialCenturyWarmup} from '../../century-warmup.mjs';
import {applyCenturyFees,CENTURY_FEES_ACTION} from '../../century-fees.mjs';
export function coefficients(over={}){return {version:1,timeBasis:UTC_REWARDS,periodSeconds:60,workerWeight:1,witnessWeight:1,alphaPPM:0,periodMintLimit:'0',lifetimeMintLimit:'0',workMeasure:'payment_value_v2',...over};}
export function rewardAction(x,s,type,extra){const body={domain:REWARDS+'/'+type,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:s.height,expires:s.height+100,...extra};return {type,certificate:{body,approvals:x.approvals(body)}};}
export function utcEconomicFixture({payments=0,warmup=false,manySenders=false,liability={}}={}){
 const x=setup({utc:true,...liability});let s=previewTokenPrecision(x.s).state;const activation=s.money.time+20,inputs=[],senders=[];
 for(let n=0;n<payments;n++){const id=hash({syntheticUtcInput:n}),sender=manySenders?keys():x.f.alice;inputs.push(id);senders.push(sender);s.money.outputs[id]={owner:sender.publicKey,value:'1030000',unlock:0};}
 s.money.outputs[x.f.input].value=String(BigInt(s.money.outputs[x.f.input].value)-BigInt(payments)*1030000n);
 if(warmup){const plan=makeEconomicPlanV4(s),body={domain:'DUEBYTE_ECONOMIC_PREPARATION_V4',network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:s.height,expires:s.height+100,version:plan.version,supplyBefore:s.money.supply,unitScale:s.money.unitScale,previousPlanHash:null,termsHash:economicTermsHash(plan),memorialManager:x.founder.publicKey};
  s=applyEconomicPreparation(s,{type:'PREPARE_ECONOMY_V4',certificate:{body,approvals:x.approvals(body)},founderConsent:sign(body,x.founder.privateKey)},x.c);
  s.money.outputs[x.f.input].value=String(BigInt(s.money.outputs[x.f.input].value)-10000000n);
  s.money.outputs[hash('utc synthetic warmup')]={owner:centuryWarmupAccounts(s.configHash)[0],value:'10000000',unlock:0};
  s.centuryWarmup=initialCenturyWarmup(s,{start:activation,timeBasis:UTC_OBLIGATIONS,ttlSeconds:100,controllerPolicy:{intervalSeconds:60,maximumRiseMicroPerSecond:'1000',operationalRateMicroPerSecond:'10000'},maxPaymentMicro:'1234567'});
 }
 const enable=rewardAction(x,s,'ENABLE_NODE_REWARDS_V1',{activation,coefficients:coefficients(),allowedPeers:[]});
 if(warmup){const body={domain:CENTURY_FEES_ACTION,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:s.height,expires:s.height+100,activation,timeBasis:UTC_REWARDS,periodSeconds:60,planHash:s.economicPreparation.planHash};s=applyCenturyFees(s,{type:CENTURY_FEES_ACTION,certificate:{body,approvals:x.approvals(body)},founderConsent:sign(body,x.founder.privateKey)},x.c);}else s=x.run(s,[x.wire(enable)]);
 s=x.run(s,[],activation);
 const wallet=keys();
 for(const node of x.f.ids){const manager=x.key(node),body={domain:REWARDS+'/BIND',configHash:s.configHash,node,sequence:1,payouts:[{wallet:wallet.publicKey,weight:1}]};s=x.run(s,[x.wire({type:'BIND_REWARD_WALLETS_V1',body,signature:sign(body,manager.privateKey),consents:[sign(walletConsent(s.configHash,node,wallet.publicKey),wallet.privateKey)]},manager)]);}
 const capacity=(state,over={})=>{const b=state.centuryWarmup,body={domain:'DUEBYTE_WARMUP_CAPACITY_V2',configHash:state.configHash,generation:state.authority.generation,start:b.controller.start,from:state.money.time,to:state.money.time+60,observedHeight:state.height,observedAt:state.money.time,sequence:b.controller.sequence+1,healthy:true,capacityRateMicroPerSecond:'1000',controllerPolicyHash:hash(b.controllerPolicy),...over};return {body,approvals:x.approvals(body)};};
 return {...x,s,inputs,senders,wallet,capacity,reserve:i=>{const k=senders.find(k=>k.publicKey===i.sender)??x.f.alice;return x.wire({type:'RESERVE',signed:{intent:i,signature:sign(i,k.privateKey)}},k);},payment:(state,n)=>x.intent(state,{sender:senders[n].publicKey,epoch:state.money.epoch,inputs:[inputs[n]],unitScale:'1000000',value:'1000000',fee:'30000',abortFee:'30000',parts:[{value:'1000000',nodes:x.f.ids.slice(0,3)}]})};
}
