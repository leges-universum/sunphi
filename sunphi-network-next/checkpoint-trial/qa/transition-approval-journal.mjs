// Operator-side signing journal; never shipped as an automatic activation path.
// The caller must obtain observations from a locally fenced, stopped validator.
// Caller-provided booleans are NOT remote attestation or a substitute for fencing.
import fs from 'node:fs';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {hash,canonical,hex,exact,verify,publicKey} from '../crypto.mjs';
import {prepareBoundedRootTransition} from '../research/bounded-root-transition.mjs';
function boundary(value,body){
 exact(value,['applicationStopped','consensusStopped','pendingBlock','sourceHeight','sourceRoot','signingStateHash','backupVerified']);
 assert(value.applicationStopped===true&&value.consensusStopped===true,'Validator must be fenced and stopped');assert.equal(value.pendingBlock,false,'Pending block');assert.equal(value.backupVerified,true,'Coherent backup required');
 assert.equal(value.sourceHeight,body.sourceHeight,'Boundary height changed');assert.equal(value.sourceRoot,body.sourceRoot,'Boundary root changed');hex(value.signingStateHash);return value;
}
export class TransitionApprovalJournal{
 constructor(file,{network,configHash,key,create=false}){
  publicKey(key);hex(configHash);assert(typeof network==='string'&&network.length>0);this.identity={network,configHash,key};
  if(create){const fd=fs.openSync(file,'wx',0o600);fs.closeSync(fd);}else assert(fs.existsSync(file),'Approval journal missing: do not recreate signer history');
  const db=this.db=new DatabaseSync(file);try{db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;');
   if(create){db.exec('BEGIN IMMEDIATE; CREATE TABLE identity(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL); CREATE TABLE approvals(height INTEGER PRIMARY KEY,body_hash TEXT NOT NULL,body TEXT NOT NULL,signature TEXT NOT NULL,boundary TEXT NOT NULL);');db.prepare('INSERT INTO identity VALUES(1,?)').run(canonical(this.identity));db.exec('COMMIT');}
   assert.equal(db.prepare('SELECT body FROM identity WHERE id=1').get()?.body,canonical(this.identity),'Wrong journal identity');
  }catch(e){try{db.exec('ROLLBACK');}catch{}db.close();throw e;}
 }
 approve({source,config,handler,trustedSourceRoot,observeBoundary,signer,beforeCommit}){
  assert.equal(config.chainId,this.identity.network);assert.equal(hash(config),this.identity.configHash);assert(source.authority.validators.some(v=>v.key===this.identity.key),'Unauthorized validator');assert.equal(typeof observeBoundary,'function');assert.equal(typeof signer,'function');
  const body=prepareBoundedRootTransition(source,config,handler,trustedSourceRoot),observed=structuredClone(boundary(observeBoundary(),body)),db=this.db;db.exec('BEGIN IMMEDIATE');
  try{
   const last=db.prepare('SELECT max(height) AS height FROM approvals').get().height;assert(last===null||body.sourceHeight>=last,'Approval height rollback');
   const old=db.prepare('SELECT * FROM approvals WHERE height=?').get(body.sourceHeight);
   if(old){assert.equal(old.body_hash,hash(body),'Conflicting transition approval');assert.equal(old.body,canonical(body),'Corrupt approval journal');assert(verify(body,old.signature,this.identity.key),'Invalid stored approval');assert.equal(old.boundary,canonical(observed),'Signing state changed since approval');db.exec('ROLLBACK');return {key:this.identity.key,signature:old.signature};}
   assert.equal(canonical(boundary(observeBoundary(),body)),canonical(observed),'Boundary changed before signing');
   const signature=signer(structuredClone(body));assert(verify(body,signature,this.identity.key),'Signer returned invalid approval');
   assert.equal(canonical(boundary(observeBoundary(),body)),canonical(observed),'Boundary changed while signing');
   db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?)').run(body.sourceHeight,hash(body),canonical(body),signature,canonical(observed));beforeCommit?.();db.exec('COMMIT');
   return {key:this.identity.key,signature};
  }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
 }
 close(){this.db.close();}
}
