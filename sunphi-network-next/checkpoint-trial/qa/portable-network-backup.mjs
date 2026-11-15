// Offline portable key envelope. No Windows account or network is required.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,scryptSync,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
import {decryptArchive} from './backup-stream-20261108.mjs';
const domain='DUEBYTE_NETWORK_BACKUP_RECOVERY_V1';
const kdf={name:'scrypt',N:65536,r:8,p:1};
function passwordCheck(password){assert(typeof password==='string'&&password.length>=16&&Buffer.byteLength(password)<=4096,'Password must contain at least 16 characters');}
function fields(value,keys){assert(value&&typeof value==='object'&&!Array.isArray(value));assert.deepEqual(Object.keys(value).sort(),keys.sort());}
function b64(value,size){assert(typeof value==='string');const b=Buffer.from(value,'base64');assert.equal(b.length,size);assert.equal(b.toString('base64'),value);return b;}
export function validateManifest(manifest){
 fields(manifest,['setId','archives']);assert(/^[a-f0-9]{32}$/.test(manifest.setId));
 assert(Array.isArray(manifest.archives)&&manifest.archives.length>0&&manifest.archives.length<=32);
 const names=new Set();for(const a of manifest.archives){fields(a,['name','bytes','sha256','compressedSha256']);assert(/^(node[0-9]+|host[0-9]+-support)\.tar\.(gz|zst)\.enc$/.test(a.name));assert(!names.has(a.name));names.add(a.name);assert(Number.isSafeInteger(a.bytes)&&a.bytes>36);assert(/^[a-f0-9]{64}$/.test(a.sha256)&&/^[a-f0-9]{64}$/.test(a.compressedSha256));}
 return manifest;
}
export function sealBackupKey(key,password,manifest){
 passwordCheck(password);assert(Buffer.isBuffer(key)&&key.length===32);validateManifest(manifest);
 const salt=randomBytes(32),iv=randomBytes(12),header={domain,kdf,manifest};
 const derived=scryptSync(password,salt,32,{...kdf,maxmem:128*1048576});
 try{const c=createCipheriv('aes-256-gcm',derived,iv);c.setAAD(Buffer.from(JSON.stringify(header)));const ciphertext=Buffer.concat([c.update(key),c.final()]);return {...header,salt:salt.toString('base64'),iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};}finally{derived.fill(0);}
}
export function openBackupKey(envelope,password){
 passwordCheck(password);fields(envelope,['domain','kdf','manifest','salt','iv','tag','ciphertext']);assert.equal(envelope.domain,domain);assert.deepEqual(envelope.kdf,kdf);validateManifest(envelope.manifest);
 const salt=b64(envelope.salt,32),iv=b64(envelope.iv,12),tag=b64(envelope.tag,16),ciphertext=b64(envelope.ciphertext,32);
 const derived=scryptSync(password,salt,32,{...kdf,maxmem:128*1048576});let clear;
 try{const d=createDecipheriv('aes-256-gcm',derived,iv);d.setAAD(Buffer.from(JSON.stringify({domain:envelope.domain,kdf:envelope.kdf,manifest:envelope.manifest})));d.setAuthTag(tag);clear=d.update(ciphertext);d.final();assert.equal(clear.length,32);return clear;}catch(e){clear?.fill(0);throw e;}finally{derived.fill(0);}
}
export async function digestFile(file){const h=createHash('sha256');for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest('hex');}
export async function verifyPortableSet(directory,password,onVerified=()=>{}){
 const file=path.join(directory,'recovery-key.encrypted.json');assert(fs.statSync(file).size<=65536);const envelope=JSON.parse(fs.readFileSync(file,'utf8')),key=openBackupKey(envelope,password);
 try{for(const a of envelope.manifest.archives){const archive=path.join(directory,a.name),stat=fs.lstatSync(archive);assert(stat.isFile()&&!stat.isSymbolicLink());assert.equal(stat.size,a.bytes);assert.equal(await digestFile(archive),a.sha256,'Encrypted archive hash mismatch');const result=await decryptArchive(archive,key);assert.equal(result.compressedSha256,a.compressedSha256,'Authenticated archive mismatch');onVerified(a.name);}return {verified:true,setId:envelope.manifest.setId,archives:envelope.manifest.archives.length,windowsAccountRequired:false,networkAccess:false,issuance:false};}finally{key.fill(0);}
}
export async function recoverPortableArchive(directory,password,name,destination){
 const envelopeFile=path.join(directory,'recovery-key.encrypted.json');assert(fs.statSync(envelopeFile).size<=65536);const envelope=JSON.parse(fs.readFileSync(envelopeFile,'utf8')),key=openBackupKey(envelope,password);let pending;
 try{
  const entry=envelope.manifest.archives.find(a=>a.name===name);assert(entry,'Archive not in authenticated manifest');const archive=path.join(directory,name),stat=fs.lstatSync(archive);assert(stat.isFile()&&!stat.isSymbolicLink());assert.equal(stat.size,entry.bytes);assert.equal(await digestFile(archive),entry.sha256);
  // Authentication finishes before any plaintext output is opened.
  assert.equal((await decryptArchive(archive,key)).compressedSha256,entry.compressedSha256);
  assert(!fs.existsSync(destination),'Never overwrite a recovery output');pending=destination+'.'+randomUUID()+'.partial';
  const result=await decryptArchive(archive,key,fs.createWriteStream(pending,{flags:'wx',mode:0o600}));assert.equal(result.compressedSha256,entry.compressedSha256);
  const fd=fs.openSync(pending,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  // Exclusive link avoids a rename overwriting a concurrently created destination.
  fs.linkSync(pending,destination);fs.unlinkSync(pending);pending=undefined;
  return {recovered:true,archive:name,compressedBytes:result.compressedBytes,servicesStarted:false,issuance:false};
 }finally{key.fill(0);if(pending&&fs.existsSync(pending))fs.unlinkSync(pending);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)){
 try{const [directory,name,destination]=process.argv.slice(2);assert(directory,'Supply backup directory; password is read from stdin');let password=fs.readFileSync(0,'utf8');assert((!name&&!destination)||(name&&destination));const result=name?await recoverPortableArchive(path.resolve(directory),password,name,path.resolve(destination)):await verifyPortableSet(path.resolve(directory),password);password='';console.log(JSON.stringify(result));}catch{console.error('Recovery failed. Check password, complete backup set, integrity and unused output path.');process.exitCode=1;}
}
