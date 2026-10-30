import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync } from 'node:fs';
import { canonical, exact } from './protocol.mjs';
import { lockController } from './controller-lock.mjs';

const DOMAIN='sunphi-isolated-private-vault-v1', MAX=16*1024*1024;
const hex=(s,n)=>typeof s==='string'&&s.length===n&&/^[0-9a-f]+$/.test(s);
function derive(password,salt){
 if(typeof password!=='string'||password.length<12||password.length>1024)throw new Error('vault password must contain 12–1024 characters');
 return scryptSync(password,Buffer.from(salt,'hex'),32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
}
function seal(value,key,salt){
 const plain=Buffer.from(canonical(value));
 try{
  if(plain.length>MAX)throw new Error('private vault size limit');
  const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(DOMAIN+salt));
  const ciphertext=Buffer.concat([c.update(plain),c.final()]);
  return {version:1,salt,iv:iv.toString('hex'),tag:c.getAuthTag().toString('hex'),ciphertext:ciphertext.toString('hex')};
 }finally{plain.fill(0);}
}
function shape(b){
 exact(b,['version','salt','iv','tag','ciphertext']);
 if(b.version!==1||!hex(b.salt,32)||!hex(b.iv,24)||!hex(b.tag,32)||typeof b.ciphertext!=='string'||b.ciphertext.length>MAX*2||b.ciphertext.length%2||!hex(b.ciphertext,b.ciphertext.length))throw new Error('invalid private vault envelope');
}
function unseal(b,key){
 shape(b);const d=createDecipheriv('aes-256-gcm',key,Buffer.from(b.iv,'hex'));d.setAAD(Buffer.from(DOMAIN+b.salt));d.setAuthTag(Buffer.from(b.tag,'hex'));
 const chunks=[];let plain;
 try{chunks.push(d.update(Buffer.from(b.ciphertext,'hex')));chunks.push(d.final());plain=Buffer.concat(chunks);return JSON.parse(plain.toString());}
 catch{throw new Error('private vault decryption or decoding failed');}
 finally{plain?.fill(0);for(const chunk of chunks)chunk.fill(0);}
}
export function encryptPrivateBackup(value,password){
 const salt=randomBytes(16).toString('hex'),key=derive(password,salt);
 try{return seal(value,key,salt);}finally{key.fill(0);}
}
export function decryptPrivateBackup(backup,password){
 shape(backup);const key=derive(password,backup.salt);
 try{return unseal(backup,key);}finally{key.fill(0);}
}

// The SQLite file, WAL and backups contain ciphertext only. This is a local
// secret container, NEVER an authority for balances or history freshness.
export class PrivateVault{
 #db;#unlock;#key;#salt;#revision;#version;#closed=false;
 static create(path,password,value){
  if(existsSync(path))throw new Error('private vault already exists');
  const unlock=lockController([path]);let db,key;
  try{
   if(existsSync(path))throw new Error('private vault already exists');
   const salt=randomBytes(16).toString('hex');key=derive(password,salt);const blob=canonical(seal(value,key,salt));
   db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE private_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,blob TEXT NOT NULL);');
   db.prepare('INSERT INTO private_state VALUES(1,0,?)').run(blob);return PrivateVault.#attach(db,unlock,key,salt,0);
  }catch(e){db?.close();key?.fill(0);unlock();throw e;}
 }
 static open(path,password){
  if(!existsSync(path))throw new Error('private vault missing');
  const unlock=lockController([path]);let db,key;
  try{
   db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
   const row=db.prepare('SELECT revision,blob FROM private_state WHERE id=1').get();if(!row||row.blob.length>MAX*2+1024)throw new Error('invalid private vault');
   const b=JSON.parse(row.blob);shape(b);key=derive(password,b.salt);unseal(b,key);
   return PrivateVault.#attach(db,unlock,key,b.salt,row.revision);
  }catch(e){db?.close();key?.fill(0);unlock();throw e;}
 }
 static #attach(db,unlock,key,salt,revision){const v=new PrivateVault();v.#db=db;v.#unlock=unlock;v.#key=key;v.#salt=salt;v.#revision=revision;v.#version=db.prepare('PRAGMA data_version').get().data_version;return v;}
 guard(){if(this.#closed||this.#db.prepare('PRAGMA data_version').get().data_version!==this.#version)throw new Error('private vault closed or externally modified');}
 read(){this.guard();const row=this.#db.prepare('SELECT revision,blob FROM private_state WHERE id=1').get();if(row.revision!==this.#revision||row.blob.length>MAX*2+1024)throw new Error('private vault revision mismatch');return unseal(JSON.parse(row.blob),this.#key);}
 write(value,crash=()=>{}){
  this.guard();const blob=canonical(seal(value,this.#key,this.#salt));
  this.#db.exec('BEGIN IMMEDIATE');
  try{
   this.guard();const result=this.#db.prepare('UPDATE private_state SET revision=revision+1,blob=? WHERE id=1 AND revision=?').run(blob,this.#revision);
   if(result.changes!==1)throw new Error('private vault revision mismatch');
   crash('beforeCommit');this.#db.exec('COMMIT');this.#revision++;crash('afterCommit');
  }catch(e){try{this.#db.exec('ROLLBACK');}catch{}throw e;}
 }
 close(){if(this.#closed)return;this.#closed=true;this.#key.fill(0);try{this.#db.close();}finally{this.#unlock();}}
}
