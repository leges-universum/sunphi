import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createVault,unseal} from './vault.mjs';
import {rewardWalletConsent,walletRewardIdentity,validRewardConsent} from './reward-identity.mjs';
import {SUNPHI_ORIGIN,SUNPHI_APP,validateAccountConsent} from './sunphi-link.mjs';

// Catalog transactions never replace an encrypted key or an existing outbox.
// The original wallet stays at its original path, including its pending payments.
export class WalletStore {
 constructor(home,network){
  this.home=home;this.network=network;mkdirSync(home,{recursive:true});
  this.db=new DatabaseSync(join(home,'wallet-index.sqlite'));
  this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS wallets(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner TEXT UNIQUE); CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  this.db.exec('CREATE TABLE IF NOT EXISTS reward_consents(wallet TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS reward_outbox(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
  this.db.exec('CREATE TABLE IF NOT EXISTS sunphi_links(wallet_id TEXT PRIMARY KEY,body TEXT NOT NULL)');
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
 unlock(id,password){const row=this.get(id),key=unseal(this.vault(id),password);assert(!row.owner||row.owner===key.publicKey,'Wallet identity does not match its saved record.');this.db.prepare('UPDATE wallets SET owner=? WHERE id=?').run(key.publicKey,id);this.select(id);this.acceptRewards(id,key);return key;}
 acceptRewards(id,key){const consent=rewardWalletConsent(this.home,this.network,key);if(!consent)return;this.db.prepare('INSERT OR REPLACE INTO reward_consents VALUES(?,?)').run(key.publicKey,JSON.stringify(consent));if(!this.db.prepare('SELECT 1 FROM preferences WHERE key=?').get('rewardWallets'))this.db.prepare('INSERT INTO preferences VALUES(?,?)').run('rewardWallets',JSON.stringify([id]));}
 rewardWallets(){const row=this.db.prepare('SELECT value FROM preferences WHERE key=?').get('rewardWallets'),selected=row?JSON.parse(row.value):[],identity=walletRewardIdentity(this.home,this.network);return this.list().map(w=>{let consent;try{consent=JSON.parse(this.db.prepare('SELECT body FROM reward_consents WHERE wallet=?').get(w.owner)?.body??'null');}catch{}return {...w,rewardsSelected:selected.includes(w.id),rewardsReady:validRewardConsent(identity,w.owner,consent)};});}
 setRewardWallets(ids){assert(walletRewardIdentity(this.home,this.network),'Node rewards are not configured in this installation.');assert(Array.isArray(ids)&&ids.length>=1&&ids.length<=16&&new Set(ids).size===ids.length,'Choose one or more wallets.');const wallets=this.rewardWallets();for(const id of ids)assert(wallets.some(w=>w.id===id&&w.rewardsReady),'Open this wallet once to enable rewards.');this.db.prepare('INSERT OR REPLACE INTO preferences VALUES(?,?)').run('rewardWallets',JSON.stringify([...ids].sort()));return this.rewardWallets();}
 add(vault,password,name){
  assert(!this.list().some(w=>!w.owner),'Open your original wallet once before adding another. This preserves its identity and pending payments.');
  assert(name===undefined||typeof name==='string','Wallet name must be text.');name=(name??'').trim();assert(name.length<=80&&!/[\x00-\x1f\x7f]/.test(name),'Use a wallet name of up to 80 characters.');
  const key=unseal(vault,password),existing=this.list().find(w=>w.owner===key.publicKey);
  if(existing){this.select(existing.id);this.acceptRewards(existing.id,key);return {id:existing.id,existing:true};}
  const id=randomUUID(),folder=join(this.home,'wallets',id);mkdirSync(folder,{recursive:true});
  writeFileSync(join(folder,'wallet.encrypted.json'),JSON.stringify(vault),{flag:'wx',mode:0o600,flush:true});
  // If interrupted before catalog commit, the extra encrypted file is harmless;
  // all existing records, the selected wallet and their outboxes remain intact.
  this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO wallets VALUES(?,?,?)').run(id,name||`Wallet ${this.list().length+1}`,key.publicKey);this.select(id);this.acceptRewards(id,key);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
  return {id,existing:false};
 }
 create(password,name){return this.add(createVault(password),password,name);}
 restore(backup,password,name){assert(backup?.format==='DueByte encrypted wallet','Select a DueByte encrypted backup.');assert.equal(backup.network,this.network,'Backup belongs to a different network.');return this.add(backup.vault,password,name);}
 backup(id){return {format:'DueByte encrypted wallet',network:this.network,vault:this.vault(id)};}
 sunphiLink(id){this.get(id);const row=this.db.prepare('SELECT body FROM sunphi_links WHERE wallet_id=?').get(id);return row?JSON.parse(row.body):null;}
 // Call only after the configured HTTPS bridge confirms the authenticated account.
 acceptSunPhiLink(id,{request,consent,accountId,linkId},configHash,now){
  const wallet=this.get(id),body=validateAccountConsent(consent,request,accountId,configHash,now);
  assert.equal(body.network,this.network);assert.equal(body.wallet,wallet.owner,'selected wallet changed');assert(typeof linkId==='string'&&/^[a-f0-9-]{36}$/.test(linkId),'link identifier');
  const existing=this.sunphiLink(id);if(existing?.status==='linked'){assert.equal(existing.linkId,linkId,'disconnect the existing account first');assert.equal(existing.accountId,accountId);return existing;}
  const link={origin:SUNPHI_ORIGIN,app:SUNPHI_APP,status:'linked',linkId,accountId,wallet:wallet.owner,network:this.network,notifications:false,consent};
  this.db.prepare('INSERT OR REPLACE INTO sunphi_links VALUES(?,?)').run(id,JSON.stringify(link));return link;
 }
 setSunPhiNotifications(id,enabled){assert(typeof enabled==='boolean');const link=this.sunphiLink(id);assert(link?.status==='linked','Connect your Sun·Phi account first.');link.notifications=enabled;this.db.prepare('UPDATE sunphi_links SET body=? WHERE wallet_id=?').run(JSON.stringify(link),id);return link;}
 revokeSunPhiLink(id){const link=this.sunphiLink(id);if(!link)return;link.status='revoked';link.notifications=false;this.db.prepare('UPDATE sunphi_links SET body=? WHERE wallet_id=?').run(JSON.stringify(link),id);}
 close(){this.db.close();}
}
