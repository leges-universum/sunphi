// Retire only a byte-identical staging copy after durable installation.
// The original database, profile, history and backups are always retained.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {acquireStateAccess,SCHEMA_INSTALL_PENDING} from '../state-access.mjs';
const digest=file=>{
 const s=fs.lstatSync(file);assert(s.isFile()&&!s.isSymbolicLink(),'Regular file required');
 const h=createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.alloc(256*1024);
 try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null)))h.update(buffer.subarray(0,n));}finally{fs.closeSync(fd);}
 return h.digest('hex');
};
export function retireSchemaCandidate({home,directory,settingsHash,observeStopped,onStep=()=>{}}){
 assert.equal(fs.realpathSync(home),home);assert.equal(fs.realpathSync(directory),directory);
 assert(!directory.startsWith(home+path.sep)&&directory!==home,'Separate candidate directory required');
 const held=observeStopped(),unlock=acquireStateAccess(home);
 const candidate=path.join(directory,'candidate.sqlite'),intent=path.join(directory,'candidate-retirement.json');
 const sync=()=>{if(process.platform!=='win32'){const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}};
 try{
  assert(!fs.existsSync(path.join(home,SCHEMA_INSTALL_PENDING)),'Installation is incomplete');
  const doneFile=path.join(home,'indexed-schema-install.completed.json');digest(doneFile);
  const done=JSON.parse(fs.readFileSync(doneFile));assert.equal(done.domain,'DUEBYTE_SCHEMA_INSTALL_V1');assert.equal(done.settingsHash,settingsHash);
  for(const key of ['sourceHash','freshHash','candidateHash'])assert(/^[a-f0-9]{64}$/.test(done[key]));
  const record={domain:'DUEBYTE_SCHEMA_CANDIDATE_RETIREMENT_V1',settingsHash,candidateHash:done.candidateHash,sourceHash:done.sourceHash};
  if(fs.lstatSync(intent,{throwIfNoEntry:false})){digest(intent);assert.deepEqual(JSON.parse(fs.readFileSync(intent)),record,'Retirement authority changed');}
  const check=()=>{
   assert.deepEqual(observeStopped(),held,'Stop fence changed');
   assert.equal(digest(path.join(home,'application-indexed.pre-schema.sqlite')),done.sourceHash,'Original database changed');
   assert.equal(digest(path.join(home,'fresh-activation.pre-schema.json')),done.freshHash,'Original profile changed');
   assert(!fs.existsSync(path.join(home,'fresh-activation.json')));
   for(const file of [candidate,path.join(home,'application-indexed.sqlite'),path.join(home,'application-indexed.pre-schema.sqlite')]){
    for(const suffix of ['-wal','-shm','-journal'])assert(!fs.lstatSync(file+suffix,{throwIfNoEntry:false}),'SQLite sidecar still present');
   }
   assert.equal(digest(path.join(home,'application-indexed.sqlite')),done.candidateHash,'Installed database differs from staging copy');
  };
  check();
  if(!fs.lstatSync(candidate,{throwIfNoEntry:false})){
   assert(fs.existsSync(intent),'Missing candidate without retirement evidence');return {retired:true,alreadyRetired:true,bytes:0};
  }
  assert.equal(digest(candidate),done.candidateHash,'Prepared candidate changed');const bytes=fs.statSync(candidate).size;
  if(!fs.existsSync(intent)){
   const fd=fs.openSync(intent,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(record));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}sync();
  }
  onStep('intent');check();assert.equal(digest(candidate),done.candidateHash);
  // One exact regular file, in the verified separate operation directory.
  fs.unlinkSync(candidate);sync();onStep('retired');
  return {retired:true,bytes,sourceRetained:true};
 }finally{unlock();}
}
