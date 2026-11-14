// Portable encrypted logical journal. No signing keys; no implicit activation.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomBytes,scryptSync,createCipheriv,createDecipheriv} from 'node:crypto';
import {hash,digest,exact} from '../crypto.mjs';
import {ExchangeRecovery} from './exchange-recovery.mjs';
const DOMAIN='DUEBYTE_EXCHANGE_RECOVERY_BACKUP_V1',MAX=48*1024*1024;
const derive=(password,salt)=>{assert(typeof password==='string'&&password.length>=16&&password.length<=1024);return scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});};
export function sealRecoveryBackup(worker,password){
 const payload=worker.snapshot(),raw=Buffer.from(JSON.stringify(payload)),salt=randomBytes(32),iv=randomBytes(12);assert(raw.length<=MAX);const key=derive(password,salt);
 try{const c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(JSON.stringify([DOMAIN,worker.pin])));const bytes=Buffer.concat([c.update(raw),c.final()]);return {domain:DOMAIN,pin:worker.pin,salt:salt.toString('hex'),iv:iv.toString('hex'),tag:c.getAuthTag().toString('hex'),ciphertext:bytes.toString('base64')};}finally{raw.fill(0);key.fill(0);}
}
export function restoreRecoveryBackup(bundle,{password,file,config,key}){
 exact(bundle,['domain','pin','salt','iv','tag','ciphertext']);assert.equal(bundle.domain,DOMAIN);assert.equal(bundle.pin,hash(config));assert(/^[a-f0-9]{64}$/.test(bundle.salt)&&/^[a-f0-9]{24}$/.test(bundle.iv)&&/^[a-f0-9]{32}$/.test(bundle.tag));assert(typeof bundle.ciphertext==='string'&&bundle.ciphertext.length<=Math.ceil(MAX/3)*4);assert(Buffer.isBuffer(key)&&key.length===32);
 const bytes=Buffer.from(bundle.ciphertext,'base64');assert.equal(bytes.toString('base64'),bundle.ciphertext);const derived=derive(password,Buffer.from(bundle.salt,'hex'));let raw,check,worker;
 try{const d=createDecipheriv('aes-256-gcm',derived,Buffer.from(bundle.iv,'hex'));d.setAAD(Buffer.from(JSON.stringify([DOMAIN,bundle.pin])));d.setAuthTag(Buffer.from(bundle.tag,'hex'));raw=Buffer.concat([d.update(bytes),d.final()]);assert(raw.length<=MAX);const snapshot=JSON.parse(raw);
  check=new ExchangeRecovery(':memory:',{config,key});check.restoreSnapshot(snapshot);check.close();check=null;
  // Validate completely before touching the destination; never overwrite data.
  const fd=fs.openSync(file,'wx',0o600);fs.closeSync(fd);
  worker=new ExchangeRecovery(file,{config,key});worker.restoreSnapshot(snapshot);return worker;
 }catch(e){worker?.close();throw e;}finally{check?.close();raw?.fill(0);derived.fill(0);}
}
export function writeRecoveryBackup(file,bundle){const bytes=Buffer.from(JSON.stringify(bundle));assert(bytes.length<=MAX*1.4);const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return {sha256:digest(bytes),bytes:bytes.length};}
