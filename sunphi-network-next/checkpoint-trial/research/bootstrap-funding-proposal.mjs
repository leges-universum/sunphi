// Preparation document only. Never accepted as a transaction or mint permission.
import assert from 'node:assert/strict';import {hash,hex,publicKey,exact,integer} from '../crypto.mjs';
export function bootstrapFundingProposal({configHash,root,height,workers}){
 hex(configHash);hex(root);integer(height,1);assert(Array.isArray(workers)&&workers.length>0&&workers.length<=10);const seen=new Set(),groups=new Set();
 const roster=workers.map(w=>{exact(w,['node','key','operator','recipient']);hex(w.node);hex(w.operator);publicKey(w.key);publicKey(w.recipient);assert(!seen.has(w.node),'duplicate worker');seen.add(w.node);groups.add(w.operator);return {...w,lockedSupportMicro:'10000000'};}).sort((a,b)=>a.node<b.node?-1:1);
 assert.equal(groups.size,1,'initial founder roster is one disclosed owner group');assert.equal(new Set(roster.map(w=>w.key)).size,roster.length,'unique work keys required');
 const body={domain:'DUEBYTE_BOOTSTRAP_COLLATERAL_PROPOSAL_V1',configHash,observedRoot:root,observedHeight:height,roster,totalMicro:String(BigInt(roster.length)*10000000n),maximumMicro:'100000000',source:'REGULAR_ISSUANCE_ALLOWANCE',withdrawableMicro:'0',returnPolicy:'ALGORITHMIC_POOL_NO_REMINT',ownerGroup:[...groups][0]};
 return {body,proposalHash:hash(body),preparedOnly:true,issuanceAuthorized:false,signatures:[],remaining:['Qualify non-withdrawable grant accounting and return pool','Share calendar and lifetime issuance counters with ordinary subsidy','Verify current enrollment, independent key backup and recipient consent','Explicit issuance authorization; compatible validator rollout']};
}
