// Offline founder management: sign a specific public action; never broadcast,
// create a reserve, issue tokens, or read a validator key.
import assert from 'node:assert/strict';
import {hash} from './crypto.mjs';
import {stateHash,envelope,applyTx} from './core.mjs';
import {reserveSummary} from './network-reserves.mjs';
import {developmentManager} from './reserve-recovery.mjs';
import {protectionSummary} from './protection-reserve.mjs';
export function prepareFounderAction({config,state,key,action}){
 stateHash(state,config);assert.equal(key.publicKey,developmentManager(state.networkReserves),'founder key required');
 assert(['SET_DEVELOPMENT_CONTROL_V1','QUEUE_DEVELOPMENT_SPEND_V1','CANCEL_DEVELOPMENT_SPEND_V1','QUEUE_PROTECTION_PAYMENT_V1','CANCEL_PROTECTION_PAYMENT_V1'].includes(action.type),'specific founder action only');
 if(state.networkReserves.development.access)action={...action,managementEpoch:state.networkReserves.development.access.epoch};
 const wire=envelope(config,action,key);applyTx(state,Buffer.from(JSON.stringify(wire)),config,state.money.time);
 return{wire,wireHash:hash(wire),preview:{name:action.type.includes('PROTECTION')?protectionSummary(state).name:reserveSummary(state).name,action:structuredClone(action),network:config.chainId,supplyUnchanged:true}};
}
