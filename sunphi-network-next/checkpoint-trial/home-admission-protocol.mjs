// Public enrollment messages. None of these messages authorize spending or work pay.
import assert from 'node:assert/strict';
import {exact,hash,integer,publicKey,verify} from './crypto.mjs';
import {rewardNodeId} from './node-rewards.mjs';
import {REGISTER_HOMES,validateHomeAuthorization} from './research/bounded-home-registration.mjs';
export const HOME_REQUEST='DUEBYTE_HOME_ENROLLMENT_REQUEST_V1';
export const HOME_DELIVERY='DUEBYTE_HOME_ENROLLMENT_DELIVERY_V1';
export function validateHomeRequest(request,config,time){
 exact(request,['body','consents']);const b=request.body,h=b.home;
 exact(b,['domain','network','configHash','issuedAt','expires','home']);assert.equal(b.domain,HOME_REQUEST);assert.equal(b.network,config.chainId);assert.equal(b.configHash,hash(config));
 integer(time,1);integer(b.issuedAt,1);integer(b.expires,b.issuedAt+1);assert(b.expires-b.issuedAt<=600&&b.issuedAt<=time&&time<b.expires,'Home request expired or premature');
 exact(h,['node','identity','work','management']);assert.equal(h.node,rewardNodeId(b.configHash,h.work));exact(request.consents,['identity','work','management']);
 for(const k of ['identity','work','management']){publicKey(h[k]);assert(verify(b,request.consents[k],h[k]),'Home request possession');}
 assert.equal(new Set([h.identity,h.work,h.management]).size,3,'separate Home keys');return h;
}
export function homeAdmissionProposal(request,state,config){
 const home=validateHomeRequest(request,config,state.money.time);
 return {domain:REGISTER_HOMES,network:config.chainId,configHash:hash(config),generation:state.authority.generation,managementEpoch:state.networkReserves.development.access.epoch,notBefore:state.money.time,expires:Math.min(state.money.time+600,request.body.expires),homes:[home]};
}
export function validateHomeOffer(offer,state,config,home){
 exact(offer,['certificate','founderConsent']);const b=validateHomeAuthorization(state,offer.certificate,offer.founderConsent,config);
 // One installation per delivered offer: no waiting for other users' signatures.
 assert.deepEqual(b.homes,[home],'Home offer is for another installation');return b;
}
