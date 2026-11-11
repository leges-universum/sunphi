// Offline external-key recovery preparation. The personal DUBYT key is never
// included. Restoring this bundle cannot activate an external signing service.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createECDH,randomBytes,scryptSync,createCipheriv,createDecipheriv} from 'node:crypto';
import {hash,hex,exact,publicKey,digest} from '../crypto.mjs';
import {ExchangeRecovery} from './exchange-recovery.mjs';
const DOMAIN='DUEBYTE_EXCHANGE_EXTERNAL_CUSTODY_V1',MAX=48*1024*1024;
const derive=(password,salt)=>{assert(typeof password==='string'&&password.length>=16&&password.length<=1024,'backup password length');return scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});};
export function externalPublicKey(secret){assert(Buffer.isBuffer(secret)&&secret.length===32);const e=createECDH('secp256k1');e.setPrivateKey(secret);return e.getPublicKey('hex','compressed');}
export function checkExternalCustodyProfile(profile,config){
 exact(profile,['domain','configHash','seller','bitcoinPublicKey','basePublicKey']);assert.equal(profile.domain,DOMAIN+'/PROFILE');assert.equal(profile.configHash,hash(config));publicKey(profile.seller);
 assert.equal(profile.seller,config.exchangeLab?.policy?.provider,'seller identity mismatch');
 for(const field of ['bitcoinPublicKey','basePublicKey'])assert(/^(02|03)[a-f0-9]{64}$/.test(profile[field]));
 assert.notEqual(profile.bitcoinPublicKey,profile.basePublicKey,'separate external keys required');return hash(profile);
}
function validate(payload,profile,config){
 exact(payload,['domain','profile','snapshot','bitcoin','base']);assert.equal(payload.domain,DOMAIN);assert.deepEqual(payload.profile,profile);checkExternalCustodyProfile(profile,config);
 let bitcoin,base,check;try{
  for(const field of ['bitcoin','base'])assert(typeof payload[field]==='string'&&/^[a-f0-9]{64}$/.test(payload[field]),'private key encoding');
  bitcoin=Buffer.from(payload.bitcoin,'hex');base=Buffer.from(payload.base,'hex');assert.equal(externalPublicKey(bitcoin),profile.bitcoinPublicKey);assert.equal(externalPublicKey(base),profile.basePublicKey);
  check=new ExchangeRecovery(':memory:',{config,key:randomBytes(32)});check.restoreSnapshot(payload.snapshot);
 }finally{bitcoin?.fill(0);base?.fill(0);check?.close();}
}
export function sealExternalCustody(worker,profile,{bitcoin,base},password){
 const profileHash=checkExternalCustodyProfile(profile,worker.config),snapshot=worker.snapshot();
 assert.equal(externalPublicKey(bitcoin),profile.bitcoinPublicKey);assert.equal(externalPublicKey(base),profile.basePublicKey);
 const payload={domain:DOMAIN,profile,snapshot,bitcoin:bitcoin.toString('hex'),base:base.toString('hex')};validate(payload,profile,worker.config);
 const raw=Buffer.from(JSON.stringify(payload));assert(raw.length<=MAX);const salt=randomBytes(32),iv=randomBytes(12),key=derive(password,salt),checkpoint=hash(snapshot);
 try{const c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(JSON.stringify([DOMAIN,profileHash,checkpoint])));const data=Buffer.concat([c.update(raw),c.final()]);return {domain:DOMAIN,profileHash,checkpoint,salt:salt.toString('hex'),iv:iv.toString('hex'),tag:c.getAuthTag().toString('hex'),ciphertext:data.toString('base64')};}
 finally{key.fill(0);raw.fill(0);payload.bitcoin='';payload.base='';}
}
// expectedCheckpoint must come from an independently retained inventory, not
// from the offered bundle. A matching old inventory still cannot prove freshness.
// Validate keys, then discard plaintext; only the restricted journal is restored.
// Operational key installation/nonce reconciliation is a separate future gate.
export function restoreExternalCustody(bundle,{profile,config,password,expectedCheckpoint,file,journalKey}){
 exact(bundle,['domain','profileHash','checkpoint','salt','iv','tag','ciphertext']);assert.equal(bundle.domain,DOMAIN);assert.equal(bundle.profileHash,checkExternalCustodyProfile(profile,config));hex(expectedCheckpoint);assert.equal(bundle.checkpoint,expectedCheckpoint,'custody checkpoint mismatch');
 assert(/^[a-f0-9]{64}$/.test(bundle.salt)&&/^[a-f0-9]{24}$/.test(bundle.iv)&&/^[a-f0-9]{32}$/.test(bundle.tag));assert(typeof bundle.ciphertext==='string'&&bundle.ciphertext.length<=Math.ceil(MAX/3)*4);assert(Buffer.isBuffer(journalKey)&&journalKey.length===32);
 const data=Buffer.from(bundle.ciphertext,'base64');assert.equal(data.toString('base64'),bundle.ciphertext);const key=derive(password,Buffer.from(bundle.salt,'hex'));let raw,payload,worker;
 try{
  const d=createDecipheriv('aes-256-gcm',key,Buffer.from(bundle.iv,'hex'));d.setAAD(Buffer.from(JSON.stringify([DOMAIN,bundle.profileHash,bundle.checkpoint])));d.setAuthTag(Buffer.from(bundle.tag,'hex'));raw=Buffer.concat([d.update(data),d.final()]);assert(raw.length<=MAX);payload=JSON.parse(raw);
  validate(payload,profile,config);assert.equal(hash(payload.snapshot),expectedCheckpoint);
  const fd=fs.openSync(file,'wx',0o600);fs.closeSync(fd);worker=new ExchangeRecovery(file,{config,key:journalKey});worker.restoreSnapshot(payload.snapshot);
  return {worker,signingEnabled:false,publicKeys:{bitcoin:profile.bitcoinPublicKey,base:profile.basePublicKey},checkpoint:expectedCheckpoint};
 }catch(e){worker?.close();throw e;}finally{key.fill(0);raw?.fill(0);if(payload){payload.bitcoin='';payload.base='';}}
}
export function writeExternalCustody(file,bundle){const bytes=Buffer.from(JSON.stringify(bundle));assert(bytes.length<=MAX*1.4);const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return {sha256:digest(bytes),bytes:bytes.length};}
