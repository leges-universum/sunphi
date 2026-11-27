// Candidate V2 authority adapter. Only the authenticated slashing execution path
// may call this; an administrator or wallet cannot provide a free-form jail list.
// Stored beside the existing pending transition, never in a second database.
import assert from 'node:assert/strict';
import {exact,hex,integer,publicKey} from '../crypto.mjs';
import {validatorSet} from '../validator-authority.mjs';
import {membershipDelta} from '../validator-membership.mjs';
import {planConsensusExclusion} from './pos-membership-plan.mjs';

export const POS_EXCLUSION='DUEBYTE_POS_EXCLUSION_V1';
export const INITIAL_BONDED_SET='DUEBYTE_INITIAL_BONDED_SET_V3';
export function normalizedVotingSet(before){
 assert(before.length>=4&&before.length<=20,'Initial bonded committee size');
 assert(before.every(v=>v.power===before[0].power),'Initial transition requires proportional weights');
 return before.map(v=>({...v,power:1}));
}
export function normalizedUpdates(before){
 return normalizedVotingSet(before).filter((_,i)=>before[i].power!==1).map(v=>({key:v.key,power:1}))
  .sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
}
// In v3 monetary certificates continue to use the original top-level registry.
// Only the voting registry advances when consensus schedules an exclusion.
export const posVotingAuthority=a=>a?.posSlashing?.voting??a;
const roster=members=>{assert.equal(validatorSet(members,{minimum:1}).version,2);};

export function auditPosAuthority(a,height){
 assert.equal(a.version,2,'PoS needs explicit variable authority');integer(height,1);integer(a.generation);roster(a.validators);
 assert(Array.isArray(a.usedKeys)&&a.usedKeys.length<=2048);assert.deepEqual(a.usedKeys,[...new Set(a.usedKeys)].sort());a.usedKeys.forEach(publicKey);
 const known=members=>{for(const v of members)assert(a.usedKeys.includes(v.key),'missing archived validator key');};known(a.validators);
 const check=(pending,before)=>{
  integer(pending.activation,height+1);assert(pending.activation<=height+2);hex(pending.certificate);known(pending.validators);
  if(pending.kind===POS_EXCLUSION){
   exact(pending,['kind','activation','validators','updates','certificate','excluded']);
   assert(Array.isArray(pending.excluded)&&pending.excluded.length>0);assert.deepEqual(pending.excluded,[...new Set(pending.excluded)].sort());
   const expected=planConsensusExclusion({height:pending.activation-2,current:before,jailed:pending.excluded});assert(expected);
   assert.deepEqual(pending.validators,expected.validators);assert.deepEqual(pending.updates,expected.updates);
  }else if(pending.kind===INITIAL_BONDED_SET){
   exact(pending,['kind','activation','validators','updates','certificate']);
   assert.deepEqual(pending.validators,normalizedVotingSet(before));assert.deepEqual(pending.updates,normalizedUpdates(before));
  }else{exact(pending,['activation','validators','updates','certificate']);assert.deepEqual(pending.updates,membershipDelta(before,pending.validators));}
 };
 if(a.pending)check(a.pending,a.validators);
 if(a.posNext){
  assert(a.pending&&a.pending.activation===height+1,'second schedule needs committed H+1 predecessor');
  assert.equal(a.posNext.activation,height+2);assert.equal(a.posNext.kind,POS_EXCLUSION);check(a.posNext,a.pending.validators);
 }
 return a;
}

export function schedulePosExclusion(a,{height,keys,contextHash}){
 if(a.posSlashing?.voting)return {...a,posSlashing:{...a.posSlashing,voting:schedulePosExclusion(a.posSlashing.voting,{height,keys,contextHash})}};
 auditPosAuthority(a,height);hex(contextHash);
 assert(!a.posNext,'exclusions must be collected once per block');
 const plan=planConsensusExclusion({height,current:a.validators,scheduled:a.pending,jailed:keys});
 if(!plan)return structuredClone(a);
 const pending={kind:POS_EXCLUSION,activation:plan.activation,validators:plan.validators,updates:plan.updates,certificate:contextHash,excluded:plan.updates.map(v=>v.key)};
 const out=structuredClone(a);
 if(out.pending)out.posNext=pending;else out.pending=pending;
 auditPosAuthority(out,height);return out;
}

export function advancePosAuthority(a,height){
 if(a.posSlashing?.voting){
  const {authority:voting,removed}=advancePosAuthority(a.posSlashing.voting,height);
  return {authority:{...a,posSlashing:{...a.posSlashing,voting}},removed};
 }
 integer(height,1);const out=structuredClone(a),p=out.pending;
 if(!p){assert(!out.posNext);auditPosAuthority(out,height);return {authority:out,removed:[]};}
 assert(height<=p.activation,'missed authority activation');
 if(height!==p.activation){auditPosAuthority(out,height);return {authority:out,removed:[]};}
 const next=new Set(p.validators.map(v=>v.key)),removed=out.validators.filter(v=>!next.has(v.key));
 out.validators=p.validators;out.pending=out.posNext??null;delete out.posNext;out.generation=integer(out.generation+1,1);
 auditPosAuthority(out,height);return {authority:out,removed};
}

export function posValidatorUpdates(a,height){
 a=posVotingAuthority(a);
 auditPosAuthority(a,height);const p=a.posNext??a.pending;
 return p?.activation===height+2?structuredClone(p.updates):[];
}
