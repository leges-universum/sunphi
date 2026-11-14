// Offline operator gate. Never exposed through RPC and never an automatic stop.
// Verifiers are trusted local adapters; remote/UI claims are not evidence.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {hash,canonical,hex,verify} from '../crypto.mjs';
import {validatorApprovalBody,validatorSet} from '../validator-authority.mjs';
import {TransitionApprovalJournal} from './transition-approval-journal.mjs';
import {withStoppedRecoveryState} from '../recovery-state.mjs';
import {indexedSchemaReadinessBody} from '../research/indexed-schema-readiness.mjs';
import {openIndexedSchemaApplication,prepareIndexedSchemaUpgrade} from '../research/indexed-schema-upgrade.mjs';

async function fileHash(file){const h=createHash('sha256');for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest('hex');}

export class SchemaReadinessApprovalJournal extends TransitionApprovalJournal {
 constructor(file,identity){
  super(file,identity);
  this.db.exec('CREATE TABLE IF NOT EXISTS schema_readiness(height INTEGER PRIMARY KEY,body TEXT NOT NULL,evidence TEXT NOT NULL,signature TEXT)');
  this.db.exec('CREATE TABLE IF NOT EXISTS schema_proposals(height INTEGER PRIMARY KEY,body TEXT NOT NULL,evidence TEXT NOT NULL,candidate_hash TEXT NOT NULL,signature TEXT)');
 }
 async approveProposal({home,packageRoot,candidate,config,trustedBoundary,committedBlockHash,fence,verifyBackup,verifyConsensusBoundary,signer}){
  assert(!this.busy,'Schema approval already in progress');this.busy=true;
  try{
   const t=structuredClone(trustedBoundary);
   assert.equal(config.chainId,this.identity.network);assert.equal(hash(config),this.identity.configHash);
   assert.equal(t.network,this.identity.network);assert.equal(t.configHash,this.identity.configHash);
   assert(t.validators.some(v=>v.key===this.identity.key),'Unauthorized validator');hex(committedBlockHash);
   assert.equal(typeof verifyBackup,'function');assert.equal(typeof verifyConsensusBoundary,'function');assert.equal(typeof signer,'function');
   assert.equal(fence.identity.network,t.network);home=fs.realpathSync(home);
   const read=n=>JSON.parse(fs.readFileSync(path.join(home,n)));
   assert.equal(Buffer.from(read('config/priv_validator_key.json').pub_key.value,'base64').toString('base64url'),this.identity.key,'Wrong local validator');
   const held=fence.observe();assert(held.stopped===true&&held.fenced===true,'Validator must be fenced and stopped');
   let result;
   await withStoppedRecoveryState(home,{packageRoot},async receipt=>{
    assert.equal(receipt.format,'fresh-genesis');assert.equal(receipt.network,t.network);
    assert.equal(receipt.height,t.height);assert.equal(receipt.root,t.root);assert.equal(Object.keys(receipt.identities).length,3);
    const expected={network:t.network,unit:fence.identity.unit,operation:fence.identity.operation,sourceHeight:t.height,sourceRoot:t.root,blockHash:committedBlockHash,recoveryReceiptHash:hash(receipt)};
    const backup=await verifyBackup(structuredClone({boundary:expected,receipt}));
    assert.deepEqual(backup.boundary,expected);assert.equal(backup.archiveAuthenticated,true);
    assert.deepEqual(backup.sourceReceipt,receipt,'Stale backup source');assert.deepEqual(backup.restoredReceipt,receipt,'Independent restoration differs');
    hex(backup.manifestHash);hex(backup.archiveHash);
    const evidence=canonical({boundary:expected,guard:held,manifestHash:backup.manifestHash,archiveHash:backup.archiveHash});
    const check=async()=>{
     assert.deepEqual(fence.observe(),held,'Fence changed');
     for(const [name,digest]of Object.entries(receipt.identities))assert.equal(hash(read(name)),digest,'Native signing state changed');
     const source=new DatabaseSync(path.join(home,'application-indexed.sqlite'),{readOnly:true});
     try{const meta=source.prepare('SELECT * FROM meta WHERE id=1').get();assert.equal(meta.rootHash,t.root);assert.equal(meta.sequence,t.height);assert.equal(meta.journalHash,t.journalHash);}finally{source.close();}
     const c=await verifyConsensusBoundary(structuredClone(expected));assert.deepEqual(c.boundary,expected);
     assert(c.commitVerified===true&&c.readOnly===true);assert.equal(c.committedHeight,t.height);assert.equal(c.appliedHeight,t.height);
     assert.deepEqual(fence.observe(),held,'Fence changed during native verification');
    };
    await check();
    const db=this.db,last=db.prepare('SELECT max(height) AS height FROM schema_proposals').get().height;
    assert(last===null||t.height>=last,'Proposal height rollback');
    let row=db.prepare('SELECT * FROM schema_proposals WHERE height=?').get(t.height),body,candidateHash;
    if(row){
     assert.equal(row.evidence,evidence,'Proposal recovery evidence changed');body=JSON.parse(row.body);
     assert.equal(body.sourceRoot,t.root);assert.equal(body.sourceJournalHash,t.journalHash);assert.equal(body.stateHash,receipt.stateHash);
     assert.equal(body.genesisRoot,t.genesisRoot,'Proposal genesis changed');assert.equal(body.generation,t.generation,'Proposal generation changed');
     assert.equal(body.validatorSetHash,validatorSet(t.validators).hash,'Proposal voting authority changed');
     candidateHash=await fileHash(candidate);assert.equal(candidateHash,row.candidate_hash,'Prepared candidate changed');
    }else{
     // Conversion is independently derived on this signer; no coordinator body
     // or arbitrary candidate is accepted. An orphan after a crash fails closed.
     body=prepareIndexedSchemaUpgrade({source:path.join(home,'application-indexed.sqlite'),target:candidate,config,trustedBoundary:t}).body;
     assert.equal(body.stateHash,receipt.stateHash);candidateHash=await fileHash(candidate);await check();
     db.exec('BEGIN IMMEDIATE');
     try{db.prepare('INSERT INTO schema_proposals VALUES(?,?,?,?,NULL)').run(t.height,canonical(body),evidence,candidateHash);db.exec('COMMIT');}catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
    }
    const signedBody=validatorApprovalBody(body,t.validators);
    if(row?.signature){assert(verify(signedBody,row.signature,this.identity.key));await check();result={body,approval:{key:this.identity.key,signature:row.signature}};return;}
    await check();assert.equal(await fileHash(candidate),candidateHash,'Candidate changed before signing');
    const signature=await signer(structuredClone(signedBody));assert(verify(signedBody,signature,this.identity.key));
    await check();assert.equal(await fileHash(candidate),candidateHash,'Candidate changed while signing');
    db.prepare('UPDATE schema_proposals SET signature=? WHERE height=? AND body=? AND evidence=?').run(signature,t.height,canonical(body),evidence);
    assert.equal(db.prepare('SELECT signature FROM schema_proposals WHERE height=?').get(t.height).signature,signature);
    result={body,approval:{key:this.identity.key,signature}};
   });
   return result;
  }finally{this.busy=false;}
 }
 async approveSchema({home,packageRoot,candidate,config,certificate,trustedBoundary,committedBlockHash,fence,verifyBackup,verifyConsensusBoundary,signer}){
  assert(!this.busy,'Readiness approval already in progress');this.busy=true;
  try{
   const body=indexedSchemaReadinessBody(config,certificate,trustedBoundary);
   assert.equal(body.network,this.identity.network);assert.equal(body.configHash,this.identity.configHash);
   assert(trustedBoundary.validators.some(v=>v.key===this.identity.key),'Unauthorized validator');
   hex(committedBlockHash);assert.equal(typeof signer,'function');
   assert.equal(typeof verifyBackup,'function');assert.equal(typeof verifyConsensusBoundary,'function');
   assert(fence&&typeof fence.observe==='function');assert.equal(fence.identity.network,body.network);
   home=fs.realpathSync(home);
   const read=n=>JSON.parse(fs.readFileSync(path.join(home,n)));
   assert.equal(Buffer.from(read('config/priv_validator_key.json').pub_key.value,'base64').toString('base64url'),this.identity.key,'Wrong local validator');
   const checkGuard=()=>{
    const held=fence.observe();assert(held.stopped===true&&held.fenced===true,'Validator must be fenced and stopped');
    assert.deepEqual(read('indexed-schema-prepare.json'),{certificate,trustedBoundary},'Different local preparation');
    assert.deepEqual(read('indexed-schema-boundary.json'),{body,certificate,trustedBoundary},'Schema execution guard missing or changed');
    return held;
   };
   const held=checkGuard();let approval;
   await withStoppedRecoveryState(home,{packageRoot},async receipt=>{
    assert.equal(receipt.format,'fresh-genesis','Readiness requires the unchanged source interpreter');
    assert.equal(receipt.network,body.network);assert.equal(receipt.height,body.sourceHeight);assert.equal(receipt.root,body.sourceRoot);
    assert.equal(receipt.stateHash,certificate.body.stateHash,'Source semantic state changed');
    assert.equal(Object.keys(receipt.identities).length,3,'Complete native signer backup required');
    const app=openIndexedSchemaApplication(candidate,config,certificate,trustedBoundary,{auditJournal:true});
    try{
     assert.equal(app.blocks.header.height,body.sourceHeight);assert.equal(app.handler.root,certificate.body.targetRoot);
     app.handler.store.scanAuthenticated(()=>{});
     assert.equal(hash(app.handler.snapshotForAudit()),receipt.stateHash,'Candidate semantic state changed');
    }finally{app.close();}
    const expected={network:body.network,unit:fence.identity.unit,operation:fence.identity.operation,sourceHeight:body.sourceHeight,sourceRoot:body.sourceRoot,blockHash:committedBlockHash,recoveryReceiptHash:hash(receipt)};
    // The backup adapter authenticates the archive and independently restores it;
    // both receipts must be exact, including the native signing watermark.
    const backup=await verifyBackup(structuredClone({boundary:expected,receipt}));
    assert.deepEqual(backup.boundary,expected,'Backup belongs to another stopped boundary');
    assert.equal(backup.archiveAuthenticated,true,'Backup authentication required');
    assert.deepEqual(backup.sourceReceipt,receipt,'Stale backup source');
    assert.deepEqual(backup.restoredReceipt,receipt,'Independent restoration differs');
    hex(backup.manifestHash);hex(backup.archiveHash);
    const check=async()=>{
     assert.deepEqual(checkGuard(),held,'Fence changed');
     const files=()=>{for(const [file,digest]of Object.entries(receipt.identities))assert.equal(hash(read(file)),digest,'Native signing state changed');
      const source=new DatabaseSync(path.join(home,'application-indexed.sqlite'),{readOnly:true});
      try{const meta=source.prepare('SELECT * FROM meta WHERE id=1').get();assert.equal(meta.rootHash,body.sourceRoot);assert.equal(meta.journalHash,body.sourceJournalHash);assert.equal(meta.sequence,body.sourceHeight);}finally{source.close();}
     };
     files();
     const c=await verifyConsensusBoundary(structuredClone(expected));
     assert.deepEqual(c.boundary,expected,'Comet evidence belongs to another boundary');
     assert.equal(c.commitVerified,true,'Comet commit not verified');assert.equal(c.readOnly,true);
     assert.equal(c.committedHeight,body.sourceHeight,'Pending Comet commit');assert.equal(c.appliedHeight,body.sourceHeight);
     assert.deepEqual(checkGuard(),held,'Fence changed during Comet check');
     files();
    };
    await check();
    const evidence=canonical({boundary:expected,guard:held,manifestHash:backup.manifestHash,archiveHash:backup.archiveHash});
    const signedBody=validatorApprovalBody(body,trustedBoundary.validators),text=canonical(signedBody),db=this.db;
    db.exec('BEGIN IMMEDIATE');
    let old;
    try{
     const latest=db.prepare('SELECT max(height) AS height FROM schema_readiness').get().height;
     assert(latest===null||body.sourceHeight>=latest,'Readiness height rollback');
     old=db.prepare('SELECT * FROM schema_readiness WHERE height=?').get(body.sourceHeight);
     if(old){assert.equal(old.body,text,'Conflicting readiness intent');assert.equal(old.evidence,evidence,'Recovery evidence changed since intent');}
     else db.prepare('INSERT INTO schema_readiness VALUES(?,?,?,NULL)').run(body.sourceHeight,text,evidence);
     // Persist the exact decision BEFORE asking the key to sign. A crash cannot
     // erase the decision and permit a different certificate at this height.
     db.exec('COMMIT');
    }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
    if(old?.signature){assert(verify(signedBody,old.signature,this.identity.key),'Invalid stored readiness');await check();approval={key:this.identity.key,signature:old.signature};return;}
    await check();
    const signature=await signer(structuredClone(signedBody));
    assert(verify(signedBody,signature,this.identity.key),'Invalid readiness signature');
    await check();
    db.prepare('UPDATE schema_readiness SET signature=? WHERE height=? AND body=? AND evidence=?').run(signature,body.sourceHeight,text,evidence);
    assert.equal(db.prepare('SELECT signature FROM schema_readiness WHERE height=?').get(body.sourceHeight).signature,signature,'Readiness persistence failed');
    approval={key:this.identity.key,signature};
   });
   return approval;
  }finally{this.busy=false;}
 }
}
