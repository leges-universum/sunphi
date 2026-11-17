// Read-only proofs: the peer never chooses the trusted root or account.
import assert from 'node:assert/strict';
import {hash,hex} from '../checkpoint-trial/crypto.mjs';
import {checkpointCertificate} from '../operator-registry/checkpoint-evidence.mjs';
import {verifyBoundedQuery} from '../checkpoint-trial/research/bounded-query.mjs';
import {verifyServiceAnchor} from './indexed-anchor.mjs';
import {serverAlertConditions} from '../checkpoint-trial/node-alerts.mjs';
export async function nodeAlertEvidence({checkpoint,meta,worker,reward},node,pins,previous,now){
 hex(node);assert(pins.indexedTransition,'Indexed network pins required.');
 assert.equal(pins.indexedTransition.configHash,pins.configHash);assert.equal(pins.indexedTransition.network,pins.root.network);
 const {policy,renewals}=await checkpointCertificate(checkpoint,pins,previous,now),root=checkpoint.body.appHash;
 assert(checkpoint.body.appHeight>=pins.indexedTransition.activationHeight);
 const read=(proof,request)=>{const r=verifyBoundedQuery(proof,request,root,pins.configHash);assert.equal(r.height,checkpoint.body.appHeight);assert.equal(r.isolatedIssuance,false);return r.data;};
 const m=read(meta,{type:'wallet-meta',id:null}),n=read(worker,{type:'node',id:node});
 verifyServiceAnchor(m.anchor,pins.indexedTransition);assert.equal(hash(m.network.authority.policy),hash(policy));assert.equal(hash(m.network.authority.renewals),hash(renewals));
 const r=read(reward,{type:'reward-account',id:node});
 return {node,network:pins.root.network,height:checkpoint.body.appHeight,root,management:r?.management??null,...serverAlertConditions(r,n)};
}
