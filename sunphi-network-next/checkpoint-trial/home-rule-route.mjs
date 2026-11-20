import assert from 'node:assert/strict';
import {exact,hash,hex,integer,publicKey,verify} from './crypto.mjs';
import {rpc} from './client.mjs';
import {PREPARE_DOMAIN} from './bond-preparation-ballot.mjs';
export const RULE_ROUTE='DUEBYTE_SERVER_RULE_ROUTE_V1',RULE_VOTE='DUEBYTE_SERVER_RULE_VOTE_V1';
export function checkRuleGrant(grant,state,network,node){
 exact(grant,['network','configHash','generation','node','controller','owner','domain','expiresHeight','proposal','nonce']);
 hex(grant.proposal);hex(grant.nonce);
 assert.equal(grant.network,network);assert.equal(grant.configHash,state.configHash);
 assert.equal(grant.generation,state.authority?.generation);assert.equal(grant.node,hex(node));
 assert(['DUEBYTE_OFFCHAIN_RULE_REVIEW_V1',PREPARE_DOMAIN,'SEAL_ORDINARY_EMISSION_CURVE_V1'].includes(grant.domain));integer(grant.expiresHeight,state.height);
 publicKey(grant.owner);publicKey(grant.controller);
 assert(state.authority.validators.some(v=>v.key===grant.controller),'Controller no longer eligible');
}
export async function requestRuleVote(wallet,node,request){
 const url=wallet.routes[node]??wallet.url;assert(url,'No connection to this server');
 const data=Buffer.from(JSON.stringify(request));assert(data.length<=4096);
 const result=await rpc(url,'abci_query',{path:'/work',data:data.toString('hex')});
 assert(!result.response.code,'Server voting is unavailable. Check the operator pairing.');
 return JSON.parse(Buffer.from(result.response.value,'base64'));
}
export function verifyRuleRoute(reply,state,network,node,owner){
 exact(reply,['body','signature']);const {body}=reply;exact(body,['operation','grant','id']);
 checkRuleGrant(body.grant,state,network,node);assert.equal(body.operation,RULE_ROUTE);assert.equal(body.id,hash(body.grant));
 assert.equal(body.grant.owner,owner);
 assert(verify(body,reply.signature,state.money.nodes[node].key),'Invalid server routing signature');
 return body.grant;
}
