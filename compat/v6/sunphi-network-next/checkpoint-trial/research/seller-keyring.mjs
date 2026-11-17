// Initial seller custody, independent of disposable exchange journals.
// This file is also shipped in the offline recovery kit; built-ins only.
// A custody profile is NOT a runnable signing-daemon configuration.
import assert from 'node:assert/strict';
import {createECDH, createHash, randomBytes, scryptSync, createCipheriv, createDecipheriv} from 'node:crypto';
const DOMAIN='DUEBYTE_SELLER_KEYRING_V1';
const exact=(v,fields)=>{assert(v&&Object.getPrototypeOf(v)===Object.prototype);assert.deepEqual(Object.keys(v).sort(),fields.slice().sort());};
const hex=(v,n)=>assert(typeof v==='string'&&new RegExp('^[a-f0-9]{'+n+'}$').test(v));
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
export const sellerProfileHash=p=>createHash('sha256').update(canonical(p)).digest('hex');
function pub(key){const e=createECDH('secp256k1');e.setPrivateKey(key);return e.getPublicKey('hex','compressed');}
function binding(b){
 exact(b,['chainId','genesisConfigHash','seller']);
 assert(typeof b.chainId==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(b.chainId));hex(b.genesisConfigHash,64);
 assert(typeof b.seller==='string'&&/^[A-Za-z0-9_-]{43}$/.test(b.seller)&&Buffer.from(b.seller,'base64url').toString('base64url')===b.seller);
}
export function checkSellerProfile(p){
 exact(p,['domain','identity','duebyte','bitcoin','ethereum','signingEnabled','personalKeyIncluded']);
 assert.equal(p.domain,DOMAIN+'/PROFILE');hex(p.identity,64);binding(p.duebyte);
 exact(p.bitcoin,['network','genesis','publicKey']);exact(p.ethereum,['network','chainId','genesis','usdc','decimals','publicKey']);
 assert.equal(p.bitcoin.network,'bitcoin-mainnet');assert.equal(p.bitcoin.genesis,'000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
 assert.equal(p.ethereum.network,'ethereum-mainnet');assert.equal(p.ethereum.chainId,1);
 assert.equal(p.ethereum.genesis,'d4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3');
 assert.equal(p.ethereum.usdc,'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');assert.equal(p.ethereum.decimals,6);
 for(const v of [p.bitcoin.publicKey,p.ethereum.publicKey]){assert(/^(02|03)[a-f0-9]{64}$/.test(v));createECDH('secp256k1').setPublicKey(Buffer.from(v,'hex'));}
 assert.notEqual(p.bitcoin.publicKey,p.ethereum.publicKey);assert.equal(p.signingEnabled,false);assert.equal(p.personalKeyIncluded,false);
 return sellerProfileHash(p);
}
function derive(password,salt){assert(Buffer.isBuffer(password)&&password.length>=16&&password.length<=4096);return scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});}
export function prepareSellerKeyring(duebyte,password){
 binding(duebyte);const bitcoin=createECDH('secp256k1'),ethereum=createECDH('secp256k1');bitcoin.generateKeys();ethereum.generateKeys();
 const a=bitcoin.getPrivateKey(),b=ethereum.getPrivateKey();let raw,key;
 try{
  const profile={domain:DOMAIN+'/PROFILE',identity:randomBytes(32).toString('hex'),duebyte:structuredClone(duebyte),bitcoin:{network:'bitcoin-mainnet',genesis:'000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',publicKey:pub(a)},ethereum:{network:'ethereum-mainnet',chainId:1,genesis:'d4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3',usdc:'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',decimals:6,publicKey:pub(b)},signingEnabled:false,personalKeyIncluded:false};
  const profileHash=checkSellerProfile(profile),salt=randomBytes(32),iv=randomBytes(12);
  // Fixed-size binary payload avoids plaintext private-key strings.
  raw=Buffer.concat([a,b]);key=derive(password,salt);const c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(DOMAIN+':'+profileHash));
  const data=Buffer.concat([c.update(raw),c.final()]);
  return {profile,envelope:{domain:DOMAIN,profileHash,salt:salt.toString('hex'),iv:iv.toString('hex'),tag:c.getAuthTag().toString('hex'),ciphertext:data.toString('base64')}};
 }finally{a.fill(0);b.fill(0);raw?.fill(0);key?.fill(0);}
}
// Trusted offline custody tooling only. Never expose this capability through API.
// An unlocked keyring still does not bypass daemon admission or nonce fencing.
export function withSellerKeys(kit,password,expectedProfileHash,consume){
 exact(kit,['profile','envelope']);hex(expectedProfileHash,64);assert.equal(checkSellerProfile(kit.profile),expectedProfileHash);
 const e=kit.envelope;exact(e,['domain','profileHash','salt','iv','tag','ciphertext']);assert.equal(e.domain,DOMAIN);assert.equal(e.profileHash,expectedProfileHash);
 hex(e.salt,64);hex(e.iv,24);hex(e.tag,32);assert(typeof e.ciphertext==='string'&&e.ciphertext.length===88);
 const data=Buffer.from(e.ciphertext,'base64');assert.equal(data.length,64);assert.equal(data.toString('base64'),e.ciphertext);
 let raw,key;try{
  key=derive(password,Buffer.from(e.salt,'hex'));const d=createDecipheriv('aes-256-gcm',key,Buffer.from(e.iv,'hex'));d.setAAD(Buffer.from(DOMAIN+':'+e.profileHash));d.setAuthTag(Buffer.from(e.tag,'hex'));raw=Buffer.concat([d.update(data),d.final()]);
  assert.equal(raw.length,64);assert.equal(pub(raw.subarray(0,32)),kit.profile.bitcoin.publicKey);assert.equal(pub(raw.subarray(32)),kit.profile.ethereum.publicKey);
  const result=consume({bitcoin:raw.subarray(0,32),ethereum:raw.subarray(32)});assert(!result||typeof result.then!=='function','synchronous custody consumer required');return result;
 }finally{raw?.fill(0);key?.fill(0);}
}
export function verifySellerKeyring(kit,password,expectedProfileHash){
 return withSellerKeys(kit,password,expectedProfileHash,()=>({verified:true,profileHash:expectedProfileHash,seller:kit.profile.duebyte.seller,signingEnabled:false,personalKeyIncluded:false}));
}
