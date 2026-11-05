// Native device flow. Wallet secrets never leave this process; the browser signs in.
import assert from 'node:assert/strict';
import {hash,integer} from './crypto.mjs';
import {linkRequest,accountConsent,linkAction,SUNPHI_ORIGIN,connectionOptions} from './sunphi-link.mjs';
export const SUNPHI_BRIDGE='https://xybinrgjdtklemaxxder.supabase.co/functions/v1/duebyte-wallet-v1';
export function accountLinkUrl(id){assert(/^[a-f0-9]{64}$/.test(id));return `${SUNPHI_ORIGIN}/DueByteWalletLink?id=${id}`;}
export function allowedAccountUrl(raw){try{if(raw===SUNPHI_ORIGIN+'/Messages')return true;const u=new URL(raw);return u.origin===SUNPHI_ORIGIN&&u.pathname==='/DueByteWalletLink'&&!u.hash&&u.searchParams.size===1&&/^[a-f0-9]{64}$/.test(u.searchParams.get('id'))&&raw===accountLinkUrl(u.searchParams.get('id'));}catch{return false;}}
export class SunPhiConnection{
 constructor({config,store,fetcher=fetch,now=()=>Math.floor(Date.now()/1000)}){Object.assign(this,{config,store,fetcher,now});}
 pending(id){this.store.get(id);const row=this.store.db.prepare('SELECT value FROM preferences WHERE key=?').get('sunphi-pairing:'+id);return row?JSON.parse(row.value):null;}
 save(id,value){this.store.db.prepare('INSERT OR REPLACE INTO preferences VALUES(?,?)').run('sunphi-pairing:'+id,JSON.stringify(value));}
 clear(id){this.store.db.prepare('DELETE FROM preferences WHERE key=?').run('sunphi-pairing:'+id);}
 async call(body){
  const r=await this.fetcher(SUNPHI_BRIDGE,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(12000)});
  assert(r.ok,'Sun·Phi connection could not be verified. Check the connection and try again.');
  let size=0;const parts=[];for await(const c of r.body){size+=c.length;assert(size<=60000,'Unexpected Sun·Phi response.');parts.push(c);}return JSON.parse(Buffer.concat(parts).toString('utf8'));
 }
 signed(key,action,fields={}){return {action,packet:linkAction(this.config,key,action,fields,this.now())};}
 identity(id,key){assert.equal(this.store.get(id).owner,key.publicKey,'Selected wallet changed.');}
 view(id,policy){const link=this.store.sunphiLink(id),p=this.pending(id),valid=p&&this.now()<p.request.body.expires;return {...connectionOptions(link,policy),pairing:valid?{code:p.request.body.nonce.slice(-8).toUpperCase(),url:accountLinkUrl(p.request.body.nonce),phase:p.phase??'requested',accountId:p.accountId??null,expires:p.request.body.expires}:null};}
 async start(id,key){
  this.identity(id,key);assert(this.store.sunphiLink(id)?.status!=='linked','Disconnect the existing account first.');
  let p=this.pending(id);if(!p||this.now()>=p.request.body.expires){p={request:linkRequest(this.config,key,this.now()),phase:'requested'};this.save(id,p);}
  await this.call({action:'start',packet:p.request});return this.view(id);
 }
 validateRow(id,key,row){this.identity(id,key);assert(row&&row.network===this.config.chainId&&row.wallet_key===key.publicKey,'Sun·Phi wallet context changed.');assert(/^[a-f0-9-]{36}$/.test(row.id));assert(/^[A-Za-z0-9_-]{10,80}$/.test(row.account_id));integer(row.revision,1);assert(typeof row.notifications==='boolean');assert(['linked','revoked'].includes(row.status));return row;}
 mirror(id,key,row){
  this.validateRow(id,key,row);let link=this.store.sunphiLink(id);const p=this.pending(id);
  if(row.status==='revoked'){if(link?.linkId===row.id)this.store.revokeSunPhiLink(id);return;}
  if(!link||link.status!=='linked'){
   assert(p?.consent&&p.consent.body.accountId===row.account_id,'Confirm this account connection in the wallet.');
   // A current authenticated bridge response confirms historical consent even if
   // the reply was lost and the original challenge has now expired.
   link=this.store.acceptSunPhiLink(id,{request:p.request,consent:p.consent,accountId:row.account_id,linkId:row.id},hash(this.config),p.request.body.issuedAt);
  }
  assert(link.linkId===row.id&&link.accountId===row.account_id,'Account connection changed. Reconnect this wallet.');
  link={...link,revision:row.revision,notifications:row.notifications};this.store.db.prepare('UPDATE sunphi_links SET body=? WHERE wallet_id=?').run(JSON.stringify(link),id);this.clear(id);
 }
 async refresh(id,key){
  this.identity(id,key);const link=this.store.sunphiLink(id),p=this.pending(id);
  if(link?.status==='linked'||p?.consent){const row=await this.call(this.signed(key,'link_status'));
   if(row.status==='unlinked'){if(link?.status==='linked')this.store.revokeSunPhiLink(id);}else{this.mirror(id,key,row);return this.view(id);}}
  if(p&&this.now()<p.request.body.expires){const row=await this.call(this.signed(key,'status',{id:p.request.body.nonce}));
   assert(row.id===p.request.body.nonce&&['requested','claimed','linked','expired'].includes(row.phase),'Pairing context changed.');
   if(row.phase==='claimed'||row.phase==='linked')assert(/^[A-Za-z0-9_-]{10,80}$/.test(row.account_id));
   this.save(id,{...p,phase:row.phase,accountId:row.account_id??null});}
  return this.view(id);
 }
 async confirm(id,key,accountId){
  this.identity(id,key);await this.refresh(id,key);const p=this.pending(id);
  assert(p&&['claimed','linked'].includes(p.phase)&&p.accountId===accountId,'Account changed. Check the connection again.');
  const consent=accountConsent(p.request,accountId,key,hash(this.config),this.now());this.save(id,{...p,consent});
  const row=await this.call({action:'commit',request:p.request,consent});this.mirror(id,key,row);return this.view(id);
 }
 async notifications(id,key,enabled){
  assert(typeof enabled==='boolean');this.identity(id,key);await this.refresh(id,key);const link=this.store.sunphiLink(id);assert(link?.status==='linked','Connect your Sun·Phi account first.');
  const row=await this.call(this.signed(key,'preferences',{id:link.linkId,revision:link.revision,notifications:enabled}));this.mirror(id,key,row);return this.view(id);
 }
 async revoke(id,key,policy){
  this.identity(id,key);assert(!policy?.enabled&&!policy?.pending,'Turn off additional approval and wait for network confirmation before disconnecting.');
  await this.refresh(id,key);const link=this.store.sunphiLink(id);
  if(link?.status==='linked'){const row=await this.call(this.signed(key,'revoke',{id:link.linkId,revision:link.revision}));this.validateRow(id,key,row);assert.equal(row.status,'revoked');this.mirror(id,key,row);}
  this.clear(id);return this.view(id,policy);
 }
}
