// Explicit service consent. Neither wallet payouts nor spending rights change.
import assert from 'node:assert/strict';
import {hash,sign,verify,exact,hex,integer,publicKey} from './crypto.mjs';
import {SUNPHI_ORIGIN,SUNPHI_APP} from './sunphi-link.mjs';
export const NODE_ALERTS='DUEBYTE_NODE_ALERTS_V1';
export const ALERT_CODES=Object.freeze(['NO_PAYOUT_WALLET','NO_COLLATERAL','COVERAGE_UNAVAILABLE']);
export function prepareNodeAlerts(s,network,node,wallet,link,enabled,revision,nonce,now){
 hex(node);publicKey(wallet);hex(nonce);integer(revision);integer(now,1);assert(typeof enabled==='boolean');
 assert(link?.status==='linked'&&link.network===network&&link.wallet_key===wallet,'Confirmed account link required.');
 assert(/^[a-f0-9-]{36}$/.test(link.id)&&/^[A-Za-z0-9_-]{10,80}$/.test(link.account_id));integer(link.revision,1);
 const r=s.rewards?.nodes[node];assert(r&&s.money.nodes[node],'Registered server worker required.');publicKey(r.management);
 return {domain:NODE_ALERTS,origin:SUNPHI_ORIGIN,app:SUNPHI_APP,network,configHash:s.configHash,node,wallet,management:r.management,
  linkId:link.id,linkRevision:link.revision,account:link.account_id,revision:revision+1,enabled,nonce,issuedAt:now,expires:now+600};
}
export function verifyNodeAlertConsent(request,pins,now){
 exact(request,['body','walletSignature']);const b=request.body;
 exact(b,['domain','origin','app','network','configHash','node','wallet','management','linkId','linkRevision','account','revision','enabled','nonce','issuedAt','expires']);
 assert.equal(b.domain,NODE_ALERTS);assert.equal(b.origin,SUNPHI_ORIGIN);assert.equal(b.app,SUNPHI_APP);assert.equal(b.network,pins.root.network);assert.equal(b.configHash,pins.configHash);
 hex(b.node);hex(b.nonce);publicKey(b.wallet);publicKey(b.management);integer(b.revision,1);integer(b.linkRevision,1);
 assert(/^[a-f0-9-]{36}$/.test(b.linkId)&&/^[A-Za-z0-9_-]{10,80}$/.test(b.account)&&typeof b.enabled==='boolean');
 integer(b.issuedAt,1);integer(b.expires,b.issuedAt+1);assert(b.expires-b.issuedAt<=600&&b.issuedAt<=now+30&&now<b.expires,'Alert consent expired.');
 assert(verify(b,request.walletSignature,b.wallet),'Wallet alert consent required.');return b;
}
export const alertPairingCode=b=>hash(b).slice(0,12).toUpperCase().match(/.{4}/g).join('-');
export function approveNodeAlerts(s,network,request,key,code,now){
 const b=verifyNodeAlertConsent(request,{root:{network},configHash:s.configHash},now);
 assert.equal(s.rewards?.nodes[b.node]?.management,b.management,'Server authority changed.');
 assert.equal(key.publicKey,b.management);assert.equal(code,alertPairingCode(b),'Pairing code mismatch.');
 return {request,managementSignature:sign(b,key.privateKey)};
}
// Only authenticated, complete node records reach this classifier. A failed
// observation is never represented as missing collateral or missing wallets.
export function serverAlertConditions(reward,worker){
 if(!reward||!worker)return {known:false,codes:[]};
 const codes=[];if(!reward.payouts.length)codes.push('NO_PAYOUT_WALLET');
 const stake=BigInt(worker.stake),held=BigInt(worker.consensusHeld)+BigInt(worker.taskHeld);
 if(stake===0n)codes.push('NO_COLLATERAL');
 else if(stake<=held||BigInt(worker.tier)===0n||BigInt(worker.consensusHeld)===0n)codes.push('COVERAGE_UNAVAILABLE');
 return {known:true,codes};
}
