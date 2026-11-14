// Two-sided, expiring pairing. Receipt of a request never proves registration.
import assert from 'node:assert/strict';import {hash,exact,hex,publicKey,integer,verify,sign} from './crypto.mjs';
import {nodeLinkBlockers} from './node-link-state.mjs';
import {auditRewards,rewardsEnabled} from './node-rewards.mjs';
import {controllerContext} from './controller-context.mjs';
import {cloneRewardLedger} from './reward-registry-view.mjs';
export const NODE_LINK_ACTION='SET_NODE_WALLET_LINK_V1',NODE_LINK_DOMAIN='DUEBYTE_NODE_WALLET_LINK_V1';
export const pairingCode=body=>hash(body).slice(0,12).toUpperCase().match(/.{4}/g).join('-');
export function prepareNodeLink(s,node,wallet,operation,nonce){
 hex(node);publicKey(wallet);hex(nonce);assert(rewardsEnabled(s),'Reward registration is not active.');assert(['link','unlink'].includes(operation));const n=s.rewards?.nodes[node];assert(n,'Registered reward node required.');
 assert(operation==='unlink'?n.payouts.some(p=>p.wallet===wallet):!n.payouts.some(p=>p.wallet===wallet),'Wallet link already matches the requested state.');
 if(n.payouts.length)assert.equal(nodeLinkBlockers(s,node).length,0,nodeLinkBlockers(s,node).join(' '));
 const payouts=operation==='link'?[...n.payouts,{wallet,weight:1}]:n.payouts.filter(p=>p.wallet!==wallet);assert(payouts.length<=16);
 return {domain:NODE_LINK_DOMAIN,configHash:s.configHash,node,wallet,operation,sequence:n.sequence+1,previousPayoutsHash:hash(n.payouts),management:n.management,issuedAt:s.money.time,expires:s.money.time+600,nonce,payouts};
}
export function verifyNodeLink(s,request){
 exact(request,['body','walletSignature']);const b=request.body;exact(b,['domain','configHash','node','wallet','operation','sequence','previousPayoutsHash','management','issuedAt','expires','nonce','payouts']);
 assert.equal(b.domain,NODE_LINK_DOMAIN);assert.equal(b.configHash,s.configHash);integer(b.issuedAt,1);integer(b.expires,b.issuedAt+1);assert(b.expires-b.issuedAt<=600&&s.money.time>=b.issuedAt&&s.money.time<b.expires,'Pairing request expired.');
 assert(verify(b,request.walletSignature,b.wallet),'Wallet ownership signature required.');
 const expected=prepareNodeLink(s,b.node,b.wallet,b.operation,b.nonce);assert.deepEqual({...expected,issuedAt:b.issuedAt,expires:b.expires},b,'Node link changed. Start again.');return b;
}
export function approveNodeLink(s,request,key,code){
 const b=verifyNodeLink(s,request);assert.equal(key.publicKey,b.management,'Node management key required.');assert.equal(code,pairingCode(b),'Pairing code does not match.');
 return {type:NODE_LINK_ACTION,request,managementSignature:sign(b,key.privateKey)};
}
export function applyNodeLink(s,a,author){
 exact(a,['type','request','managementSignature']);assert.equal(a.type,NODE_LINK_ACTION);const b=verifyNodeLink(s,a.request);assert.equal(author,b.management);assert(verify(b,a.managementSignature,b.management),'Node management approval required.');
 const rewards=cloneRewardLedger(s.rewards);rewards.nodes[b.node].payouts=structuredClone(b.payouts);rewards.nodes[b.node].sequence=b.sequence;
 const next={...s,rewards};auditRewards(next,controllerContext(s));return next;
}
