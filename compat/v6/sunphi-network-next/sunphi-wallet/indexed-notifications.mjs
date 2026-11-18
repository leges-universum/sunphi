import assert from 'node:assert/strict';
import {hash} from '../checkpoint-trial/crypto.mjs';
import {checkpointCertificate} from '../operator-registry/checkpoint-evidence.mjs';
import {verifyBoundedQuery} from '../checkpoint-trial/research/bounded-query.mjs';
import {BOUNDED_DOMAIN} from '../checkpoint-trial/research/bounded-schema.mjs';
import {paymentEvents} from './payment-events.mjs';
import {verifyServiceAnchor} from './indexed-anchor.mjs';
export async function indexedNotificationEvidence(checkpoint,proof,pins,previous,now){
 const t=pins.indexedTransition;assert(t&&t.targetSchema===BOUNDED_DOMAIN,'indexed notifications not configured');
 assert.equal(t.configHash,pins.configHash);assert.equal(t.network,pins.root.network);
 assert(t.issuance===false||(t.issuance===undefined&&t.kind==='fresh-genesis'&&t.sourceHeight===0&&t.archive===null),'trusted non-issuing root required');
 const {policy,renewals}=await checkpointCertificate(checkpoint,pins,previous,now);assert(checkpoint.body.appHeight>=t.activationHeight);
 assert.equal(proof.request?.type,'payment-events');
 const r=verifyBoundedQuery(proof,proof.request,checkpoint.body.appHash,pins.configHash);assert.equal(r.height,checkpoint.body.appHeight);assert.equal(r.isolatedIssuance,false);
 const {anchor,authority,items,offset,total,next}=r.data;
 verifyServiceAnchor(anchor,t);
 assert.equal(hash(authority.policy),hash(policy));assert.equal(hash(authority.renewals),hash(renewals));
 // Keep distinct statuses of the same payment, even within a single page.
 const events=[];for(const {index,value}of items){const rows=await paymentEvents({configHash:pins.configHash,money:{requests:{[value.intent.pid]:value}}},checkpoint);for(const event of rows)events.push({index,event});}
 return {offset,total,end:offset+items.length,next,events};
}
