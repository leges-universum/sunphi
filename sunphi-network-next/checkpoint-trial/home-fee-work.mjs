// Zero-stage authenticated recent-record availability. Uses the existing hourly
// fee ledger and witness weight; creates no mint, tariff or parallel reward book.
import assert from 'node:assert/strict';
import {hash,hex,exact,canonical,verify} from './crypto.mjs';
import {controllerContext} from './controller-context.mjs';
import {verifyRecordProof} from './research/record-proof.mjs';
export const HOME_FEE_WORK='REWARD_RECORD_WITNESS_V1';
export const HOME_FEE_DOMAIN='DUEBYTE_HOME_FEE_RECORD_V1';
export const HOME_FEE_SAMPLE=32,HOME_FEE_RESPONSE_SECONDS=180;
export function feeHomeEnabled(s){return !!(s?.centuryFees&&s.centuryFunds?.zeroStage&&!s.centurySubsidy&&s.rewards?.coefficients.timeBasis==='DUEBYTE_UTC_REWARDS_V1'&&s.rewards?.homeRegistry&&s.economicPreparation?.paidAdmission);}
export function feeHomeAssignments(s,index,anchor,legacy){
 if(!feeHomeEnabled(s))return legacy;
 const ctx=controllerContext(s);assert(ctx?.paidHomeSelection,'authenticated Home admission index required');
 const limit=Math.min(HOME_FEE_SAMPLE,128-legacy.length);if(!limit)return legacy;
 const seed=hash({domain:HOME_FEE_DOMAIN,configHash:s.configHash,period:index,anchor});
 return [...new Set([...legacy,...Object.keys(ctx.paidHomeSelection(s.money.time,seed,limit))])].sort();
}
export function feeHomeBody(s,node,valueHash){
 assert(feeHomeEnabled(s),'fee-only Home service unavailable');const p=s.rewards.period;
 assert(p.assigned.includes(node),'no fee-only Home assignment');hex(valueHash);
 return {domain:HOME_FEE_DOMAIN,configHash:s.configHash,node,period:p.index,
  root:p.anchor.stateHash,key:'meta/blockHead',valueHash,
  challenge:hash({domain:HOME_FEE_DOMAIN,configHash:s.configHash,node,period:p.index,anchor:p.anchor,start:p.start,end:p.end})};
}
export function verifyFeeHomeResponse(s,a,author){
 exact(a,['type','body','signature','proof']);assert.equal(a.type,HOME_FEE_WORK);
 assert.deepEqual(a.body,feeHomeBody(s,a.body.node,a.body.valueHash),'fee-only Home challenge');
 const p=s.rewards.period,n=s.rewards.nodes[a.body.node];assert(n?.kind==='witness');assert.equal(author,n.key);assert(verify(a.body,a.signature,n.key),'Home work signature');
 const admission=controllerContext(s)?.paidAdmissionAt?.(a.body.node,p.start);assert(admission?.kind==='witness','Home paid admission not effective at period start');
 assert(Buffer.byteLength(canonical(a.proof))<=48000,'Home proof budget');assert.equal(a.proof.key,a.body.key);assert.equal(a.proof.found,true);verifyRecordProof(a.proof,a.body.root);assert.equal(hash(a.proof.value),a.body.valueHash,'Home record content');
 if(p.witnesses.includes(a.body.node))return false;
 assert(s.money.time<=p.start+HOME_FEE_RESPONSE_SECONDS&&s.money.time<p.end,'Home response expired');
 assert(s.rewards.coefficients.alphaPPM===0&&s.rewards.coefficients.periodMintLimit==='0'&&s.rewards.coefficients.lifetimeMintLimit==='0','fee-only coefficients required');
 return true;
}
