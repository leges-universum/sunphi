// Initial custody on a clean, zero-supply chain only. This is NOT a mint route.
import assert from 'node:assert/strict';
import {applyReserveAction} from '../network-reserves.mjs';
export function prepareCleanCustody(state,action,author,config,{anchor,workerCount}){
 assert.equal(action.type,'PREPARE_NETWORK_RESERVES_V1');
 assert.equal(anchor.height,0);assert.equal(anchor.archive,null);assert.equal(anchor.issuance,false);
 assert.equal(config.initial.supply,'0');assert.equal(config.initial.fees,'0');
 for(const bucket of ['outputs','requests','nodes'])assert.deepEqual(config.initial[bucket],{});
 assert.equal(state.money.supply,'0');assert.equal(state.money.fees,'0');assert.equal(workerCount,0);
 assert(!state.networkReserves&&!state.launchFund&&!state.rewards&&!state.economicPreparation&&!state.money.liability);
 // Clean origin plus conservation, strictly positive funded payments and the
 // disabled mint route mean no monetary records can exist at this point. Keep
 // the shared signature, quorum, recovery-possession and policy checks, while
 // avoiding enumeration of the authenticated monetary maps.
 const result=applyReserveAction({...state,money:{...state.money,outputs:{},requests:{},nodes:{}}},action,author,config);
 for(const bucket of ['outputs','requests','nodes'])assert.deepEqual(result.money[bucket],{});
 assert.equal(result.money.supply,'0');assert.equal(result.networkReserves.issued,null);
 assert.equal(result.networkReserves.warmup.mode,'PAUSED');assert.equal(result.networkReserves.development.mode,'PAUSED');
 return {...result,money:state.money};
}
