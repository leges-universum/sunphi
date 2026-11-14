// Offline, resumable installation of an already authorized same-chain upgrade.
// Never stops a node, signs approvals, resets Comet, or enables issuance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {sqlitePath} from '../sqlite-path.mjs';
import {hash} from '../crypto.mjs';
import {assertConsumerStopped} from '../consumer-home.mjs';
import {acquireStateAccess,SCHEMA_INSTALL_PENDING} from '../state-access.mjs';
import {openIndexedSchemaApplication} from './indexed-schema-upgrade.mjs';
import {verifyIndexedSchemaActivation,indexedSchemaReadinessBody} from './indexed-schema-readiness.mjs';

const ACTIVE='application-indexed.sqlite',BACKUP='application-indexed.pre-schema.sqlite';
const STAGE='application-indexed.schema-stage.sqlite',FRESH='fresh-activation.json';
const OLD_FRESH='fresh-activation.pre-schema.json',SETTINGS='indexed-schema-activation.json';
const DONE='indexed-schema-install.completed.json';
function regular(file){const s=fs.lstatSync(file);assert(s.isFile()&&!s.isSymbolicLink(),'regular installation file required');}
function digest(file){
 regular(file);const h=createHash('sha256'),fd=fs.openSync(file,'r'),b=Buffer.alloc(256*1024);
 try{let n;while((n=fs.readSync(fd,b,0,b.length,null)))h.update(b.subarray(0,n));}finally{fs.closeSync(fd);}
 return h.digest('hex');
}
function syncDirectory(home){if(process.platform!=='win32'){const fd=fs.openSync(home,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}}
function requireCopySpace(home,candidate){
 const space=fs.statfsSync(home,{bigint:true}),bytes=fs.statSync(candidate,{bigint:true}).size;
 // Operational headroom, not a consensus parameter. Preserve the original DB;
 // reject before intent and recheck before staging if space changed meanwhile.
 assert(space.bavail*space.bsize>bytes+500_000_000n,'insufficient free space for schema staging and recovery headroom');
}
function durable(file,bytes){
 const temp=file+'.'+randomUUID()+'.next',fd=fs.openSync(temp,'wx',0o600);
 try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 try{fs.linkSync(temp,file);syncDirectory(path.dirname(file));}finally{fs.unlinkSync(temp);}
}
function sidecars(file){for(const suffix of ['-wal','-shm','-journal'])if(fs.existsSync(file+suffix)){regular(file+suffix);if(suffix!=='-shm')assert.equal(fs.statSync(file+suffix).size,0,'close all SQLite readers and writers before installation');}}
function boundary(file,t){
 // Use a normal connection for SQLite's own final-close sidecar cleanup. A
 // read-only WAL connection can leave a shared-memory file after closing.
 sidecars(file);regular(file);const db=new DatabaseSync(sqlitePath(file));
 try{const m=db.prepare('SELECT * FROM meta WHERE id=1').get();assert.equal(m.rootHash,t.root);assert.equal(m.journalHash,t.journalHash);assert.equal(m.sequence,t.height);}finally{db.close();}
}
function verifyCandidate(file,config,settings){
 sidecars(file);regular(file);
 const app=openIndexedSchemaApplication(file,config,settings.certificate,settings.trustedBoundary,{auditJournal:true});
 try{assert.equal(app.blocks.header.height,settings.trustedBoundary.height,'candidate must be at the exact boundary');assert.equal(app.handler.root,settings.certificate.body.targetRoot);}
 finally{app.close();}
 sidecars(file);
}
export function installIndexedSchema({home,candidate,settings,onStep=()=>{}}){
 home=fs.realpathSync(home);assertConsumerStopped(home);
 const unlock=acquireStateAccess(home),file=name=>path.join(home,name),read=name=>{regular(file(name));return JSON.parse(fs.readFileSync(file(name)));};
 try{
  const config=read('app-config.json');verifyIndexedSchemaActivation(settings,config,{isValidator:true});
  assert.equal(settings.bootstrap,false);assert(Number.isInteger(settings.readPort)&&settings.readPort>=1024&&settings.readPort<=65535,'schema read port');
  const {certificate,trustedBoundary}=settings;
  assert.deepEqual(read('indexed-schema-prepare.json'),{certificate,trustedBoundary},'local preparation differs');
  assert.deepEqual(read('indexed-schema-boundary.json'),{body:indexedSchemaReadinessBody(config,certificate,trustedBoundary),certificate,trustedBoundary},'local boundary differs');
  for(const name of ['application.sqlite','indexed-activation.json','indexed-bootstrap-pending.json'])assert(!fs.existsSync(file(name)),'incompatible installation state');
  const settingsHash=hash(settings);
  if(fs.existsSync(file(DONE))&&!fs.existsSync(file(SCHEMA_INSTALL_PENDING))){
   assert.equal(read(DONE).settingsHash,settingsHash);assert.deepEqual(read(SETTINGS),settings);assert(!fs.existsSync(file(FRESH)));
   // Do not reinstall a snapshot over a chain that may already have advanced.
   const app=openIndexedSchemaApplication(file(ACTIVE),config,certificate,trustedBoundary);app.close();
   return {status:'ALREADY_INSTALLED',certificateHash:hash(certificate)};
  }
  let record;
  if(fs.existsSync(file(SCHEMA_INSTALL_PENDING))){
   record=read(SCHEMA_INSTALL_PENDING);assert.equal(record.domain,'DUEBYTE_SCHEMA_INSTALL_V1');assert.equal(record.settingsHash,settingsHash,'installation authority changed');
  }else{
   for(const name of [BACKUP,OLD_FRESH,STAGE,SETTINGS,DONE])assert(!fs.existsSync(file(name)),'unexpected pre-existing installation artifact');
   boundary(file(ACTIVE),trustedBoundary);
   const fresh=read(FRESH);assert.equal(fresh.manifestHash,hash(fresh.manifest));assert.equal(fresh.manifest.root,trustedBoundary.genesisRoot);assert.equal(fresh.readPort,settings.readPort);
   candidate=fs.realpathSync(candidate);assert(![file(ACTIVE),file(BACKUP),file(STAGE)].some(p=>p.toLowerCase()===candidate.toLowerCase()),'separate prepared candidate required');
   requireCopySpace(home,candidate);
   verifyCandidate(candidate,config,settings);
   record={domain:'DUEBYTE_SCHEMA_INSTALL_V1',settingsHash,sourceHash:digest(file(ACTIVE)),freshHash:digest(file(FRESH)),candidateHash:digest(candidate)};
   durable(file(SCHEMA_INSTALL_PENDING),JSON.stringify(record));onStep('intent');
  }
  // A partial copy is ours only after the durable intent exists. It is never
  // installed, and the source/retained backup is checked before each mutation.
  const old=fs.existsSync(file(BACKUP))?file(BACKUP):file(ACTIVE);
  assert.equal(digest(old),record.sourceHash,'original database changed');boundary(old,trustedBoundary);
  assert.equal(digest(file(fs.existsSync(file(OLD_FRESH))?OLD_FRESH:FRESH)),record.freshHash,'original profile changed');
  const newInstalled=fs.existsSync(file(BACKUP))&&fs.existsSync(file(ACTIVE));
  if(newInstalled)assert.equal(digest(file(ACTIVE)),record.candidateHash,'installed candidate changed before completion');
  else{
   if(fs.existsSync(file(STAGE))&&digest(file(STAGE))!==record.candidateHash){fs.unlinkSync(file(STAGE));syncDirectory(home);}
   if(!fs.existsSync(file(STAGE))){
    assert.equal(digest(candidate),record.candidateHash,'prepared candidate changed');sidecars(candidate);
    requireCopySpace(home,candidate);
    fs.copyFileSync(candidate,file(STAGE),fs.constants.COPYFILE_EXCL);
    const fd=fs.openSync(file(STAGE),'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDirectory(home);
   }
   assert.equal(digest(file(STAGE)),record.candidateHash);verifyCandidate(file(STAGE),config,settings);onStep('staged');
   if(!fs.existsSync(file(BACKUP))){fs.renameSync(file(ACTIVE),file(BACKUP));syncDirectory(home);}onStep('source-retained');
   fs.renameSync(file(STAGE),file(ACTIVE));syncDirectory(home);onStep('database-installed');
  }
  if(fs.existsSync(file(FRESH))){assert(!fs.existsSync(file(OLD_FRESH)));fs.renameSync(file(FRESH),file(OLD_FRESH));syncDirectory(home);}onStep('profile-retained');
  if(fs.existsSync(file(SETTINGS)))assert.deepEqual(read(SETTINGS),settings);
  else durable(file(SETTINGS),JSON.stringify(settings));onStep('profile-installed');
  const completed={...record,certificateHash:hash(certificate)};
  if(fs.existsSync(file(DONE)))assert.deepEqual(read(DONE),completed);
  else durable(file(DONE),JSON.stringify(completed));onStep('completed');
  fs.unlinkSync(file(SCHEMA_INSTALL_PENDING));syncDirectory(home);
  return {status:'INSTALLED',certificateHash:hash(certificate),height:trustedBoundary.height,issuance:false};
 }finally{unlock();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)){
 const [home,candidate,settingsFile]=process.argv.slice(2);assert(home&&candidate&&settingsFile,'usage: indexed-schema-install HOME PREPARED_SQLITE LOCAL_ACTIVATION_JSON');
 console.log(JSON.stringify(installIndexedSchema({home,candidate,settings:JSON.parse(fs.readFileSync(settingsFile))})));
}
