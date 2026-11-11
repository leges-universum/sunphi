// Durable, bounded requests to a locally unlocked Home. No key upload or unlock API.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {exact,hash,hex,verify,sign} from '../crypto.mjs';
import {validateSellerProfile} from './purchase-seller-protected.mjs';
export const HOME_RELAY='DUEBYTE_HOME_SELLER_RELAY_V1';
export function relayRequest(profile,key,action,payload,now=Math.floor(Date.now()/1000)){
 const body={domain:HOME_RELAY,profileHash:hash(profile),seller:key.publicKey,action,payload,at:now,nonce:randomBytes(32).toString('hex')};return {body,signature:sign(body,key.privateKey)};
}
export class HomeSellerRelay {
 constructor(file,profile){
  this.pin=validateSellerProfile(profile);this.profile=structuredClone(profile);this.policy=profile.config.purchaseLab.policy;
  this.db=new DatabaseSync(file);this.waiters=new Map();
  try{this.db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS meta(pin TEXT); CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,action TEXT,payload TEXT,result TEXT);');
   const row=this.db.prepare('SELECT pin FROM meta').get();if(row)assert.equal(row.pin,this.pin);else this.db.prepare('INSERT INTO meta VALUES(?)').run(this.pin);this.db.exec('COMMIT');
  }catch(e){this.db.close();throw e;}
 }
 async call(action,payload){
  assert(['quote','prepare'].includes(action));assert(Buffer.byteLength(JSON.stringify(payload))<=12000);
  const id=hash({profile:this.pin,action,payload}),prior=this.db.prepare('SELECT result FROM jobs WHERE id=?').get(id);
  if(prior?.result){const r=JSON.parse(prior.result);assert(!r.error,'Home rejected signing request');return r.value;}
  if(!prior){assert(this.db.prepare('SELECT count(*) AS n FROM jobs').get().n<128,'relay capacity reached');this.db.prepare('INSERT INTO jobs VALUES(?,?,?,NULL)').run(id,action,JSON.stringify(payload));}
  assert(!this.waiters.has(id),'request already waiting');
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.waiters.delete(id);reject(Error('Home signer unavailable. Retry the same request.'));},25000);this.waiters.set(id,{resolve,reject,timer});});
 }
 quote(p){return this.call('quote',p);} prepare(p){return this.call('prepare',p);}
 async handle(request){
  exact(request,['body','signature']);const b=request.body;exact(b,['domain','profileHash','seller','action','payload','at','nonce']);
  assert.equal(b.domain,HOME_RELAY);assert.equal(b.profileHash,this.pin);assert.equal(b.seller,this.policy.seller);hex(b.nonce);assert(Number.isSafeInteger(b.at)&&Math.abs(Date.now()/1000-b.at)<=60);assert(verify(b,request.signature,b.seller));
  if(b.action==='poll'){exact(b.payload,[]);const r=this.db.prepare('SELECT id,action,payload FROM jobs WHERE result IS NULL ORDER BY rowid LIMIT 1').get();return {job:r?{...r,payload:JSON.parse(r.payload)}:null};}
  assert.equal(b.action,'complete');exact(b.payload,['id','result']);hex(b.payload.id);assert(Buffer.byteLength(JSON.stringify(b.payload.result))<=12000);
  const row=this.db.prepare('SELECT result FROM jobs WHERE id=?').get(b.payload.id);assert(row,'unknown signing request');
  if(row.result)assert.equal(hash(JSON.parse(row.result)),hash(b.payload.result),'different signing result');else this.db.prepare('UPDATE jobs SET result=? WHERE id=?').run(JSON.stringify(b.payload.result),b.payload.id);
  const waiter=this.waiters.get(b.payload.id);if(waiter){clearTimeout(waiter.timer);this.waiters.delete(b.payload.id);b.payload.result.error?waiter.reject(Error('Home rejected signing request')):waiter.resolve(b.payload.result.value);}
  return {accepted:true};
 }
 close(){for(const p of this.waiters.values()){clearTimeout(p.timer);p.reject(Error('Home relay closed'));}this.waiters.clear();this.db.close();}
}
