import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical,digest } from './protocol.mjs';
import { checkPolicy,checkSealBody,keyTree,nextSecret,signEpoch,verifySeal,ZERO,isHash } from './epoch-seal.mjs';

// Internal durable signer. Only the independently verifying witness service may
// call seal(). This is NOT an endpoint accepting a caller's verification flag.
export class HistoryWitness {
 #db;#policy;#keys;#slot;#version;
 constructor(path,{policy,slot,keys,secret}){
  checkPolicy(policy);this.#policy=structuredClone(policy);this.#slot=slot;this.#keys=Object.freeze([...keys]);
  if(!Number.isInteger(slot)||slot<0||slot>9||keyTree(this.#keys).root!==policy.history.roots[slot])throw new Error('witness identity');
  mkdirSync(dirname(path),{recursive:true});this.#db=new DatabaseSync(path);
  this.#db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL, epoch INTEGER NOT NULL, secret BLOB NOT NULL, head TEXT NOT NULL); CREATE TABLE IF NOT EXISTS seals(epoch INTEGER PRIMARY KEY, body TEXT NOT NULL, signature TEXT NOT NULL);');
  const identity=digest({policy,slot,keys}),row=this.#db.prepare('SELECT * FROM state WHERE id=1').get();
  if(row){if(row.identity!==identity)throw new Error('witness configuration changed');if(secret)throw new Error('do not reimport a secret into existing witness');}
  else{if(!Buffer.isBuffer(secret)||secret.length!==32)throw new Error('new witness requires secret');signEpoch(secret,this.#keys,slot,0,'initialization',policy,{});this.#db.prepare('INSERT INTO state VALUES(1,?,0,?,?)').run(identity,secret,ZERO);}
  this.#version=this.#db.prepare('PRAGMA data_version').get().data_version;
 }
 #state(){if(this.#db.prepare('PRAGMA data_version').get().data_version!==this.#version)throw new Error('external witness modification');return this.#db.prepare('SELECT * FROM state WHERE id=1').get();}
 status(){const s=this.#state();return {slot:this.#slot,epoch:s.epoch,head:s.head};}
 seal(body,previous=null,crash=()=>{}){
  checkSealBody(body,this.#policy);const state=this.#state();
  if(body.epoch<state.epoch){const old=this.#db.prepare('SELECT * FROM seals WHERE epoch=?').get(body.epoch);if(!old||old.body!==canonical(body))throw new Error('past epoch conflict');return JSON.parse(old.signature);}
  // Reserve leaf 255 for authenticated final heads; policy extension is a new
  // separately approved protocol, never an implicit wrap/reuse of old secrets.
  if(body.epoch!==state.epoch||body.epoch>=255||body.previous!==state.head)throw new Error('witness epoch or predecessor');
  if(body.epoch>0){
   const priorPrior=body.epoch>1?{body:JSON.parse(this.#db.prepare('SELECT body FROM seals WHERE epoch=?').get(body.epoch-2).body)}:null;
   verifySeal(previous,this.#policy,priorPrior);
   if(digest(previous.body)!==state.head)throw new Error('previous quorum differs from retained seal');
  }else if(previous!==null)throw new Error('unexpected predecessor');
  const secret=Buffer.from(state.secret),next=nextSecret(secret);
  try{
   const signature=signEpoch(secret,this.#keys,this.#slot,body.epoch,'seal',this.#policy,body);
   this.#db.exec('BEGIN IMMEDIATE');try{
    this.#db.prepare('INSERT INTO seals VALUES(?,?,?)').run(body.epoch,canonical(body),canonical(signature));
    this.#db.prepare('UPDATE state SET epoch=?,secret=?,head=? WHERE id=1').run(body.epoch+1,next,digest(body));crash('beforeCommit');this.#db.exec('COMMIT');
   }catch(e){this.#db.exec('ROLLBACK');throw e;}
   crash('afterCommit');return signature;
  }finally{secret.fill(0);next.fill(0);state.secret.fill(0);}
 }
 head(nonce){if(!isHash(nonce))throw new Error('fresh nonce required');const s=this.#state(),secret=Buffer.from(s.secret);try{const body={nonce,epoch:s.epoch,head:s.head};return {body,signature:signEpoch(secret,this.#keys,this.#slot,s.epoch,'head',this.#policy,body)};}finally{secret.fill(0);s.secret.fill(0);}}
 close(){this.#db.close();}
}
