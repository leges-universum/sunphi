// Operational unlock envelope. Separate from worker-backup recovery, which
// deliberately cannot activate signing. No rollback or HSM claim is made here.
import assert from 'node:assert/strict';
import {randomBytes,scryptSync,createCipheriv,createDecipheriv} from 'node:crypto';
import {hash,exact,hex} from '../crypto.mjs';
const DOMAIN='DUEBYTE_SIGNER_VAULT_V1',MAX=65536;
function derive(password,salt){assert(Buffer.isBuffer(password)&&password.length>=16&&password.length<=1024);return scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});}
export function signingVaultBinding(profile){
 const {vault,...binding}=profile;
 exact(binding,['config','inventory','backend','backendConfig','clients','port']);
 return hash(binding);
}
function checkSecrets(s){
 exact(s,['inventoryKey','tlsKey','tlsCert','tlsCA','backendSecrets']);hex(s.inventoryKey);
 for(const k of ['tlsKey','tlsCert','tlsCA'])assert(typeof s[k]==='string'&&s[k].length>0&&s[k].length<16384);
 assert(s.backendSecrets&&typeof s.backendSecrets==='object'&&!Array.isArray(s.backendSecrets));
}
export function sealSigningVault(secrets,profile,password){
 checkSecrets(secrets);const binding=signingVaultBinding(profile),salt=randomBytes(32),iv=randomBytes(12),key=derive(password,salt),raw=Buffer.from(JSON.stringify(secrets));
 try{assert(raw.length<=MAX);const c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(DOMAIN+':'+binding));const ciphertext=Buffer.concat([c.update(raw),c.final()]).toString('base64');return {domain:DOMAIN,binding,salt:salt.toString('hex'),iv:iv.toString('hex'),tag:c.getAuthTag().toString('hex'),ciphertext};}
 finally{key.fill(0);raw.fill(0);}
}
// Call only within the trusted signer process. Caller owns password zeroing.
export function openSigningVault(bundle,profile,password){
 exact(bundle,['domain','binding','salt','iv','tag','ciphertext']);assert.equal(bundle.domain,DOMAIN);assert.equal(bundle.binding,signingVaultBinding(profile));
 hex(bundle.salt);assert(/^[a-f0-9]{24}$/.test(bundle.iv)&&/^[a-f0-9]{32}$/.test(bundle.tag));
 assert(typeof bundle.ciphertext==='string'&&bundle.ciphertext.length<=Math.ceil(MAX/3)*4);
 const encrypted=Buffer.from(bundle.ciphertext,'base64');assert.equal(encrypted.toString('base64'),bundle.ciphertext);
 const key=derive(password,Buffer.from(bundle.salt,'hex'));let raw;
 try{const d=createDecipheriv('aes-256-gcm',key,Buffer.from(bundle.iv,'hex'));d.setAAD(Buffer.from(DOMAIN+':'+bundle.binding));d.setAuthTag(Buffer.from(bundle.tag,'hex'));raw=Buffer.concat([d.update(encrypted),d.final()]);assert(raw.length<=MAX);const secrets=JSON.parse(raw);checkSecrets(secrets);return secrets;}
 finally{key.fill(0);raw?.fill(0);}
}
