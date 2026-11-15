// Offline diagnostic only. A clean snapshot never authorizes a live rollout.
import assert from 'node:assert/strict';
import {utcIntent} from '../obligation-clock.mjs';
import {auditState} from '../core.mjs';import {hash} from '../crypto.mjs';
export function inspectCadenceObligations(state,config,expectedHash){
 auditState(state,config);assert.equal(hash(state),expectedHash,'Complete state fingerprint required');const blockers=[];
 for(const [pid,r]of Object.entries(state.money.requests))if(r.status==='RESERVED'&&!utcIntent(r.intent))blockers.push({kind:'payment-action-deadline',id:pid});
 // Even idle enabled policies can create NEW height obligations during rollout.
 if(state.money.liability?.policy.version===1)blockers.push({kind:'liability-height-policy'});
 if(state.rewards||state.authority?.nodeRewards)blockers.push({kind:'reward-height-policy'});
 if(state.centuryFees||state.centurySubsidy)blockers.push({kind:'economic-height-policy'});
 if(state.authority?.pending)blockers.push({kind:'pending-validator-activation'});
 for(const [name,value]of Object.entries(state.authority??{}))if(value&&typeof value==='object'&&Number.isInteger(value.activation)&&value.activation>state.height)blockers.push({kind:'pending-feature-activation',id:name});
 if(state.networkReserves||state.launchFund||state.centuryWarmup||state.centuryFunds||state.nativeContracts||state.economicPreparation)blockers.push({kind:'controller-policy-review-required'});
 return {stateHash:expectedHash,height:state.height,blockers,utcScheduled:Object.values(state.money.requests).filter(r=>r.status==='SCHEDULED').length,productionAuthorized:false,scope:'offline-diagnostic-not-a-rollout-permit'};
}
export function assertNoHeightCadenceObligations(state,config,expectedHash){
 const result=inspectCadenceObligations(state,config,expectedHash);
 assert.equal(result.blockers.length,0,'Cadence change blocked: '+result.blockers.map(b=>b.kind).join(', '));return result;
}
