// Pinned custody policy and durable authorizations. Isolated admission only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {exact,hash,hex,integer} from '../crypto.mjs';
import {isolatedPurchaseConfig,refundAddress} from './purchase-api.mjs';
import {SellerSigner} from './purchase-seller-signer.mjs';

export const SELLER_PROFILE='DUEBYTE_PROTECTED_SELLER_V1';
export const PERSONAL_SELLER_PROFILE='DUEBYTE_PERSONAL_SELLER_V2';
export function validateSellerProfile(p){
 const personal=p?.domain===PERSONAL_SELLER_PROFILE;
 exact(p,['domain','operator','config','settings','vaultHash','btcDestinations','dailyLimitMicro',...(personal?['vaultKind']:[])]);
 assert(personal||p.domain===SELLER_PROFILE);if(personal)assert.equal(p.vaultKind,'personal-wallet');assert(typeof p.operator==='string'&&p.operator.length>0&&p.operator.length<=160);
 isolatedPurchaseConfig(p.config);hex(p.vaultHash);
 assert(typeof p.dailyLimitMicro==='string'&&/^[1-9][0-9]{0,17}$/.test(p.dailyLimitMicro));
 assert(Array.isArray(p.btcDestinations)&&p.btcDestinations.length>0&&p.btcDestinations.length<=64);
 assert.equal(new Set(p.btcDestinations).size,p.btcDestinations.length);
 p.btcDestinations.forEach(a=>assert.equal(refundAddress('BTC',a),a));
 assert(BigInt(p.dailyLimitMicro)>=BigInt(p.settings.maxOrderMicro));return hash(p);
}
// Provision once, offline. Runtime MUST NOT create a missing journal.
export function initializeSellerJournal(file,profile){
 const pin=validateSellerProfile(profile),fd=fs.openSync(file,'wx',0o600);fs.closeSync(fd);
 const db=new DatabaseSync(file);
 try{db.exec('PRAGMA synchronous=FULL; BEGIN EXCLUSIVE; CREATE TABLE meta(pin TEXT NOT NULL,lastTime INTEGER NOT NULL); CREATE TABLE quotes(id TEXT PRIMARY KEY,request TEXT NOT NULL,destination TEXT UNIQUE NOT NULL,quote TEXT NOT NULL); CREATE TABLE permits(id TEXT PRIMARY KEY,request TEXT NOT NULL,day INTEGER NOT NULL,amount TEXT NOT NULL,wire TEXT NOT NULL);');
  db.prepare('INSERT INTO meta VALUES(?,0)').run(pin);db.exec('COMMIT');
 }finally{db.close();}
}
export class ProtectedSellerSigner {
 #signer; #profile; #db;
 constructor({profile,bundle,password,journal,key}){
  const pin=validateSellerProfile(profile);assert.equal(hash(bundle),profile.vaultHash,'vault pin mismatch');
  assert(fs.lstatSync(journal).isFile()&&!fs.lstatSync(journal).isSymbolicLink(),'existing journal required');
  try{
   this.#db=new DatabaseSync(journal);this.#db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
   const rows=this.#db.prepare('SELECT * FROM meta').all();assert.equal(rows.length,1);assert.equal(rows[0].pin,pin,'profile changed; reconciliation required');
   this.#db.exec('COMMIT');this.#profile=structuredClone(profile);
   this.#signer=new SellerSigner({config:profile.config,settings:profile.settings,btcDestinations:profile.btcDestinations,bundle,password,key,vaultKind:profile.vaultKind??'purchase-custody'});
  }catch(e){this.#db?.close();throw e;}
 }
 #transaction(now,fn){
  integer(now);this.#db.exec('BEGIN EXCLUSIVE');
  try{const last=this.#db.prepare('SELECT lastTime FROM meta').get().lastTime;assert(now>=last,'clock rollback; signing paused');
   const result=fn();this.#db.prepare('UPDATE meta SET lastTime=?').run(now);this.#db.exec('COMMIT');return result;
  }catch(e){this.#db.exec('ROLLBACK');throw e;}
 }
 quote(p,now=Math.floor(Date.now()/1000)){
  return this.#transaction(now,()=>{
   const addresses=p.route==='BTC'?this.#profile.btcDestinations:this.#profile.settings.usdcDestinations;
   assert(addresses.includes(p.destination),'unprovisioned deposit address');
   const request=hash(p),prior=this.#db.prepare('SELECT * FROM quotes WHERE destination=?').get(p.destination);
   if(prior){assert.equal(prior.request,request,'deposit address already assigned');const q=JSON.parse(prior.quote);assert(now<=q.offer.quoteUntil,'quote expired; use a fresh deposit address');return q;}
   const q=this.#signer.quote(p,now);
   this.#db.prepare('INSERT INTO quotes VALUES(?,?,?,?)').run(hash(q.offer),request,p.destination,JSON.stringify(q));return q;
  });
 }
 prepare(p,now=Math.floor(Date.now()/1000)){
  exact(p,['command','inputs']);return this.#transaction(now,()=>{
   const id=hash(p.command.offer),request=hash(p),prior=this.#db.prepare('SELECT * FROM permits WHERE id=?').get(id);
   if(prior){assert.equal(prior.request,request,'reservation already signed with different inputs');return JSON.parse(prior.wire);}
   const row=this.#db.prepare('SELECT quote FROM quotes WHERE id=?').get(id);assert(row,'quote not issued by this protected signer');
   const q=JSON.parse(row.quote);assert.equal(hash({offer:p.command.offer,sellerSignature:p.command.sellerSignature}),hash(q));
   const day=Math.floor(now/86400),amount=BigInt(p.command.offer.dubytMicro);
   const spent=this.#db.prepare('SELECT amount FROM permits WHERE day=?').all(day).reduce((n,r)=>n+BigInt(r.amount),0n);
   assert(spent+amount<=BigInt(this.#profile.dailyLimitMicro),'daily signing limit reached');
   const wire=this.#signer.prepare(p,now);
   // Commit before reply. Retries never receive a second authorization or budget.
   this.#db.prepare('INSERT INTO permits VALUES(?,?,?,?,?)').run(id,request,day,String(amount),JSON.stringify(wire));return wire;
  });
 }
 close(){this.#signer?.close();this.#db?.close();}
}
