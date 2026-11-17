// A signed current checkpoint and a minimal authenticated policy/payment view.
// The bridge's transition is deployment configuration, never a request field.
import assert from 'node:assert/strict';
import {hash} from '../checkpoint-trial/crypto.mjs';
import {checkpointCertificate} from '../operator-registry/checkpoint-evidence.mjs';
import {verifyBoundedQuery} from '../checkpoint-trial/research/bounded-query.mjs';
import {BOUNDED_DOMAIN} from '../checkpoint-trial/research/bounded-schema.mjs';
import {verifyServiceAnchor} from './indexed-anchor.mjs';
export async function indexedApprovalEvidence(checkpoint,proof,packet,pins,now){
 const terms=pins.indexedTransition;assert(terms&&terms.targetSchema===BOUNDED_DOMAIN,'indexed approvals not configured');
 assert.equal(terms.configHash,pins.configHash);assert.equal(terms.network,pins.root.network);
 assert(terms.issuance===false||(terms.issuance===undefined&&terms.kind==='fresh-genesis'&&terms.sourceHeight===0&&terms.archive===null),'trusted non-issuing root required');
 const {policy,renewals}=await checkpointCertificate(checkpoint,pins,null,now);
 assert(checkpoint.body.appHeight>=terms.activationHeight);
 const request={type:'approval-context',id:{owner:packet.body.wallet,pid:packet.body.kind==='payment'?packet.body.payload.intent.pid:null}};
 const result=verifyBoundedQuery(proof,request,checkpoint.body.appHash,pins.configHash);assert.equal(result.height,checkpoint.body.appHeight);assert.equal(result.isolatedIssuance,false);
 const {state,anchor}=result.data;
 verifyServiceAnchor(anchor,terms);
 assert.equal(hash(state.authority.policy),hash(policy));assert.equal(hash(state.authority.renewals),hash(renewals));return state;
}
