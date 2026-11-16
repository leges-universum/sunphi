// Operator-only backup transport; no protocol, wallet or issuance mutation.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomBytes,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Writable,Transform} from 'node:stream';
import {spawnSync} from 'node:child_process';
const magic=Buffer.from('DBBACK01');
export function protectKey(bytes,unprotect=false){
 const method=unprotect?'Unprotect':'Protect';
 const script=`Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${method}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))`;
 const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{input:bytes.toString('base64'),encoding:'utf8',windowsHide:true});
 assert.equal(r.status,0,'Windows protected-key operation failed');return Buffer.from(r.stdout.trim(),'base64');
}
export function backupKey(directory){
 assert(process.platform==='win32');const file=directory+'/backup-key.dpapi';
 if(!fs.existsSync(file)){const key=randomBytes(32);try{fs.writeFileSync(file,protectKey(key),{flag:'wx'});}finally{key.fill(0);}}
 const fd=fs.openSync(file,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const key=protectKey(fs.readFileSync(file),true);assert.equal(key.length,32);return key;
}
export async function encryptArchive(input,file,key){
 const header=Buffer.concat([magic,randomBytes(12)]),cipher=createCipheriv('aes-256-gcm',key,header.subarray(8));cipher.setAAD(header);
 const pending=file+'.partial';assert(!fs.existsSync(file)&&!fs.existsSync(pending));
 const fd=fs.openSync(pending,'wx',0o600);fs.writeSync(fd,header);const hash=createHash('sha256');let bytes=0;
 const meter=new Transform({transform(b,e,cb){bytes+=b.length;hash.update(b);cb(null,b);}});
 try{await pipeline(input,meter,cipher,fs.createWriteStream(pending,{fd,start:header.length,autoClose:false}));fs.writeSync(fd,cipher.getAuthTag(),0,16,fs.fstatSync(fd).size);fs.fsyncSync(fd);fs.closeSync(fd);fs.renameSync(pending,file);return {compressedBytes:bytes,compressedSha256:hash.digest('hex'),encryptedBytes:fs.statSync(file).size};}
 catch(e){try{fs.closeSync(fd);}catch{}throw e;}
}
export async function decryptArchive(file,key,output=new Writable({write(b,e,cb){cb();}})){
 const fd=fs.openSync(file,'r'),size=fs.fstatSync(fd).size,header=Buffer.alloc(20),tag=Buffer.alloc(16);
 try{assert(size>36,'truncated backup');fs.readSync(fd,header,0,20,0);assert(header.subarray(0,8).equals(magic),'backup format');fs.readSync(fd,tag,0,16,size-16);}finally{fs.closeSync(fd);}
 const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(8));decipher.setAAD(header);decipher.setAuthTag(tag);const hash=createHash('sha256');let bytes=0;
 const meter=new Transform({transform(b,e,cb){bytes+=b.length;hash.update(b);cb(null,b);}});
 await pipeline(fs.createReadStream(file,{start:20,end:size-17}),decipher,meter,output);return {compressedBytes:bytes,compressedSha256:hash.digest('hex')};
}
