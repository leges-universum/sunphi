import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical,digest } from './protocol.mjs';
import { checkPolicy,checkSealBody,firstEpoch,epochSpan,keyTree,signEpoch,nextSecret,verifySeal,isHash,ZERO } from './epoch-seal.mjs';
import { checkRenewalBody,verifyReady,verifyRenewal,nextPolicy,isRenewal,decodeRenewal } from './root-renewal.mjs';
import { verifyHistoryBytes } from './history-io.mjs';
const verifiedBootstrap=Symbol('internally verified root bootstrap');

export function policyFor(context,body){
 const p=context.policy;if(body.generation===p.history.generation)return p;
 if(body.generation!==p.history.generation+1||!context.pending||context.last?.body.epoch!==firstEpoch(p)+epochSpan(p)-1)throw new Error('unselected root generation');
 return nextPolicy(p,context.pending.body);
}
export function renewalsFrom(bytes){const a=JSON.parse(bytes),out=[];for(const e of a.entries.slice(0,8))for(const text of e.txs??[]){const b=Buffer.from(text,'base64');if(isRenewal(b))out.push({height:Number(e.header.header.height),certificate:decodeRenewal(b)});}return out;}
function selected(context,policy,proposals,lookup){
 let pending=policy.history.generation===context.policy.history.generation?context.pending:null,used=[...context.usedRoots];
 for(const {height,certificate:c} of proposals){
  if(pending||height<=firstEpoch(policy)*8||height>=c.body.activationEpoch*8)throw new Error('late or duplicate root selection');
  verifyRenewal(c,policy,used);
  if(c.anchor&&(c.anchor.body.headerHeight>=height||canonical(lookup(c.anchor.body.epoch))!==canonical(c.anchor.body)))throw new Error('root authorization not anchored in retained seals');
  pending=structuredClone(c);used.push(...c.body.roots);
 }return {pending,usedRoots:used};
}

// Internal signer: caller is the independently verifying loopback service.
// Provisioning is LOCAL only. There is no remote endpoint accepting secrets.
export class RenewingWitness{
 #db;#slot;#version;#identity;#publicKeys=new Map();
 #keys(root,text){if(!this.#publicKeys.has(root)){const keys=Object.freeze(JSON.parse(text));if(keyTree(keys).root!==root)throw new Error('key tree mismatch');this.#publicKeys.set(root,keys);if(this.#publicKeys.size>3)this.#publicKeys.delete(this.#publicKeys.keys().next().value);}return this.#publicKeys.get(root);}
 constructor(path,{policy,slot,keys,secret,[verifiedBootstrap]:bootstrap}){
  checkPolicy(policy);if(policy.history.version!==3||policy.history.generation!==0||!Number.isInteger(slot)||slot<0||slot>9)throw new Error('initial renewable witness policy');
  if(keyTree(keys).root!==policy.history.roots[slot])throw new Error('initial root mismatch');
  this.#slot=slot;this.#identity=digest({policy,slot});mkdirSync(dirname(path),{recursive:true});this.#db=new DatabaseSync(path);
  try{
  this.#db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS renewable(id INTEGER PRIMARY KEY CHECK(id=1),identity TEXT NOT NULL,value TEXT NOT NULL,keys TEXT NOT NULL,secret BLOB NOT NULL); CREATE TABLE IF NOT EXISTS seals(epoch INTEGER PRIMARY KEY,body TEXT NOT NULL,signature TEXT NOT NULL); CREATE TABLE IF NOT EXISTS staged(root TEXT PRIMARY KEY,keys TEXT NOT NULL,secret BLOB NOT NULL);');
  const row=this.#db.prepare('SELECT identity,value,keys FROM renewable WHERE id=1').get();
  if(row){if(row.identity!==this.#identity||secret||bootstrap)throw new Error('witness identity or secret reimport');const s=JSON.parse(row.value);checkPolicy(s.policy);if(keyTree(JSON.parse(row.keys)).root!==s.policy.history.roots[slot])throw new Error('stored key root mismatch');}
  else{if(!Buffer.isBuffer(secret)||secret.length!==32)throw new Error('new witness secret required');const state=bootstrap?.state??{policy,epoch:0,last:null,pending:null,usedRoots:[...policy.history.roots]},localKeys=bootstrap?.keys??keys;
   signEpoch(secret,localKeys,slot,0,'initialization',state.policy,{});this.#db.exec('BEGIN IMMEDIATE');try{this.#db.prepare('INSERT INTO renewable VALUES(1,?,?,?,?)').run(this.#identity,canonical(state),canonical(localKeys),secret);for(const c of bootstrap?.certificates??[])this.#db.prepare('INSERT INTO seals VALUES(?,?,?)').run(c.body.epoch,canonical(c.body),canonical(c.signatures.find(s=>s.slot===slot)??null));this.#db.exec('COMMIT');}catch(e){this.#db.exec('ROLLBACK');throw e;}}
  this.#version=this.#db.prepare('PRAGMA data_version').get().data_version;
  }catch(e){this.#db.close();throw e;}
 }
 static async join(path,{policy,slot,keys,newKeys,secret,bookPath,verification}){
  const book=await RenewalBook.open(bookPath,policy,verification);
  try{const ctx=book.context;if(!ctx.pending||ctx.last?.body.epoch!==firstEpoch(ctx.policy)+epochSpan(ctx.policy)-1)throw new Error('join requires a sealed selected generation boundary');const p=nextPolicy(ctx.policy,ctx.pending.body);if(keyTree(newKeys).root!==p.history.roots[slot])throw new Error('replacement root was not selected');
   const state={policy:p,epoch:ctx.last.body.epoch+1,last:ctx.last,pending:null,usedRoots:ctx.usedRoots,predecessorPolicy:ctx.policy};
   return new RenewingWitness(path,{policy,slot,keys,secret,[verifiedBootstrap]:{state,keys:newKeys,certificates:book.certificates}});
  }finally{book.close();}
 }
 #row(withSecret=false){if(this.#db.prepare('PRAGMA data_version').get().data_version!==this.#version)throw new Error('external signer modification');return this.#db.prepare(withSecret?'SELECT * FROM renewable WHERE id=1':'SELECT identity,value,keys FROM renewable WHERE id=1').get();}
 context(){return JSON.parse(this.#row().value);}
 status(){const s=this.context();return {slot:this.#slot,generation:s.policy.history.generation,epoch:s.epoch,head:s.last?digest(s.last.body):ZERO};}
 retained(body){const s=this.context();if(body.epoch>=s.epoch)return null;const r=this.#db.prepare('SELECT * FROM seals WHERE epoch=?').get(body.epoch);if(!r||r.body!==canonical(body)||r.signature==='null')throw new Error('past seal conflict or signature unavailable');return JSON.parse(r.signature);}
 stage(keys,secret){const s=this.context(),root=keyTree(keys).root;if(s.usedRoots.includes(root))throw new Error('retired/current root cannot be staged');signEpoch(secret,keys,this.#slot,0,'provision',s.policy,{});if(this.#db.prepare('SELECT root FROM staged WHERE root=?').get(root))return root;this.#db.prepare('INSERT INTO staged VALUES(?,?,?)').run(root,canonical(keys),secret);return root;}
 ready(body){const s=this.context();checkRenewalBody(body,s.policy,s.usedRoots);const row=this.#db.prepare('SELECT * FROM staged WHERE root=?').get(body.roots[this.#slot]);if(!row)throw new Error('new keys not provisioned');const secret=Buffer.from(row.secret);try{return signEpoch(secret,this.#keys(body.roots[this.#slot],row.keys),this.#slot,0,'root-ready',nextPolicy(s.policy,body),body);}finally{secret.fill(0);row.secret.fill(0);}}
 authorize(candidate){const s=this.context();verifyReady(candidate,s.policy,s.usedRoots);const b=candidate.body;if(b.authorizationEpoch!==s.epoch||b.head!==(s.last?digest(s.last.body):ZERO)||s.epoch>=firstEpoch(s.policy)+epochSpan(s.policy))throw new Error('authorization epoch/head');const row=this.#row(true),secret=Buffer.from(row.secret);try{return signEpoch(secret,this.#keys(s.policy.history.roots[this.#slot],row.keys),this.#slot,s.epoch-firstEpoch(s.policy),'root-authorize',s.policy,b);}finally{secret.fill(0);row.secret.fill(0);}}
 plan(body){const s=this.context(),p=policyFor(s,body);checkSealBody(body,p);return p;}
 seal(body,previous,proposals=[],crash=()=>{}){
  const row=this.#row(),s=JSON.parse(row.value);
  if(body.epoch<s.epoch)return this.retained(body);
  if(body.epoch!==s.epoch||body.previous!==(s.last?digest(s.last.body):ZERO))throw new Error('nonsequential renewable seal');
  const p=policyFor(s,body);checkSealBody(body,p);
  const lookup=epoch=>{const r=this.#db.prepare('SELECT body FROM seals WHERE epoch=?').get(epoch);return r?JSON.parse(r.body):null;};
  if(s.last){verifySeal(previous,s.predecessorPolicy??s.policy,s.epoch>1?{body:lookup(s.epoch-2)}:null);if(canonical(previous.body)!==canonical(s.last.body))throw new Error('prior quorum conflict');}else if(previous!==null)throw new Error('unexpected predecessor');
  const selection=selected(s,p,proposals,lookup),rotating=p.history.generation!==s.policy.history.generation;
  const material=rotating?this.#db.prepare('SELECT * FROM staged WHERE root=?').get(p.history.roots[this.#slot]):this.#row(true);
  if(!material)throw new Error('selected keys unavailable');const keys=this.#keys(p.history.roots[this.#slot],material.keys),secret=Buffer.from(material.secret),next=nextSecret(secret);
  try{
   const signature=signEpoch(secret,keys,this.#slot,body.epoch-firstEpoch(p),'seal',p,body);
   const state={policy:p,epoch:s.epoch+1,last:{body},...selection};
   this.#db.exec('BEGIN IMMEDIATE');try{this.#db.prepare('INSERT INTO seals VALUES(?,?,?)').run(body.epoch,canonical(body),canonical(signature));this.#db.prepare('UPDATE renewable SET value=?,keys=?,secret=? WHERE id=1').run(canonical(state),canonical(keys),next);if(rotating)this.#db.prepare('DELETE FROM staged WHERE root=?').run(p.history.roots[this.#slot]);crash('beforeCommit');this.#db.exec('COMMIT');}catch(e){this.#db.exec('ROLLBACK');throw e;}crash('afterCommit');return signature;
  }finally{secret.fill(0);next.fill(0);material.secret.fill(0);}
 }
 head(nonce){if(!isHash(nonce))throw new Error('nonce');const row=this.#row(true),s=JSON.parse(row.value),secret=Buffer.from(row.secret);const body={nonce,generation:s.policy.history.generation,epoch:s.epoch,head:s.last?digest(s.last.body):ZERO};try{return {body,signature:signEpoch(secret,this.#keys(s.policy.history.roots[this.#slot],row.keys),this.#slot,s.epoch-firstEpoch(s.policy),'head',s.policy,body)};}finally{secret.fill(0);row.secret.fill(0);}}
 close(){this.#db.close();}
}

// Public checkpoint/selection journal. Every restart reauthenticates inclusion,
// not merely the old/new authorization signatures supplied by a coordinator.
export class RenewalBook{
 #db;#state;#options;#version;#busy=false;
 static async open(path,policy,options){checkPolicy(policy);if(policy.history.version!==3||policy.history.generation!==0)throw new Error('renewal book genesis');const genesis=JSON.parse(readFileSync(options.genesis));if(digest(genesis.app_state)!==policy.genesis||genesis.chain_id!==policy.chainId||digest(genesis.app_state.history)!==digest(policy.history))throw new Error('renewal policy is not in trusted genesis');const b=new RenewalBook();b.#options=options;b.#state={policy:structuredClone(policy),last:null,pending:null,usedRoots:[...policy.history.roots]};mkdirSync(dirname(path),{recursive:true});b.#db=new DatabaseSync(path);
  try{b.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS history(epoch INTEGER PRIMARY KEY,certificate TEXT NOT NULL,archive BLOB NOT NULL);');const r=b.#db.prepare('SELECT value FROM identity WHERE id=1').get();if(r&&r.value!==canonical(policy))throw new Error('book genesis mismatch');if(!r)b.#db.prepare('INSERT INTO identity VALUES(1,?)').run(canonical(policy));b.#version=b.#db.prepare('PRAGMA data_version').get().data_version;
   // Stream archive payloads instead of materializing the entire history in RAM.
   for(const x of b.#db.prepare('SELECT * FROM history ORDER BY epoch').iterate()){
    options.signal?.throwIfAborted();const c=JSON.parse(x.certificate);if(x.epoch!==c.body.epoch)throw new Error('book epoch');b.#state=await b.#validate(c,Buffer.from(x.archive));
    await options.onReplay?.({epoch:c.body.epoch,height:c.body.endHeight});
   }
   b.#guard();return b;
  }catch(e){b.#db.close();throw e;}
 }
 #guard(){if(this.#db.prepare('PRAGMA data_version').get().data_version!==this.#version)throw new Error('external checkpoint modification');}
 get context(){this.#guard();return structuredClone(this.#state);}
 get certificates(){this.#guard();return this.#db.prepare('SELECT certificate FROM history ORDER BY epoch').all().map(r=>JSON.parse(r.certificate));}
 archive(epoch){this.#guard();const r=this.#db.prepare('SELECT archive FROM history WHERE epoch=?').get(epoch);if(!r)throw new Error('retained archive unavailable');return Buffer.from(r.archive);}
 async #validate(c,bytes){const p=policyFor(this.#state,c.body);verifySeal(c,p,this.#state.last);await verifyHistoryBytes(bytes,c.body,{...this.#options,previous:this.#state.last});const lookup=epoch=>{const r=this.#db.prepare('SELECT certificate FROM history WHERE epoch=?').get(epoch);return r?JSON.parse(r.certificate).body:null;};return {policy:p,last:structuredClone(c),...selected(this.#state,p,renewalsFrom(bytes),lookup)};}
 async accept(c,bytes){if(this.#busy)throw new Error('concurrent checkpoint mutation');this.#busy=true;try{this.#guard();const next=await this.#validate(c,bytes);this.#guard();this.#db.prepare('INSERT INTO history VALUES(?,?,?)').run(c.body.epoch,canonical(c),bytes);this.#state=next;return this.context;}finally{this.#busy=false;}}
 close(){this.#db.close();}
}
