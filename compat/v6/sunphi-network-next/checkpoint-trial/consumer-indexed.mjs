// Verify the current indexed migration anchor before committing a Home switch.
import assert from 'node:assert/strict';
import {hash} from './crypto.mjs';
import {verifyCheckpoint} from './checkpoint.mjs';
import {boundedHttpQuery,loadBoundedServiceView} from './research/bounded-wallet-view.mjs';
import {verifyBoundedTransitionTerms,verifyBoundedViewAnchor} from './research/bounded-root-transition.mjs';
import {freshRootTerms} from './research/fresh-application.mjs';
const evidence=new WeakMap();
const context=(p,checkpoint)=>hash({profile:hash(p),checkpoint:hash(checkpoint)});
export async function authenticateConsumerIndexedCheckpoint(p,checkpoint){
 verifyCheckpoint(checkpoint,p.policy,{configHash:hash(p.config)});
 assert(!(p.fresh&&p.indexed),'ambiguous consumer state authority');
 const terms=p.fresh?freshRootTerms(p.config,p.fresh):verifyBoundedTransitionTerms(p.indexed.certificate,p.indexed.source,p.config,hash(p.indexed.source));
 assert(checkpoint.body.appHeight>=terms.activationHeight,'waiting for the first indexed checkpoint');
 const view=await boundedHttpQuery((p.fresh??p.indexed).url).withLease(checkpoint.body.appHash,query=>loadBoundedServiceView(query,{root:checkpoint.body.appHash,height:checkpoint.body.appHeight,configHash:hash(p.config)}));
 verifyBoundedViewAnchor(view.anchor,terms);
 const receipt=Object.freeze({});evidence.set(receipt,context(p,checkpoint));return receipt;
}
export function requireConsumerIndexedCheckpoint(p,checkpoint,receipt){
 assert(receipt&&evidence.get(receipt)===context(p,checkpoint),'authenticated indexed checkpoint required');
}
