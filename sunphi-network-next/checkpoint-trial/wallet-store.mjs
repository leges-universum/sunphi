import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createVault,unseal} from './vault.mjs';

// Catalog transactions never replace an encrypted key or an existing outbox.
// The original wallet stays at its original path, including its pending payments.
export class WalletStore {
 constructor(home,network){
  this.home=home;this.network=network;mkdirSync(home,{recursive:true});
  this.db=new DatabaseSync(join(home,'wallet-index.sqlite'));
  this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS wallets(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner TEXT UNIQUE); CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  if(existsSync(join(home,'wallet.encrypted.json'))&&!this.db.prepare('SELECT 1 FROM wallets WHERE id=?').get('legacy')){
   this.db.prepare('INSERT INTO wallets VALUES(?,?,NULL)').run('legacy','My DueByte wallet');
  }
 }
 list(){return this.db.prepare('SELECT id,name,owner FROM wallets ORDER BY rowid').all();}
 selected(){const id=this.db.prepare('SELECT value FROM preferences WHERE key=?').get('selected')?.value;return this.list().find(w=>w.id===id)??this.list()[0]??null;}
 get(id){assert(typeof id==='string','Select a saved wallet.');const row=this.db.prepare('SELECT id,name,owner FROM wallets WHERE id=?').get(id);assert(row,'Wallet not found.');return row;}
 directory(id){this.get(id);assert(id==='legacy'||/^[a-f0-9-]{36}$/.test(id),'Invalid wallet identifier.');return id==='legacy'?this.home:join(this.home,'wallets',id);}
 select(id){this.get(id);this.db.prepare('INSERT OR REPLACE INTO preferences VALUES(?,?)').run('selected',id);return this.get(id);}
 vault(id){return JSON.parse(readFileSync(join(this.directory(id),'wallet.encrypted.json'),'utf8'));}
 unlock(id,password){const row=this.get(id),key=unseal(this.vault(id),password);assert(!row.owner||row.owner===key.publicKey,'Wallet identity does not match its saved record.');this.db.prepare('UPDATE wallets SET owner=? WHERE id=?').run(key.publicKey,id);this.select(id);return key;}
 add(vault,password,name){
  assert(!this.list().some(w=>!w.owner),'Open your original wallet once before adding another. This preserves its identity and pending payments.');
  assert(name===undefined||typeof name==='string','Wallet name must be text.');name=(name??'').trim();assert(name.length<=80&&!/[\x00-\x1f\x7f]/.test(name),'Use a wallet name of up to 80 characters.');
  const key=unseal(vault,password),existing=this.list().find(w=>w.owner===key.publicKey);
  if(existing){this.select(existing.id);return {id:existing.id,existing:true};}
  const id=randomUUID(),folder=join(this.home,'wallets',id);mkdirSync(folder,{recursive:true});
  writeFileSync(join(folder,'wallet.encrypted.json'),JSON.stringify(vault),{flag:'wx',mode:0o600,flush:true});
  // If interrupted before catalog commit, the extra encrypted file is harmless;
  // all existing records, the selected wallet and their outboxes remain intact.
  this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO wallets VALUES(?,?,?)').run(id,name||`Wallet ${this.list().length+1}`,key.publicKey);this.select(id);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
  return {id,existing:false};
 }
 create(password,name){return this.add(createVault(password),password,name);}
 restore(backup,password,name){assert(backup?.format==='DueByte encrypted wallet','Select a DueByte encrypted backup.');assert.equal(backup.network,this.network,'Backup belongs to a different network.');return this.add(backup.vault,password,name);}
 backup(id){return {format:'DueByte encrypted wallet',network:this.network,vault:this.vault(id)};}
 close(){this.db.close();}
}
