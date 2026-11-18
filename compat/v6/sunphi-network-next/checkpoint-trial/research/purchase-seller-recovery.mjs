// Offline, key-free seller journal recovery. An independently retained latest
// checkpoint is required; a backup plus its own receipt cannot prove freshness.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,scryptSync,createCipheriv,createDecipheriv} from 'node:crypto';
import {exact,hash,hex,integer,verify} from '../crypto.mjs';
import {PROFILE} from '../core.mjs';
import {acceptance,verifyPurchaseOffer} from './purchase-contract.mjs';
import {PURCHASE_ACTION} from './purchase-native.mjs';
import {validateSellerProfile} from './purchase-seller-protected.mjs';
const DOMAIN='DUEBYTE_SELLER_RECOVERY_V1',MAX=4*1024*1024;
export function validateSellerSnapshot(s,p){
 exact(s,['domain','profileHash','lastTime','quotes','permits']);
 assert.equal(s.domain,DOMAIN);assert.equal(s.profileHash,validateSellerProfile(p));integer(s.lastTime);
 assert(Buffer.byteLength(JSON.stringify(s))<=MAX);assert(Array.isArray(s.quotes)&&s.quotes.length<=128);assert(Array.isArray(s.permits)&&s.permits.length<=s.quotes.length);
 const quotes=new Map(),destinations=new Set(),policy=p.config.purchaseLab.policy;
 for(const r of s.quotes){
  exact(r,['id','request','destination','quote']);hex(r.id);hex(r.request);exact(r.quote,['offer','sellerSignature']);
  const {offer:o,sellerSignature}=r.quote;verifyPurchaseOffer(policy,o,sellerSignature,o.createdAt);
  assert(o.createdAt<=s.lastTime);assert.equal(r.id,hash(o));assert(!quotes.has(r.id)&&!destinations.has(r.destination));
  assert.equal(r.destination,o.destination);assert((o.route==='BTC'?p.btcDestinations:p.settings.usdcDestinations).includes(o.destination));
  const request=Object.fromEntries(['buyer','route','dubytMicro','refundDestination','destination'].map(k=>[k,o[k]]));assert.equal(hash(request),r.request);
  const value=BigInt(o.dubytMicro),rate=p.settings.rates[o.route];assert(value>=BigInt(p.settings.minOrderMicro)&&value<=BigInt(p.settings.maxOrderMicro));
  assert.equal(o.payAtomic,String((value*BigInt(rate.numerator)+BigInt(rate.denominator)-1n)/BigInt(rate.denominator)));assert.equal(o.feeAtomic,rate.feeAtomic);
  assert.equal(o.quoteUntil,o.createdAt+p.settings.quoteSeconds);assert.equal(o.payUntil,o.createdAt+p.settings.paymentSeconds);
  quotes.set(r.id,r);destinations.add(r.destination);
 }
 const seen=new Set(),daily=new Map();
 for(const r of s.permits){
  exact(r,['id','request','day','amount','wire']);hex(r.request);integer(r.day);assert(!seen.has(r.id));seen.add(r.id);
  const q=quotes.get(r.id);assert(q,'permit without quote');exact(r.wire,['body','signature']);
  const b=r.wire.body;exact(b,['domain','configHash','action','author']);assert.equal(b.domain,PROFILE+'/TX');assert.equal(b.configHash,hash(p.config));assert.equal(b.author,policy.seller);assert(verify(b,r.wire.signature,b.author));
  const a=b.action;exact(a,['type','command','inputs']);assert.equal(a.type,PURCHASE_ACTION);exact(a.command,['type','offer','sellerSignature','buyerSignature']);assert.equal(a.command.type,'RESERVE');
  assert.deepEqual(a.command.offer,q.quote.offer);assert.equal(a.command.sellerSignature,q.quote.sellerSignature);assert(verify(acceptance(policy,a.command.offer),a.command.buyerSignature,a.command.offer.buyer));
  assert(Array.isArray(a.inputs)&&a.inputs.length>0&&a.inputs.length<=8);a.inputs.forEach(hex);assert.deepEqual(a.inputs,[...new Set(a.inputs)].sort());
  assert.equal(r.request,hash({command:a.command,inputs:a.inputs}));assert.equal(r.amount,a.command.offer.dubytMicro);
  assert(r.day>=Math.floor(a.command.offer.createdAt/86400)&&r.day<=Math.floor(Math.min(s.lastTime,a.command.offer.quoteUntil)/86400));
  daily.set(r.day,(daily.get(r.day)??0n)+BigInt(r.amount));assert(daily.get(r.day)<=BigInt(p.dailyLimitMicro),'daily ceiling in recovery journal');
 }
 assert.deepEqual(s.quotes.map(r=>r.id),[...quotes.keys()].sort());assert.deepEqual(s.permits.map(r=>r.id),[...seen].sort());
 return hash(s);
}
export function sellerJournalSnapshot(file,profile){
 assert(fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink());
 const db=new DatabaseSync(file,{readOnly:true});
 try{db.exec('PRAGMA busy_timeout=0; BEGIN');const rows=db.prepare('SELECT * FROM meta').all();assert.equal(rows.length,1);
  const s={domain:DOMAIN,profileHash:rows[0].pin,lastTime:rows[0].lastTime,
   quotes:db.prepare('SELECT * FROM quotes ORDER BY id').all().map(r=>({...r,quote:JSON.parse(r.quote)})),
   permits:db.prepare('SELECT * FROM permits ORDER BY id').all().map(r=>({...r,wire:JSON.parse(r.wire)}))};
  validateSellerSnapshot(s,profile);db.exec('COMMIT');return s;
 }finally{db.close();}
}
const derive=(password,salt)=>{assert(typeof password==='string'&&password.length>=16&&password.length<=1024,'backup password length');return scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});};
export function sealSellerRecovery(snapshot,profile,password){
 const snapshotHash=validateSellerSnapshot(snapshot,profile),salt=randomBytes(32),iv=randomBytes(12),key=derive(password,salt),raw=Buffer.from(JSON.stringify(snapshot));
 try{const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(JSON.stringify([DOMAIN,snapshot.profileHash])));
  const encrypted=Buffer.concat([cipher.update(raw),cipher.final()]);
  const bundle={domain:DOMAIN,profileHash:snapshot.profileHash,salt:salt.toString('hex'),iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),ciphertext:encrypted.toString('base64')};
  return {bundle,checkpoint:{domain:DOMAIN,profileHash:snapshot.profileHash,bundleHash:hash(bundle),snapshotHash,lastTime:snapshot.lastTime,quotes:snapshot.quotes.length,permits:snapshot.permits.length}};
 }finally{key.fill(0);raw.fill(0);}
}
export function openSellerRecovery(bundle,profile,password,expected){
 exact(expected,['domain','profileHash','bundleHash','snapshotHash','lastTime','quotes','permits']);hex(expected.bundleHash);hex(expected.snapshotHash);
 assert.equal(expected.domain,DOMAIN);assert.equal(expected.profileHash,validateSellerProfile(profile));assert.equal(hash(bundle),expected.bundleHash,'latest independent recovery checkpoint required');
 exact(bundle,['domain','profileHash','salt','iv','tag','ciphertext']);assert.equal(bundle.domain,DOMAIN);assert.equal(bundle.profileHash,expected.profileHash);
 assert(/^[a-f0-9]{64}$/.test(bundle.salt)&&/^[a-f0-9]{24}$/.test(bundle.iv)&&/^[a-f0-9]{32}$/.test(bundle.tag));assert(typeof bundle.ciphertext==='string'&&bundle.ciphertext.length<=Math.ceil(MAX/3)*4);
 const encrypted=Buffer.from(bundle.ciphertext,'base64');assert.equal(encrypted.toString('base64'),bundle.ciphertext);
 const key=derive(password,Buffer.from(bundle.salt,'hex'));let raw;
 try{const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(bundle.iv,'hex'));cipher.setAAD(Buffer.from(JSON.stringify([DOMAIN,bundle.profileHash])));cipher.setAuthTag(Buffer.from(bundle.tag,'hex'));raw=Buffer.concat([cipher.update(encrypted),cipher.final()]);
  const s=JSON.parse(raw);assert.equal(validateSellerSnapshot(s,profile),expected.snapshotHash);assert.equal(s.lastTime,expected.lastTime);assert.equal(s.quotes.length,expected.quotes);assert.equal(s.permits.length,expected.permits);return s;
 }finally{key.fill(0);raw?.fill(0);}
}
export function restoreSellerRecovery(file,bundle,profile,password,expected){
 const s=openSellerRecovery(bundle,profile,password,expected);assert(!fs.existsSync(file),'never overwrite seller journal');
 const fd=fs.openSync(file,'wx',0o600);fs.closeSync(fd);const db=new DatabaseSync(file);
 // No valid empty journal may exist between creating the file and restoring it.
 // A crash before commit leaves an unusable database, never a reset daily cap.
 try{db.exec('PRAGMA synchronous=FULL; BEGIN EXCLUSIVE; CREATE TABLE meta(pin TEXT NOT NULL,lastTime INTEGER NOT NULL); CREATE TABLE quotes(id TEXT PRIMARY KEY,request TEXT NOT NULL,destination TEXT UNIQUE NOT NULL,quote TEXT NOT NULL); CREATE TABLE permits(id TEXT PRIMARY KEY,request TEXT NOT NULL,day INTEGER NOT NULL,amount TEXT NOT NULL,wire TEXT NOT NULL);');
  for(const r of s.quotes)db.prepare('INSERT INTO quotes VALUES(?,?,?,?)').run(r.id,r.request,r.destination,JSON.stringify(r.quote));
  for(const r of s.permits)db.prepare('INSERT INTO permits VALUES(?,?,?,?,?)').run(r.id,r.request,r.day,r.amount,JSON.stringify(r.wire));
  db.prepare('INSERT INTO meta VALUES(?,?)').run(s.profileHash,s.lastTime);db.exec('COMMIT');
 }catch(e){try{db.exec('ROLLBACK');db.exec("UPDATE meta SET pin='INCOMPLETE_RECOVERY_DO_NOT_USE'");}catch{}throw e;}finally{db.close();}
 assert.equal(hash(sellerJournalSnapshot(file,profile)),expected.snapshotHash);
 return {restored:true,profileHash:s.profileHash,snapshotHash:expected.snapshotHash,salesEnabled:false,requiresReconciliation:true};
}
