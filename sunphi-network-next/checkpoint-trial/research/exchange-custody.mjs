// Offline external-key recovery preparation. The personal DUBYT key is never
// included. Restoring this bundle cannot activate an external signing service.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createECDH,randomBytes,scryptSync,createCipheriv,createDecipheriv} from 'node:crypto';
import {hash,hex,exact,publicKey,digest} from '../crypto.mjs';
import {ExchangeRecovery} from './exchange-recovery.mjs';
import {ETHEREUM_GENESIS,ETHEREUM_USDC} from './exchange-evm-networks.mjs';
import {generateExternalPrivateKey} from './seller-keyring.mjs';
const DOMAIN='DUEBYTE_EXCHANGE_EXTERNAL_CUSTODY_V1',MAX=48*1024*1024;
const ETH_DOMAIN='DUEBYTE_EXCHANGE_EXTERNAL_CUSTODY_V2';
const domain=profile=>profile.domain===ETH_DOMAIN+'/PROFILE'?ETH_DOMAIN:DOMAIN;
const evmKey=profile=>domain(profile)===ETH_DOMAIN?'ethereum':'base';
const derive=(password,salt)=>{assert(typeof password==='string'&&password.length>=16&&password.length<=1024,'backup password length');return scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});};
export function externalPublicKey(secret){assert(Buffer.isBuffer(secret)&&secret.length===32);const e=createECDH('secp256k1');e.setPrivateKey(secret);return e.getPublicKey('hex','compressed');}
// The ceremony returns encrypted material only. It must not install a signer,
// replace the personal DUBYT identity or invent an operational route/config.
export function prepareEthereumCustody(worker,password){
 const config=worker.config,route=config.exchangeLab?.policy?.routes?.USDC,seller=config.exchangeLab?.policy?.provider;
 assert.deepEqual(route,{network:'ethereum-mainnet',genesis:ETHEREUM_GENESIS,contract:ETHEREUM_USDC,decimals:6});publicKey(seller);
 assert.equal(worker.restored,false,'restored journal cannot create replacement custody');
 assert.equal(worker.snapshot().jobs.length,0,'initial key ceremony requires an empty recovery journal');
 const secrets={};
 try{
  for(const field of ['bitcoin','ethereum'])secrets[field]=generateExternalPrivateKey();
  const profile={domain:ETH_DOMAIN+'/PROFILE',configHash:hash(config),seller,bitcoinPublicKey:externalPublicKey(secrets.bitcoin),ethereumPublicKey:externalPublicKey(secrets.ethereum),network:route.network,genesis:route.genesis,contract:route.contract};
  const bundle=sealExternalCustody(worker,profile,secrets,password);
  return {profile,bundle,signingEnabled:false,personalKeyIncluded:false};
 }finally{for(const key of Object.values(secrets))key.fill(0);}
}
export function checkExternalCustodyProfile(profile,config){
 const field=evmKey(profile)+'PublicKey',v2=domain(profile)===ETH_DOMAIN;
 exact(profile,['domain','configHash','seller','bitcoinPublicKey',field,...(v2?['network','genesis','contract']:[])]);assert.equal(profile.domain,domain(profile)+'/PROFILE');assert.equal(profile.configHash,hash(config));publicKey(profile.seller);
 if(v2){assert.equal(profile.network,'ethereum-mainnet');assert.equal(profile.genesis,ETHEREUM_GENESIS);assert.equal(profile.contract,ETHEREUM_USDC);assert.deepEqual(config.exchangeLab?.policy?.routes?.USDC,{network:profile.network,genesis:profile.genesis,contract:profile.contract,decimals:6});}
 assert.equal(profile.seller,config.exchangeLab?.policy?.provider,'seller identity mismatch');
 for(const name of ['bitcoinPublicKey',field])assert(/^(02|03)[a-f0-9]{64}$/.test(profile[name]));
 assert.notEqual(profile.bitcoinPublicKey,profile[field],'separate external keys required');return hash(profile);
}
function validate(payload,profile,config){
 const field=evmKey(profile);exact(payload,['domain','profile','snapshot','bitcoin',field]);assert.equal(payload.domain,domain(profile));assert.deepEqual(payload.profile,profile);checkExternalCustodyProfile(profile,config);
 let bitcoin,base,check;try{
  for(const name of ['bitcoin',field])assert(typeof payload[name]==='string'&&/^[a-f0-9]{64}$/.test(payload[name]),'private key encoding');
  bitcoin=Buffer.from(payload.bitcoin,'hex');base=Buffer.from(payload[field],'hex');assert.equal(externalPublicKey(bitcoin),profile.bitcoinPublicKey);assert.equal(externalPublicKey(base),profile[field+'PublicKey']);
  check=new ExchangeRecovery(':memory:',{config,key:randomBytes(32)});check.restoreSnapshot(payload.snapshot);
 }finally{bitcoin?.fill(0);base?.fill(0);check?.close();}
}
export function sealExternalCustody(worker,profile,secrets,password){
 const field=evmKey(profile),version=domain(profile);exact(secrets,['bitcoin',field]);const bitcoin=secrets.bitcoin,base=secrets[field];
 const profileHash=checkExternalCustodyProfile(profile,worker.config),snapshot=worker.snapshot();
 assert.equal(externalPublicKey(bitcoin),profile.bitcoinPublicKey);assert.equal(externalPublicKey(base),profile[field+'PublicKey']);
 const payload={domain:version,profile,snapshot,bitcoin:bitcoin.toString('hex'),[field]:base.toString('hex')};validate(payload,profile,worker.config);
 const raw=Buffer.from(JSON.stringify(payload));assert(raw.length<=MAX);const salt=randomBytes(32),iv=randomBytes(12),key=derive(password,salt),checkpoint=hash(snapshot);
 try{const c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(JSON.stringify([version,profileHash,checkpoint])));const data=Buffer.concat([c.update(raw),c.final()]);return {domain:version,profileHash,checkpoint,salt:salt.toString('hex'),iv:iv.toString('hex'),tag:c.getAuthTag().toString('hex'),ciphertext:data.toString('base64')};}
 finally{key.fill(0);raw.fill(0);payload.bitcoin='';payload[field]='';}
}
// expectedCheckpoint must come from an independently retained inventory, not
// from the offered bundle. A matching old inventory still cannot prove freshness.
// Validate keys, then discard plaintext; only the restricted journal is restored.
// Operational key installation/nonce reconciliation is a separate future gate.
export function restoreExternalCustody(bundle,{profile,config,password,expectedCheckpoint,file,journalKey}){
 const field=evmKey(profile),version=domain(profile);
 exact(bundle,['domain','profileHash','checkpoint','salt','iv','tag','ciphertext']);assert.equal(bundle.domain,version);assert.equal(bundle.profileHash,checkExternalCustodyProfile(profile,config));hex(expectedCheckpoint);assert.equal(bundle.checkpoint,expectedCheckpoint,'custody checkpoint mismatch');
 assert(/^[a-f0-9]{64}$/.test(bundle.salt)&&/^[a-f0-9]{24}$/.test(bundle.iv)&&/^[a-f0-9]{32}$/.test(bundle.tag));assert(typeof bundle.ciphertext==='string'&&bundle.ciphertext.length<=Math.ceil(MAX/3)*4);assert(Buffer.isBuffer(journalKey)&&journalKey.length===32);
 const data=Buffer.from(bundle.ciphertext,'base64');assert.equal(data.toString('base64'),bundle.ciphertext);const key=derive(password,Buffer.from(bundle.salt,'hex'));let raw,payload,worker;
 try{
  const d=createDecipheriv('aes-256-gcm',key,Buffer.from(bundle.iv,'hex'));d.setAAD(Buffer.from(JSON.stringify([version,bundle.profileHash,bundle.checkpoint])));d.setAuthTag(Buffer.from(bundle.tag,'hex'));raw=Buffer.concat([d.update(data),d.final()]);assert(raw.length<=MAX);payload=JSON.parse(raw);
  validate(payload,profile,config);assert.equal(hash(payload.snapshot),expectedCheckpoint);
  const fd=fs.openSync(file,'wx',0o600);fs.closeSync(fd);worker=new ExchangeRecovery(file,{config,key:journalKey});worker.restoreSnapshot(payload.snapshot);
  return {worker,signingEnabled:false,publicKeys:{bitcoin:profile.bitcoinPublicKey,[field]:profile[field+'PublicKey']},checkpoint:expectedCheckpoint};
 }catch(e){worker?.close();throw e;}finally{key.fill(0);raw?.fill(0);if(payload){payload.bitcoin='';payload[field]='';}}
}
export function writeExternalCustody(file,bundle){const bytes=Buffer.from(JSON.stringify(bundle));assert(bytes.length<=MAX*1.4);const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return {sha256:digest(bytes),bytes:bytes.length};}
