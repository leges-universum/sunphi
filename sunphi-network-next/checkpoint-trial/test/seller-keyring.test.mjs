import test from 'node:test';import assert from 'node:assert/strict';
import {randomBytes,createHash,createECDH} from 'node:crypto';
import {mkdtempSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {prepareSellerKeyring,sellerProfileHash,verifySellerKeyring,withSellerKeys,checkSellerProfile} from '../research/seller-keyring.mjs';
const fixture=()=>{const password=randomBytes(32),binding={chainId:'isolated-custody-test',genesisConfigHash:'7'.repeat(64),seller:randomBytes(32).toString('base64url')};const kit=prepareSellerKeyring(binding,password);return {password,binding,kit,pin:sellerProfileHash(kit.profile)};};

test('short generated scalars retain fixed-width custody and restore the same keys',t=>{
 let scalar=0;const prototype=Object.getPrototypeOf(createECDH('secp256k1'));
 t.mock.method(prototype,'generateKeys',function(){this.setPrivateKey(Buffer.from([++scalar]));return this.getPublicKey();});
 const x=fixture();assert.equal(Buffer.from(x.kit.envelope.ciphertext,'base64').length,64);
 withSellerKeys(x.kit,x.password,x.pin,k=>{for(const [i,name] of ['bitcoin','ethereum'].entries()){const expected=Buffer.alloc(32);expected[31]=i+1;assert.deepEqual(k[name],expected);}});
 assert.equal(scalar,2);
});
test('separate external keys restored; no DUBYT secret and no signing activation',()=>{
 const x=fixture();assert.equal(verifySellerKeyring(x.kit,x.password,x.pin).signingEnabled,false);assert.equal(x.kit.profile.personalKeyIncluded,false);
 let retained;withSellerKeys(x.kit,x.password,x.pin,k=>{retained=k;for(const name of ['bitcoin','ethereum']){const e=createECDH('secp256k1');e.setPrivateKey(k[name]);assert.equal(e.getPublicKey('hex','compressed'),x.kit.profile[name].publicKey);assert(!JSON.stringify(x.kit).includes(k[name].toString('hex')));}});
 assert(retained.bitcoin.equals(Buffer.alloc(32)));assert(retained.ethereum.equals(Buffer.alloc(32)));
 assert.notEqual(x.kit.profile.bitcoin.publicKey,x.kit.profile.ethereum.publicKey);
});
test('profile substitution, alternate chain, enabled signing and secret fields rejected',()=>{
 const x=fixture();for(const mutate of [p=>p.duebyte.seller=randomBytes(32).toString('base64url'),p=>p.duebyte.genesisConfigHash='8'.repeat(64),p=>p.ethereum.network='base-mainnet',p=>p.ethereum.chainId=8453,p=>p.ethereum.usdc='0x'+'0'.repeat(40),p=>p.signingEnabled=true,p=>p.privateKey='bad',p=>p.bitcoin.publicKey=p.ethereum.publicKey]){
  const kit=structuredClone(x.kit);mutate(kit.profile);assert.throws(()=>verifySellerKeyring(kit,x.password,x.pin));assert.throws(()=>verifySellerKeyring(kit,x.password,sellerProfileHash(kit.profile)));
 }
 assert.throws(()=>prepareSellerKeyring({...x.binding,secret:'bad'},x.password));
});
test('wrong password, swapped envelope, corrupt lengths and tampering fail closed',()=>{
 const x=fixture(),y=fixture();assert.throws(()=>verifySellerKeyring(x.kit,randomBytes(32),x.pin));
 for(const patch of [{tag:'0'.repeat(32)},{salt:'f'.repeat(64)},{ciphertext:'a'.repeat(100000)},{iv:'0'.repeat(24)},{unexpected:true},y.kit.envelope])assert.throws(()=>verifySellerKeyring({...x.kit,envelope:{...x.kit.envelope,...patch}},x.password,x.pin));
 assert.throws(()=>prepareSellerKeyring(x.binding,Buffer.alloc(15)));assert.throws(()=>checkSellerProfile({...x.kit.profile,personalKeyIncluded:true}));
});
test('portable copy verifies in fresh offline process without original workspace',()=>{
 const x=fixture(),dir=mkdtempSync(join(tmpdir(),'seller-portable-'));mkdirSync(join(dir,'research'));mkdirSync(join(dir,'qa'));
 copyFileSync(new URL('../research/seller-keyring.mjs',import.meta.url),join(dir,'research/seller-keyring.mjs'));copyFileSync(new URL('../qa/verify-seller-keyring.mjs',import.meta.url),join(dir,'qa/verify-seller-keyring.mjs'));
 const bytes=Buffer.from(JSON.stringify(x.kit)),file=join(dir,'keys.encrypted.json');writeFileSync(file,bytes,{flag:'wx'});
 const args=[join(dir,'qa/verify-seller-keyring.mjs'),file,createHash('sha256').update(bytes).digest('hex'),x.pin];
 const receipt=JSON.parse(execFileSync(process.execPath,args,{cwd:dir,input:x.password,encoding:'utf8',stdio:['pipe','pipe','pipe'],windowsHide:true}));assert(receipt.verified);assert.equal(receipt.signingEnabled,false);
 assert.throws(()=>execFileSync(process.execPath,args,{cwd:dir,input:randomBytes(32),stdio:['pipe','pipe','pipe'],windowsHide:true}));
});
