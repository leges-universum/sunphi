import assert from 'node:assert/strict';
import {exact,hash,integer,verify} from '../crypto.mjs';
import {validatorQuorum} from '../authority.mjs';
import {developmentManager} from '../reserve-recovery.mjs';
import {START} from './calendar-node-emission-policy.mjs';
import {SMOOTH_EMISSION,compileOrdinaryCurve} from './smooth-emission.mjs';

export const SEAL_ORDINARY='SEAL_ORDINARY_EMISSION_CURVE_V1';

export function ordinarySealTerms(s,network){
 const plan=s.economicPreparation, funds=s.centuryFunds, source=s.rewards?.calendarService;
 assert(plan && funds?.mainProgramme && source && s.centuryFees,'prepared main programme required');
 assert.equal(hash(plan.plan),plan.planHash);
 assert.equal(hash(funds.manifest),funds.manifestHash);
 assert.equal(s.centuryFees.planHash,plan.planHash);
 const {annualHash}=compileOrdinaryCurve(plan.plan.annualRegularMicro);
 assert.equal(source.annualHash,annualHash);
 assert.equal(funds.mainProgramme.body.network,network);
 return {domain:SEAL_ORDINARY,network,configHash:s.configHash,generation:s.authority.generation,
  managementEpoch:s.networkReserves.development.access.epoch,curve:SMOOTH_EMISSION,
  planHash:plan.planHash,annualHash,manifestHash:funds.manifestHash,
  programmeHash:funds.mainProgramme.certificateHash};
}

export function sealOrdinaryCurve(s,a,config){
 exact(a,['type','certificate','founderConsent']);assert.equal(a.type,SEAL_ORDINARY);
 exact(a.certificate,['body','approvals']);
 const b=a.certificate.body, terms=ordinarySealTerms(s,config.chainId);
 assert.deepEqual(b,{...terms,notBefore:b.notBefore,expires:b.expires},'exact ordinary curve mandate');
 assert.equal(s.configHash,hash(config));
 assert(!s.centuryFees.ordinaryCurve && !s.centurySubsidy && !s.centuryFunds.mainProgramme.activation,'ordinary curve already sealed or programme started');
 assert.equal(s.rewards.calendarService.nextMintDay,START);assert.equal(s.rewards.calendarService.mintedMicro,'0');
 assert(!s.authority.pending && !s.networkReserves.development.access.pending,'authority transition pending');
 integer(b.notBefore,1);integer(b.expires,b.notBefore+1);
 assert(b.expires<=START && b.expires-b.notBefore<=7*86400 && b.notBefore<=s.money.time && s.money.time<b.expires,'pre-launch signing window');
 validatorQuorum(b,a.certificate.approvals,s.authority.validators);
 assert(verify(b,a.founderConsent,developmentManager(s.networkReserves)),'ordinary curve management consent');
 return {...s,centuryFees:{...s.centuryFees,ordinaryCurve:SMOOTH_EMISSION}};
}
