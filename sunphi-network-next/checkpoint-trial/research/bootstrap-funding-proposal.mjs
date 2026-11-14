// Preparation document only. Never accepted as a transaction or mint permission.
import assert from 'node:assert/strict';import {hash,hex,publicKey,exact,integer} from '../crypto.mjs';
export const INITIAL_COLLATERAL_MICRO='100000000';
// The legacy default is retained for verification of previously signed V1 terms.
// New preparations explicitly select the approved 100 DUBYT initial condition.
export function bootstrapFundingProposal({configHash,root,height,workers},perNodeMicro='10000000'){
 assert(['10000000',INITIAL_COLLATERAL_MICRO].includes(perNodeMicro),'supported initial condition');
 hex(configHash);hex(root);integer(height,1);assert(Array.isArray(workers)&&workers.length>0&&workers.length<=10);const seen=new Set(),groups=new Set();
 const roster=workers.map(w=>{exact(w,['node','key','operator','recipient']);hex(w.node);hex(w.operator);publicKey(w.key);publicKey(w.recipient);assert(!seen.has(w.node),'duplicate worker');seen.add(w.node);groups.add(w.operator);return {...w,lockedSupportMicro:perNodeMicro};}).sort((a,b)=>a.node<b.node?-1:1);
 assert.equal(groups.size,1,'initial founder roster is one disclosed owner group');assert.equal(new Set(roster.map(w=>w.key)).size,roster.length,'unique work keys required');
 const body={domain:perNodeMicro==='10000000'?'DUEBYTE_BOOTSTRAP_COLLATERAL_PROPOSAL_V1':'DUEBYTE_BOOTSTRAP_COLLATERAL_PROPOSAL_V2',configHash,observedRoot:root,observedHeight:height,roster,totalMicro:String(BigInt(roster.length)*BigInt(perNodeMicro)),maximumMicro:String(10n*BigInt(perNodeMicro)),source:'REGULAR_ISSUANCE_ALLOWANCE',withdrawableMicro:'0',returnPolicy:'ALGORITHMIC_POOL_NO_REMINT',ownerGroup:[...groups][0]};
 return {body,proposalHash:hash(body),preparedOnly:true,issuanceAuthorized:false,signatures:[],remaining:['Qualify non-withdrawable grant accounting and return pool','Share calendar and lifetime issuance counters with ordinary subsidy','Verify current enrollment, independent key backup and recipient consent','Explicit issuance authorization; compatible validator rollout']};
}
