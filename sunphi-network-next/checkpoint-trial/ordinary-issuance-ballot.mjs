import assert from 'node:assert/strict';
import {exact,hash,integer,verify} from './crypto.mjs';
import {verifyValidatorApprovals} from './validator-authority.mjs';
import {developmentManager} from './reserve-recovery.mjs';
import {ordinarySealTerms,SEAL_ORDINARY} from './research/ordinary-curve-seal.mjs';

export const mandateId='8bb8af27d81618ae0e12c746c59e5fa17de17152a39af029ed84f58490f1a267';
const body=Object.freeze({"annualHash":"ba716c27174c1f14478ce5f8aeb0ca778232e5affd50e0a18c1add11f47b76f4","configHash":"5a6af5048049049bee003078f845ccea883140f291897f950007c5ba113a807c","curve":"DUEBYTE_ORDINARY_DECADE_CURVE_V1","domain":"SEAL_ORDINARY_EMISSION_CURVE_V1","expires":1795782259,"generation":1,"managementEpoch":1,"manifestHash":"33c111ac25d0222f24f719b0312b4c2e7e103553f060c0c0c16bb63b0a990da0","network":"duebyte-trial-fresh-20261109-v45","notBefore":1795177459,"planHash":"99d9e82a254b8b2d26b79b913928559e9666a61d8d5809760cd6d0d968ac4f16","programmeHash":"36cf4915d69242b075951b1db746cc66627bad4d81cf7f8685aac2986ce06eea"});
const consent='syNWBJL6gZOAbMwAICh-aK-PF5LwxtMMBcUkRdDvj4FQov0yrbQWdhBU1lV-dVaJnZG6Rlf2QPUUJYFkilRdBg';
const document='Approve the smooth issuance schedule for 9,880,000,000 DUBYT in ordinary node rewards over 100 years. All four fund schedules and their management rules are preserved.';
export function issuancePacket(){return {body:{...body},document,approvals:[],founderConsent:consent};}
export function reviewIssuance(packet,state,network,signer){
 exact(packet,['body','document','approvals','founderConsent']);
 assert.equal(hash(packet.body),mandateId,'Unrecognized issuance mandate');
 assert.equal(packet.document,document);assert.equal(packet.body.domain,SEAL_ORDINARY);
 assert.deepEqual(packet.body,{...ordinarySealTerms(state,network),notBefore:body.notBefore,expires:body.expires},'The financial authority or issuance plan has changed');
 assert(verify(body,packet.founderConsent,developmentManager(state.networkReserves)),'Invalid management approval');
 const now=integer(state.money.time,1),members=state.authority.validators;
 const tally=verifyValidatorApprovals(body,packet.approvals,members);
 const approved=tally.power>=tally.threshold,expired=now>=body.expires;
 const sealed=state.centuryFees.ordinaryCurve===body.curve;
 const available=!sealed&&!state.centuryFees.ordinaryCurve&&!state.centurySubsidy&&!state.centuryFunds.mainProgramme.activation&&!state.authority.pending&&!state.networkReserves.development.access.pending&&now>=body.notBefore&&!expired;
 const member=members.some(m=>m.key===signer),voted=packet.approvals.some(v=>v.key===signer);
 return {kind:'issuance',proposal:mandateId,document,network,height:state.height,expiresUtc:new Date(body.expires*1000).toISOString(),sealed,available,approved,expired,member,voted,
  weight:String(tally.power),required:String(tally.threshold),canSign:available&&member&&!voted&&!approved,canSubmit:false};
}
