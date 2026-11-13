// Server-side counterpart of the Home collateral consent. No broadcast or mint.
import assert from 'node:assert/strict';
import {exact,hash,integer,sign,verify} from './crypto.mjs';
import {stateHash} from './core.mjs';
import {formatToken} from './token-units.mjs';
import {prepareCollateralReview} from './worker-collateral-plan.mjs';
import {FUND_WORKER} from './worker-collateral.mjs';
import {isBoundedWalletView,assertBoundedWalletView} from './research/bounded-wallet-view.mjs';

// The operator supplies the approved scope locally, never from the request.
// view must fetch a fresh certified owner view, including the selected worker.
export async function signWorkerFunding(consent,{config,key,scope,view,now=Date.now}){
 consent=structuredClone(consent);scope=structuredClone(scope);config=structuredClone(config);
 exact(scope,['configHash','node','owner','valueMicro']);
 assert.equal(scope.configHash,hash(config),'unexpected network configuration');
 exact(consent,['format','type','body','ownerSignature','expectedWorkerKey','workerSignatureRequired','submitted']);
 assert.equal(consent.format,'DUEBYTE_COLLATERAL_OWNER_CONSENT_V1');
 assert.equal(consent.type,FUND_WORKER);assert.equal(consent.workerSignatureRequired,true);assert.equal(consent.submitted,false);
 const b=consent.body;
 exact(b,['domain','configHash','node','owner','sequence','issuedAt','expires','unitScale','inputs','valueMicro']);
 for(const field of ['configHash','node','owner','valueMicro'])assert.equal(b[field],scope[field],'outside approved funding scope');
 assert.equal(consent.expectedWorkerKey,key.publicKey,'unexpected worker signing key');
 assert(verify(b,consent.ownerSignature,scope.owner),'funding owner signature');
 const {state:s,certificate}=await view({owner:scope.owner,rewardIds:[scope.node]});
 if(isBoundedWalletView(s))assertBoundedWalletView(s,certificate,config,scope.owner);
 else assert.equal(stateHash(s,config),certificate.appHash,'unverified funding view');
 assert.equal(s.height,certificate.appHeight);assert.equal(s.configHash,scope.configHash);
 integer(s.money.time,1);const utc=Math.floor(now()/1000);integer(utc,1);
 assert(utc>=s.money.time&&utc-s.money.time<=60,'stale funding view');
 assert.equal(s.money.nodes[b.node]?.key,key.publicKey,'worker key changed');
 const prior=s.workerFunding?.accounts[b.node],bodyHash=hash(b);
 if(prior&&b.sequence<=prior.sequence){
  assert.equal(prior.owner,b.owner,'funding owner changed');
  assert.equal(b.sequence,prior.sequence,'superseded funding consent');
  assert.equal(prior.lastBodyHash,bodyHash,'conflicting funding sequence');
  return {status:'ALREADY_COMMITTED',bodyHash,verifiedHeight:certificate.height,action:null,submitted:false};
 }
 integer(b.issuedAt,1);integer(b.expires,b.issuedAt+1);
 assert(b.expires-b.issuedAt<=600&&b.issuedAt<=s.money.time&&utc<b.expires,'funding consent expired or premature');
 const review=prepareCollateralReview(s,{node:b.node,owner:b.owner,inputs:b.inputs,amount:formatToken(b.valueMicro,b.unitScale),unitScale:b.unitScale});
 assert.deepEqual({...review.body,issuedAt:b.issuedAt,expires:b.expires},b,'funding terms changed');
 const workerSignature=sign(b,key.privateKey);
 assert(verify(b,workerSignature,key.publicKey),'worker signing key mismatch');
 return {status:'SIGNED_NOT_SUBMITTED',bodyHash,verifiedHeight:certificate.height,
  action:{type:FUND_WORKER,body:structuredClone(b),ownerSignature:consent.ownerSignature,workerSignature},submitted:false};
}
