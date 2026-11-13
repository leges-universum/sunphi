// Explicit same-chain V6 -> V15 boundary. Never replaces a working database.
// trustedBoundary is LOCAL, independently authenticated deployment input. Never
// derive it from the certificate, a peer response, or the converted database.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {sqlitePath} from '../sqlite-path.mjs';
import {hash,canonical,exact,integer,hex} from '../crypto.mjs';
import {origin,validateConfig} from '../core.mjs';
import {validatorQuorum,validatorSet} from '../validator-authority.mjs';
import {prepareIndexedUpgrade} from './indexed-upgrade-preparation.mjs';
import {AuthenticatedRecordStore,EMPTY} from './authenticated-record-store.mjs';
import {RECORD_DOMAIN} from './record-proof.mjs';
import {BoundedNetworkInterpreter,BOUNDED_DOMAIN} from './bounded-network-interpreter.mjs';
import {BoundedApplication} from './bounded-application.mjs';
import {verifyRetainedJournal,RESTART_JOURNAL_ROWS} from './journal-startup.mjs';

const DOMAIN='DUEBYTE_INDEXED_SCHEMA_UPGRADE_V1',SOURCE='DUEBYTE_BOUNDED_NETWORK_V6';
const version=value=>value===undefined?{present:false}:{present:true,value};
function checkBoundary(config,t){
 validateConfig(config);exact(t,['network','configHash','genesisRoot','height','root','journalHash','generation','validators']);
 assert.equal(t.network,config.chainId);assert.equal(t.configHash,hash(config));
 integer(t.height,1);integer(t.generation);for(const k of ['genesisRoot','root','journalHash'])hex(t[k]);validatorSet(t.validators);
}
function checkBody(b,config,t){
 checkBoundary(config,t);
 exact(b,['domain','network','configHash','genesisRoot','sourceSchema','targetSchema','sourceHeight','activationHeight','sourceRoot','targetRoot','sourceJournalHash','targetJournalHash','stateHash','historyDigest','generation','validatorSetHash','issuance']);
 assert.equal(b.domain,DOMAIN);assert.equal(b.network,t.network);assert.equal(b.configHash,t.configHash);assert.equal(b.genesisRoot,t.genesisRoot);
 assert.equal(b.sourceSchema,SOURCE);assert.equal(b.targetSchema,BOUNDED_DOMAIN);assert.equal(b.sourceHeight,t.height);assert.equal(b.activationHeight,t.height+1);
 assert.equal(b.sourceRoot,t.root);assert.equal(b.sourceJournalHash,t.journalHash);assert.equal(b.generation,t.generation);assert.equal(b.validatorSetHash,validatorSet(t.validators).hash);assert.equal(b.issuance,false);
 for(const k of ['targetRoot','targetJournalHash','stateHash','historyDigest'])hex(b[k]);return b;
}
export function verifyIndexedSchemaUpgrade(certificate,config,trustedBoundary){
 exact(certificate,['body','approvals']);const b=checkBody(certificate.body,config,trustedBoundary);
 validatorQuorum(b,certificate.approvals,trustedBoundary.validators);return b;
}
export function indexedSchemaRootTerms(config,profile){
 exact(profile,['certificate','trustedBoundary']);
 return {...verifyIndexedSchemaUpgrade(profile.certificate,config,profile.trustedBoundary),kind:'indexed-schema-upgrade',genesisStateHash:hash(origin(config)),archive:null};
}
// Only a previously pinned fresh V6 authority can advance to this boundary.
// Changing certificates, moving backwards or swapping genesis is never renewal.
export function verifyIndexedSchemaPredecessor(previous,next){
 if(hash(previous)===hash(next))return;
 assert.equal(next.kind,'indexed-schema-upgrade','indexed transition conflict');
 exact(previous,['kind','manifestHash','network','configHash','targetSchema','sourceHeight','activationHeight','sourceRoot','targetRoot','archive']);
 assert.equal(previous.kind,'fresh-genesis');hex(previous.manifestHash);
 assert.equal(previous.network,next.network);assert.equal(previous.configHash,next.configHash);
 assert.equal(previous.targetSchema,next.sourceSchema);assert.equal(previous.sourceHeight,0);assert.equal(previous.activationHeight,1);
 assert.equal(previous.sourceRoot,next.genesisStateHash);assert.equal(previous.targetRoot,next.genesisRoot);assert.equal(previous.archive,null);
}
const bridgeEvent=b=>({domain:DOMAIN,height:b.sourceHeight,sourceSchema:b.sourceSchema,targetSchema:b.targetSchema,stateHash:b.stateHash,historyDigest:b.historyDigest,issuance:false});
function checkJournalRow(row,parent,previous,sequence){
 const b=JSON.parse(row.body);exact(b,['domain','sequence','parent','root','previousJournal','event','changes']);
 assert.equal(b.domain,RECORD_DOMAIN+'/JOURNAL');assert.equal(row.sequence,sequence);assert.equal(b.sequence,sequence);assert.equal(row.parent,parent);assert.equal(b.parent,parent);assert.equal(row.root,b.root);assert.equal(b.previousJournal,previous);assert.equal(row.digest,hash(b));assert(Array.isArray(b.changes));return b;
}
function originalJournal(reader,t,visit=()=>{}){
 let parent=t.genesisRoot,previous=EMPTY,sequence=0;
 for(const row of reader.db.prepare('SELECT * FROM journal ORDER BY sequence').iterate()){
  const b=checkJournalRow(row,parent,previous,++sequence);assert.equal(b.event.height,sequence);assert.equal(b.event.filter,false);visit(row);parent=row.root;previous=row.digest;
 }
 assert.equal(sequence,t.height,'source journal must start at genesis');assert.equal(parent,t.root);assert.equal(previous,t.journalHash);
 assert.equal(reader.meta.sequence,sequence);assert.equal(reader.meta.journalHash,previous);
}

export function prepareIndexedSchemaUpgrade({source,target,config,trustedBoundary}){
 const t=structuredClone(trustedBoundary);checkBoundary(config,t);
 assert(!fs.existsSync(target),'target must not exist');
 const directory=fs.realpathSync(path.dirname(target)),destination=path.join(directory,path.basename(target));
 assert.notEqual(fs.realpathSync(source).toLowerCase(),destination.toLowerCase(),'source and target must differ');
 const stage=path.join(directory,'.schema-upgrade-'+randomUUID()+'.sqlite');
 const reader=AuthenticatedRecordStore.readOnly(source,t.root);let handler;
 try{
  originalJournal(reader,t);
  const anchor=reader.proof('meta/anchor',t.root).value;
  assert.equal(anchor.height,0);assert.equal(anchor.sourceStateHash,hash(origin(config)));assert.equal(anchor.archive,null);
  const receipt=prepareIndexedUpgrade({source,target:stage,config,expectedRoot:t.root,expectedHeight:t.height});
  assert.equal(receipt.source.journalHash,t.journalHash);assert.equal(receipt.source.sequence,t.height);
  handler=BoundedNetworkInterpreter.open(stage,config,receipt.target.root);
  const state=handler.snapshotForAudit();assert.equal(state.authority.generation,t.generation);assert.deepEqual(state.authority.validators,t.validators);assert(!state.authority.pending,'validator transition must finish before schema upgrade');
  const before=new Map(),after=new Map();reader.scanAuthenticated((k,v)=>before.set(k,v));handler.store.scanAuthenticated((k,v)=>after.set(k,v));
  const changes=[...new Set([...before.keys(),...after.keys()])].sort().filter(k=>canonical(version(before.get(k)))!==canonical(version(after.get(k)))).map(key=>({key,before:version(before.get(key)),after:version(after.get(key))}));
  const body={domain:DOMAIN,network:t.network,configHash:t.configHash,genesisRoot:t.genesisRoot,sourceSchema:SOURCE,targetSchema:BOUNDED_DOMAIN,sourceHeight:t.height,activationHeight:t.height+1,sourceRoot:t.root,targetRoot:handler.root,sourceJournalHash:t.journalHash,targetJournalHash:'0'.repeat(64),stateHash:receipt.stateHash,historyDigest:receipt.historyDigest,generation:t.generation,validatorSetHash:validatorSet(t.validators).hash,issuance:false};
  const bridge={domain:RECORD_DOMAIN+'/JOURNAL',sequence:t.height+1,parent:t.root,root:handler.root,previousJournal:t.journalHash,event:bridgeEvent(body),changes};body.targetJournalHash=hash(bridge);
  const db=handler.store.db;db.exec('BEGIN IMMEDIATE');
  try{
   assert.equal(handler.store.meta.sequence,0);assert.equal(db.prepare('SELECT count(*) n FROM journal').get().n,0);
   const insert=db.prepare('INSERT INTO journal VALUES(?,?,?,?,?)');
   originalJournal(reader,t,row=>insert.run(row.sequence,row.parent,row.root,row.body,row.digest));
   insert.run(bridge.sequence,bridge.parent,bridge.root,canonical(bridge),body.targetJournalHash);
   db.prepare('UPDATE meta SET sequence=?,journalHash=? WHERE id=1').run(bridge.sequence,body.targetJournalHash);db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  assert.equal(canonical(handler.snapshotForAudit()),canonical(state));
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');handler.close();handler=null;
  // Publish only this newly-created local artifact. Hard link cannot overwrite
  // a concurrently created destination and stays on the same filesystem.
  fs.linkSync(stage,destination);
  return {body,status:'AWAITING_VALIDATOR_APPROVALS',activationAuthorized:false,productionInstallable:false};
 }finally{
  handler?.close();reader.close();
  for(const suffix of ['', '-wal','-shm']){const file=stage+suffix;if(fs.existsSync(file))fs.unlinkSync(file);}
 }
}

// Normal restart validates a bounded suffix. Older history remains available and
// is checked in full at import, installation and offline recovery, not on every
// process start. Local checks never replace CometBFT's app-hash replay handshake.
export const SCHEMA_RESTART_ROWS=RESTART_JOURNAL_ROWS;
export function verifySchemaJournal(handler,b,{full=false}={}){
 return verifyRetainedJournal(handler,{genesisRoot:b.genesisRoot,bridge:{sequence:b.sourceHeight+1,parent:b.sourceRoot,root:b.targetRoot,digest:b.targetJournalHash,previousJournal:b.sourceJournalHash,event:bridgeEvent(b)}},{full});
}

export function openIndexedSchemaApplication(file,config,certificate,trustedBoundary,{auditJournal=false}={}){
 const b=verifyIndexedSchemaUpgrade(certificate,config,trustedBoundary),db=new DatabaseSync(sqlitePath(file),{readOnly:true});let root;
 try{root=db.prepare('SELECT rootHash FROM meta WHERE id=1').get().rootHash;}finally{db.close();}
 const handler=BoundedNetworkInterpreter.open(file,config,root);
 try{
  const anchor=handler.store.proof('meta/anchor',root).value;
  assert.equal(anchor.height,0);assert.equal(anchor.sourceStateHash,hash(origin(config)));assert.equal(anchor.archive,null);assert.equal(anchor.retainsTerminalHistory,true);
  verifySchemaJournal(handler,b,{full:auditJournal});
  // The conversion semantic audit is mandatory at installation/import/recovery.
  // Normal restarts authenticate accessed records without loading all wallets.
  if(auditJournal&&handler.networkHeader().height===b.sourceHeight)assert.equal(hash(handler.snapshotForAudit()),b.stateHash);
  const terms=indexedSchemaRootTerms(config,{certificate,trustedBoundary});
  return new BoundedApplication(handler,terms);
 }catch(e){handler.close();throw e;}
}
