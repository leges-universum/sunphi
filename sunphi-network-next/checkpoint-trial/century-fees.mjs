// Candidate fee distribution for the prepared century plan. No issuance route.
// Public admission remains closed until release qualification and authorization.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer,verify} from './crypto.mjs';
import {validatorQuorum} from './authority.mjs';
import {developmentManager} from './reserve-recovery.mjs';
import {memorialAware} from './economic-policy-v3.mjs';
import {UTC_REWARDS,checkRewardClock,rewardNotice} from './economic-clock.mjs';
export const CENTURY_FEES_ACTION='ENABLE_CENTURY_FEES_V1';
export function feeOnlyCoefficients(c){
 assert(c&&c.alphaPPM===0&&c.periodMintLimit==='0'&&c.lifetimeMintLimit==='0'&&!c.calendar,'century fee-only coefficients');
 assert.equal(c.workMeasure,'payment_value_v2','normalized accepted payment receipts required');
 assert.equal(c.workerWeight,1);assert.equal(c.witnessWeight,1);
}
export function applyCenturyFees(base,action,config){
 exact(action,['type','certificate','founderConsent']);assert.equal(action.type,CENTURY_FEES_ACTION);
 exact(action.certificate,['body','approvals']);const b=action.certificate.body;
 exact(b,['domain','network','configHash','generation','notBefore','expires','planHash','activation',...(config.obligationClock?['timeBasis','periodSeconds']:['periodBlocks'])]);
 assert.equal(b.domain,CENTURY_FEES_ACTION);assert.equal(b.network,config.chainId);assert.equal(b.configHash,hash(config));
 assert.equal(b.generation,base.authority.generation);assert.equal(base.money.unitScale,'1000000');
 assert(memorialAware(base.economicPreparation?.plan.version));
 assert.equal(b.planHash,base.economicPreparation.planHash);
 integer(b.notBefore,1);integer(b.expires,b.notBefore);assert(b.expires-b.notBefore<=100&&base.height>=b.notBefore&&base.height<=b.expires,'fee activation inclusion window');
 if(config.obligationClock){assert.equal(b.timeBasis,UTC_REWARDS);integer(b.periodSeconds,20);assert(b.periodSeconds<=432000);}else{integer(b.periodBlocks,10);assert(b.periodBlocks<=43200);}
 const coefficients={version:1,...(config.obligationClock?{timeBasis:b.timeBasis,periodSeconds:b.periodSeconds}:{periodBlocks:b.periodBlocks}),workerWeight:1,witnessWeight:1,alphaPPM:0,periodMintLimit:'0',lifetimeMintLimit:'0',workMeasure:'payment_value_v2'};
 checkRewardClock(config,coefficients);rewardNotice(base,b.activation,b.expires,coefficients);
 validatorQuorum(b,action.certificate.approvals,base.authority.validators);
 assert(verify(b,action.founderConsent,developmentManager(base.networkReserves)),'founder fee activation consent');
 const certificateHash=hash(action.certificate);
 if(base.centuryFees){assert.equal(base.centuryFees.certificateHash,certificateHash,'conflicting fee activation');return base;}
 assert(!base.rewards&&!base.authority.nodeRewards,'legacy rewards must be inactive');
 const s={...base,authority:structuredClone(base.authority)};
 s.centuryFees={version:CENTURY_FEES_ACTION,planHash:b.planHash,certificateHash};
 s.authority.nodeRewards={activation:b.activation,coefficients,allowedPeers:[],certificate:certificateHash};
 auditCenturyFees(s);return s;
}
export function auditCenturyFees(s){
 if(!s.centuryFees)return;
 const f=s.centuryFees;exact(f,['version','planHash','certificateHash']);assert.equal(f.version,CENTURY_FEES_ACTION);hex(f.certificateHash);
 assert.equal(s.money.unitScale,'1000000');assert(memorialAware(s.economicPreparation?.plan.version));assert.equal(f.planHash,s.economicPreparation.planHash);
 assert.equal(s.authority.nodeRewards?.certificate,f.certificateHash);feeOnlyCoefficients(s.authority.nodeRewards.coefficients);
 if(s.rewards){feeOnlyCoefficients(s.rewards.coefficients);assert.equal(s.rewards.minted,s.centurySubsidy?.totalMintedMicro??'0');assert(!s.rewards.fundedWork,'legacy funded emission is not a century service');
  if(s.rewards.scheduled)feeOnlyCoefficients(s.rewards.scheduled.coefficients);
  for(const w of Object.values(s.rewards.period.work))assert.equal(w.witness,'0','public checkpoint signatures are not paid work');
 }
}
