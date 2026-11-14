// Offline encrypted lab custody bundle. No passwords, keys or raw transactions in logs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomBytes,scryptSync,createCipheriv,createDecipheriv} from 'node:crypto';
import {exact,hex,digest} from '../crypto.mjs';
import {RefundOutbox} from './purchase-refund-worker.mjs';
const DOMAIN='DUEBYTE_PURCHASE_CUSTODY_V1',MAX=24*1024*1024;
function validate(payload,configHash,policyHash){
 exact(payload,['domain','configHash','policyHash','secrets','outbox']);assert.equal(payload.domain,DOMAIN);hex(configHash);hex(policyHash);assert.equal(payload.configHash,configHash);assert.equal(payload.policyHash,policyHash);
 assert(Array.isArray(payload.secrets)&&payload.secrets.length>0&&payload.secrets.length<=16);const names=new Set();
 for(const s of payload.secrets){exact(s,['name','kind','data']);assert(/^[a-z0-9-]{1,64}$/.test(s.name)&&!names.has(s.name));names.add(s.name);assert(['bitcoin-wallet-backup','evm-private-key','ed25519-private-key'].includes(s.kind));assert(typeof s.data==='string'&&s.data.length>0&&s.data.length<=16*1024*1024&&Buffer.from(s.data,'base64').toString('base64')===s.data);}
 assert.equal(payload.outbox.configHash,configHash);
 // Reuse the full outbox validator without touching a recovery destination.
 const check=new RefundOutbox(':memory:');try{check.restore(payload.outbox,configHash);}finally{check.close();}
}
const passwordKey=(password,salt)=>{assert(typeof password==='string'&&password.length>=16&&password.length<=1024,'backup password length');return scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});};
export function sealPurchaseCustody({configHash,policyHash,secrets,outbox},password){
 const payload={domain:DOMAIN,configHash,policyHash,secrets,outbox};validate(payload,configHash,policyHash);
 const raw=Buffer.from(JSON.stringify(payload));assert(raw.length<=MAX);const salt=randomBytes(32),iv=randomBytes(12),key=passwordKey(password,salt);
 try{const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(JSON.stringify([DOMAIN,configHash,policyHash])));const encrypted=Buffer.concat([cipher.update(raw),cipher.final()]);return {domain:DOMAIN,configHash,policyHash,salt:salt.toString('hex'),iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),ciphertext:encrypted.toString('base64')};}finally{raw.fill(0);key.fill(0);}
}
export function openPurchaseCustody(bundle,password,{configHash,policyHash}){
 exact(bundle,['domain','configHash','policyHash','salt','iv','tag','ciphertext']);assert.equal(bundle.domain,DOMAIN);hex(configHash);hex(policyHash);assert.equal(bundle.configHash,configHash);assert.equal(bundle.policyHash,policyHash);
 assert(/^[a-f0-9]{64}$/.test(bundle.salt)&&/^[a-f0-9]{24}$/.test(bundle.iv)&&/^[a-f0-9]{32}$/.test(bundle.tag));assert(typeof bundle.ciphertext==='string'&&bundle.ciphertext.length<=Math.ceil(MAX/3)*4);
 const encrypted=Buffer.from(bundle.ciphertext,'base64');assert.equal(encrypted.toString('base64'),bundle.ciphertext);const key=passwordKey(password,Buffer.from(bundle.salt,'hex'));let raw;
 try{const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(bundle.iv,'hex'));decipher.setAAD(Buffer.from(JSON.stringify([DOMAIN,configHash,policyHash])));decipher.setAuthTag(Buffer.from(bundle.tag,'hex'));raw=Buffer.concat([decipher.update(encrypted),decipher.final()]);const payload=JSON.parse(raw);validate(payload,configHash,policyHash);return payload;}finally{key.fill(0);raw?.fill(0);}
}
export function writePurchaseCustody(file,bundle){
 const bytes=Buffer.from(JSON.stringify(bundle));assert(bytes.length<=MAX*1.4);const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 return {sha256:digest(bytes),bytes:bytes.length};
}
