// Local node-management consent. Public packet only; keys never leave the node.
import assert from 'node:assert/strict';
import {exact,hex,integer,hash,sign} from './crypto.mjs';
import {envelope} from './core.mjs';
import {OPERATOR_LINK} from './research/operator-reward-policy.mjs';
const DAY=86400;
export function prepareOperatorLink({profile,view,config,automaticLegalUpdates=true,revoke=false,now=Date.now()}){
 exact(profile,['format','applicationId','configHash','operator','profileHash','label']);
 assert.equal(profile.format,'DUEBYTE_REWARD_PROFILE_V1');assert(/^[a-f0-9-]{36}$/.test(profile.applicationId));
 assert.equal(profile.configHash,hash(config));hex(profile.operator);hex(profile.profileHash);
 assert(typeof profile.label==='string'&&profile.label.length>0&&profile.label.length<=200);
 assert.equal(view.kind,'worker');assert(view.policy,'Operator registration policy is not enabled yet');
 assert(Math.abs(Math.floor(now/1000)-view.time)<=60,'Wait for current verified network data');
 assert.equal(typeof automaticLegalUpdates,'boolean');assert.equal(typeof revoke,'boolean');
 const old=view.link,day=Math.ceil((view.time+1)/DAY)*DAY;
 if(old?.pending.effectiveFrom>view.time)assert(revoke,'The previous consent starts at the next UTC boundary');
 const body={domain:OPERATOR_LINK,configHash:profile.configHash,node:hex(view.node),operator:profile.operator,profileHash:profile.profileHash,sequence:(old?.sequence??0)+1,effectiveFrom:old?.pending.effectiveFrom>view.time?old.pending.effectiveFrom:Math.max(day,view.policy.effectiveFrom),validUntil:revoke?0:Math.floor((view.time+365*DAY)/DAY)*DAY,automaticLegalUpdates};
 assert(body.effectiveFrom<=view.time+30*DAY);if(!revoke)assert(body.validUntil>body.effectiveFrom);
 integer(body.sequence,1);return {body,label:profile.label,applicationId:profile.applicationId,management:view.management};
}
export function signOperatorLink(review,key,config){
 assert.equal(review.management,key.publicKey,'This service does not hold the node management key');
 const action={type:OPERATOR_LINK,body:review.body,signature:sign(review.body,key.privateKey)};
 return envelope(config,action,key);
}
