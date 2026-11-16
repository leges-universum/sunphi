// Local deployment gate, not a consensus vote or a remotely callable stop API.
// Install on every active validator before any validator changes interpreters.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {hash,exact} from '../crypto.mjs';
import {verifyValidatorApprovals} from '../validator-authority.mjs';
import {verifyIndexedSchemaUpgrade} from './indexed-schema-upgrade.mjs';

export function indexedSchemaReadinessBody(config,certificate,trustedBoundary){
 const b=verifyIndexedSchemaUpgrade(certificate,config,trustedBoundary);
 return {domain:'DUEBYTE_INDEXED_SCHEMA_READINESS_V1',network:b.network,configHash:b.configHash,generation:b.generation,certificateHash:hash(certificate),sourceHeight:b.sourceHeight,sourceRoot:b.sourceRoot,sourceJournalHash:b.sourceJournalHash,validatorSetHash:b.validatorSetHash};
}
export function verifyIndexedSchemaReadiness(receipt,config,certificate,trustedBoundary){
 exact(receipt,['body','approvals']);
 assert.deepEqual(receipt.body,indexedSchemaReadinessBody(config,certificate,trustedBoundary));
 const result=verifyValidatorApprovals(receipt.body,receipt.approvals,trustedBoundary.validators);
 // Quorum authorizes the schema; readiness accounts for EVERY active writer.
 // A delayed validator must already refuse post-boundary legacy execution.
 assert.equal(result.power,result.total,'every active validator must acknowledge the schema boundary');
 return receipt.body;
}
export function verifyIndexedSchemaActivation(settings,config,{isValidator=false}={}){
 exact(settings,['readPort','bootstrap','certificate','trustedBoundary',...(Object.hasOwn(settings,'readiness')?['readiness']:[])]);
 assert.equal(typeof settings.bootstrap,'boolean');assert.equal(typeof isValidator,'boolean');
 verifyIndexedSchemaUpgrade(settings.certificate,config,settings.trustedBoundary);
 assert(!isValidator||!settings.bootstrap,'validator cannot bypass readiness using snapshot bootstrap');
 if(!settings.bootstrap||Object.hasOwn(settings,'readiness'))verifyIndexedSchemaReadiness(settings.readiness,config,settings.certificate,settings.trustedBoundary);
 return settings;
}
export function persistIndexedSchemaBoundary(directory,config,certificate,trustedBoundary){
 const body=indexedSchemaReadinessBody(config,certificate,trustedBoundary),record={body,certificate,trustedBoundary};
 const home=fs.realpathSync(directory),file=path.join(home,'indexed-schema-boundary.json');
 if(fs.existsSync(file)){
  assert(fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink(),'regular schema boundary required');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)),record,'persisted schema boundary conflict');
 }else{
  const temp=path.join(home,'.schema-boundary-'+randomUUID()),fd=fs.openSync(temp,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(record));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{fs.linkSync(temp,file);}finally{fs.unlinkSync(temp);}
  if(process.platform!=='win32'){const dir=fs.openSync(home,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
 }
 assert.deepEqual(JSON.parse(fs.readFileSync(file)),record);
 return body;
}
export function openGuardedIndexedSchemaBoundary(directory,application,config,certificate,trustedBoundary){
 // The caller still supplies independently pinned deployment authority. A local
 // file, missing guard or different certificate is never a fallback to V6.
 const file=path.join(directory,'indexed-schema-boundary.json');
 assert(fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink(),'regular schema boundary required');
 assert.deepEqual(JSON.parse(fs.readFileSync(file)),{body:indexedSchemaReadinessBody(config,certificate,trustedBoundary),certificate,trustedBoundary},'persisted schema boundary conflict');
 return guardIndexedSchemaBoundary(application,config,certificate,trustedBoundary);
}
export function guardIndexedSchemaBoundary(application,config,certificate,trustedBoundary){
 const body=indexedSchemaReadinessBody(config,certificate,trustedBoundary);
 const check=()=>{
  assert.equal(application.handler.config.chainId,body.network);
  assert.equal(hash(application.handler.config),body.configHash);
  assert.equal(application.blocks.header.height,body.sourceHeight,'legacy application moved beyond the signed boundary');
  assert.equal(application.handler.root,body.sourceRoot,'legacy boundary root changed');
  assert.equal(application.handler.store.meta.journalHash,body.sourceJournalHash,'legacy boundary journal changed');
  const anchor=application.handler.store.proof('meta/anchor',body.sourceRoot).value;
  assert.equal(anchor.domain,'DUEBYTE_BOUNDED_NETWORK_V6');
 };
 check();
 // Construct only around a freshly opened, stopped application. Never forward
 // Commit: an in-memory old-rule candidate must not leak across this boundary.
 return {handler:application.handler,blocks:application.blocks,terms:application.terms,readinessBody:structuredClone(body),
  dispatch(q,options){
   check();
   if(q.method==='check')return {code:1};
   if(q.method==='process')return {accept:false};
   assert(['info','status','runtime','publicCheckpoint','listSnapshots','loadSnapshotChunk'].includes(q.method),'schema boundary: compatible runtime activation required');
   return application.dispatch(q,options);
  },
  close(){application.close();}
 };
}
