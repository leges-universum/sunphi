// Account consent is distinct from payment authority. No names or identity papers.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {hash,sign,verify,exact,hex,integer,publicKey} from './crypto.mjs';
export const SUNPHI_ORIGIN='https://ai-agent-online.com';
export const SUNPHI_APP='696e4a5c63b67ccaefee6b6a';
export const LINK='DUEBYTE_SUNPHI_LINK_V1';
export const LINK_SCOPES=Object.freeze(['payment-notifications','payment-approval']);
export function linkAction(config,key,action,fields={},now=Math.floor(Date.now()/1000)){
 const names={status:['id'],link_status:[],preferences:['id','revision','notifications'],revoke:['id','revision']};assert(Object.hasOwn(names,action),'unknown link action');exact(fields,names[action]);
 const body={domain:LINK+'/ACTION',origin:SUNPHI_ORIGIN,app:SUNPHI_APP,network:config.chainId,configHash:hash(config),wallet:key.publicKey,action,issuedAt:now,expires:now+120,...fields};return {body,signature:sign(body,key.privateKey)};
}
export function validateLinkAction(packet,action,configHash,now=Math.floor(Date.now()/1000)){
 exact(packet,['body','signature']);const b=packet.body,fields=['domain','origin','app','network','configHash','wallet','action','issuedAt','expires'];
 assert(['status','link_status','preferences','revoke'].includes(action));
 if(action!=='link_status')fields.push('id');if(['preferences','revoke'].includes(action))fields.push('revision');if(action==='preferences')fields.push('notifications');exact(b,fields);
 assert.equal(b.domain,LINK+'/ACTION');assert.equal(b.origin,SUNPHI_ORIGIN);assert.equal(b.app,SUNPHI_APP);assert.equal(b.configHash,configHash);assert.equal(b.action,action);publicKey(b.wallet);
 integer(b.issuedAt,1);integer(b.expires,b.issuedAt+1);assert(b.expires-b.issuedAt<=120&&b.issuedAt<=now+30&&now<b.expires,'action expired or future');
 if(action==='status')hex(b.id);if(['preferences','revoke'].includes(action)){assert(/^[a-f0-9-]{36}$/.test(b.id));integer(b.revision,1);}if(action==='preferences')assert(typeof b.notifications==='boolean');
 assert(verify(b,packet.signature,b.wallet),'wallet action signature');return b;
}
export function linkRequest(config,key,now=Math.floor(Date.now()/1000)){
 const body={domain:LINK+'/REQUEST',origin:SUNPHI_ORIGIN,app:SUNPHI_APP,network:config.chainId,configHash:hash(config),wallet:key.publicKey,nonce:randomBytes(32).toString('hex'),issuedAt:now,expires:now+600};
 return {body,signature:sign(body,key.privateKey)};
}
export function validateLinkRequest(packet,configHash,now=Math.floor(Date.now()/1000)){
 exact(packet,['body','signature']);const b=packet.body;exact(b,['domain','origin','app','network','configHash','wallet','nonce','issuedAt','expires']);
 assert.equal(b.domain,LINK+'/REQUEST');assert.equal(b.origin,SUNPHI_ORIGIN);assert.equal(b.app,SUNPHI_APP);assert.equal(b.configHash,configHash);assert(/^duebyte-trial-[a-z0-9-]{1,50}$/.test(b.network));
 publicKey(b.wallet);hex(b.nonce);integer(b.issuedAt,1);integer(b.expires,b.issuedAt+1);assert(b.expires-b.issuedAt<=600&&b.issuedAt<=now+30&&now<b.expires,'link request expired or future');assert(verify(b,packet.signature,b.wallet),'wallet link signature');return b;
}
export function accountConsent(request,accountId,key,configHash,now=Math.floor(Date.now()/1000)){
 const b=validateLinkRequest(request,configHash,now);assert.equal(b.wallet,key.publicKey);assert(typeof accountId==='string'&&/^[A-Za-z0-9_-]{10,80}$/.test(accountId),'account identifier');
 const body={domain:LINK+'/CONSENT',requestHash:hash(request),origin:SUNPHI_ORIGIN,app:SUNPHI_APP,network:b.network,configHash,wallet:b.wallet,accountId,nonce:b.nonce,expires:b.expires,notifications:false,approval:false};
 return {body,signature:sign(body,key.privateKey)};
}
export function validateAccountConsent(consent,request,authenticatedAccountId,configHash,now=Math.floor(Date.now()/1000)){
 const b=validateLinkRequest(request,configHash,now);exact(consent,['body','signature']);const c=consent.body;
 exact(c,['domain','requestHash','origin','app','network','configHash','wallet','accountId','nonce','expires','notifications','approval']);
 assert.equal(c.domain,LINK+'/CONSENT');assert.equal(c.requestHash,hash(request));
 for(const name of ['origin','app','network','configHash','wallet','nonce','expires'])assert.equal(c[name],b[name],'link context changed');
 assert.equal(c.accountId,authenticatedAccountId,'authenticated account required');assert.equal(c.notifications,false,'linking does not enable notifications');assert.equal(c.approval,false,'linking does not enable payment approval');
 assert(verify(c,consent.signature,b.wallet),'wallet consent signature');return c;
}
export function connectionOptions(link,policy){
 const linked=!!link&&link.origin===SUNPHI_ORIGIN&&link.app===SUNPHI_APP&&link.status==='linked';
 return {linked,origin:SUNPHI_ORIGIN,notifications:{available:linked,enabled:linked&&link.notifications===true},approval:{available:linked,enabled:!!policy?.enabled,requiresNetworkActivation:true},accountId:linked?link.accountId:null};
}
