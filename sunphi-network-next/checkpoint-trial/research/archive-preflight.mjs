// Prepare large immutable archives BEFORE starting Comet's trust-period clock.
// Publication still requires a fresh quorum checkpoint and full state/history
// validation. Comet subsequently verifies that exact root before joining.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {hash} from '../crypto.mjs';
import {acquireStateAccess} from '../state-access.mjs';
import {verifyCheckpoint} from '../checkpoint.mjs';
import {ArchiveAuditSession} from './archive-audit-session.mjs';
import {IndexedSnapshotReceiver,checkIndexedCheckpoint,ARCHIVE_SNAPSHOT_FORMAT} from './indexed-snapshot.mjs';
import {verifyIndexedSchemaUpgrade,schemaJournalTerms} from './indexed-schema-upgrade.mjs';
import {freshRootTerms} from './fresh-application.mjs';
import {receiveArchiveObjects} from './archive-transport.mjs';
import {ARCHIVE_SNAPSHOTS,ARCHIVE_SNAPSHOT_CHUNK,fetchArchiveSnapshot} from './archive-snapshot-route.mjs';
import {acceptedSnapshotExpired} from './snapshot-expiry.mjs';
import {cleanSnapshotCandidates} from './snapshot-staging.mjs';

function durable(file,value){const temp=file+'.'+randomUUID()+'.pending',fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,typeof value==='string'?value:JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);}
function bindPreflightAnchor(home,metadata){
 assert(!fs.existsSync(join(home,'application-indexed.sqlite')),'preflight cannot replace active state');
 assert.equal(JSON.parse(fs.readFileSync(join(home,'run-settings.json'))).isValidator,false);
 const {document,manifest}=metadata,toml=join(home,'config/config.toml'),text=fs.readFileSync(toml,'utf8');
 for(const key of ['trust_height','trust_hash'])assert.equal((text.match(new RegExp('^'+key+' = .*$','gm'))??[]).length,1);
 durable(join(home,'checkpoint.json'),document);
 durable(toml,text.replace(/^trust_height = .*$/m,'trust_height = '+document.body.height).replace(/^trust_hash = .*$/m,'trust_hash = "'+document.body.blockHash.toUpperCase()+'"'));
 for(const directory of [home,join(home,'config')]){const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
}
export function preflightJournalTerms(profile){return profile.schemaUpgrade?schemaJournalTerms(verifyIndexedSchemaUpgrade(profile.schemaUpgrade.certificate,profile.config,profile.schemaUpgrade.trustedBoundary)):{genesisRoot:(freshRootTerms(profile.config,profile.fresh),profile.fresh.manifest.root)};}
export async function preflightArchive(home,profile,{request=fetchArchiveSnapshot,onProgress=()=>{},signal,afterPrepared=async()=>{},archiveAudit=null,stateOwned=false}={}){
 const target=join(home,'application-indexed.sqlite');if(fs.existsSync(target))return {existing:true};
 assert(profile.fresh||profile.schemaUpgrade);const terms=preflightJournalTerms(profile);
 const unlock=stateOwned?()=>{}:acquireStateAccess(home),directory=join(home,'indexed-incoming');fs.mkdirSync(directory,{recursive:true,mode:0o700});let cache;
 let previous=JSON.parse(fs.readFileSync(join(home,'checkpoint.json')));verifyCheckpoint(previous,profile.policy,{now:previous.body.issuedAt,configHash:hash(profile.config)});
 try{
  const validation=join(directory,'.archive-validation');fs.mkdirSync(validation,{recursive:true,mode:0o700});assert(!fs.lstatSync(validation).isSymbolicLink());
  cache=archiveAudit??new ArchiveAuditSession(target,terms,{directory:validation,onProgress});
  while(true){
   signal?.throwIfAborted();let metadata=null,available=false;
   for(const source of profile.rpcServers){try{
    const result=await request(source,{operation:ARCHIVE_SNAPSHOTS},{signal});assert(Array.isArray(result.snapshots)&&result.snapshots.length<=8);available=true;
    for(const offer of result.snapshots){assert(typeof offer.metadata==='string'&&offer.metadata.length<=131072);const candidate=JSON.parse(Buffer.from(offer.metadata,'base64'));checkIndexedCheckpoint(candidate.document,candidate.manifest,profile.policy,profile.config,{previous});
     if(candidate.manifest.format!==ARCHIVE_SNAPSHOT_FORMAT)continue;
     assert.equal(offer.format,candidate.manifest.format);assert.equal(Number(offer.height),candidate.manifest.height);assert.equal(offer.chunks,candidate.manifest.chunks);assert.equal(Buffer.from(offer.hash,'base64').toString('hex'),hash(candidate.manifest));
     if(!metadata||candidate.document.body.sequence>metadata.document.body.sequence)metadata=candidate;
    }
   }catch{signal?.throwIfAborted();}}
   // Old releases without archive transport keep the existing Comet path. Once
   // archives are advertised, subsequent missing/expired offers wait safely.
   if(!metadata&&!cache.prepared)return {required:false};
   if(!metadata){await new Promise(r=>setTimeout(r,5000));continue;}
   cleanSnapshotCandidates(home,{keep:hash(metadata.manifest),onProgress});
   const receiver=new IndexedSnapshotReceiver({directory,target,metadata,policy:profile.policy,config:profile.config,fresh:profile.fresh??null,schemaUpgrade:profile.schemaUpgrade?{certificate:profile.schemaUpgrade.certificate,trustedBoundary:profile.schemaUpgrade.trustedBoundary}:null,previous,archiveSources:profile.rpcServers});
   try{
    for(let index=0;index<metadata.manifest.chunks;index++){
     signal?.throwIfAborted();let error,ok=false;
     for(const source of profile.rpcServers){try{const value=await request(source,{operation:ARCHIVE_SNAPSHOT_CHUNK,height:metadata.manifest.height,index},{signal});assert(typeof value.chunk==='string'&&value.chunk.length<=1500000);const chunk=JSON.parse(Buffer.from(value.chunk,'base64'));assert.equal(chunk.index,index);receiver.receive(chunk);ok=true;break;}catch(e){error=e;signal?.throwIfAborted();}}
     if(!ok)throw error;onProgress({phase:'snapshot',received:index+1,total:metadata.manifest.chunks});
    }
    const catalogue=join(receiver.directory,'preflight-'+randomUUID()+'.sqlite');
    try{receiver.assemble(catalogue);await receiveArchiveObjects(catalogue,target,{sources:profile.rpcServers,archiveAudit:cache,onProgress,signal});cache.prepared=true;await afterPrepared(metadata);}
    finally{for(const suffix of ['', '-wal','-shm'])if(fs.existsSync(catalogue+suffix))fs.unlinkSync(catalogue+suffix);}
    previous=metadata.document;
    if(acceptedSnapshotExpired(metadata)){onProgress({phase:'waiting-current-snapshot'});continue;}
    // Only the stopped Comet trust anchor changes here. The application DB
    // remains absent; final publication must match Comet's verified root.
    checkIndexedCheckpoint(metadata.document,metadata.manifest,profile.policy,profile.config,{previous});bindPreflightAnchor(home,metadata);
    return {prepared:true,height:metadata.manifest.height,manifestHash:hash(metadata.manifest)};
   }catch(e){if(!fs.existsSync(target)&&acceptedSnapshotExpired(metadata)){previous=metadata.document;continue;}throw e;}
  }
 }finally{if(!archiveAudit)cache?.close();unlock();}
}
