// Signed transport and staging only. Never changes active profiles or ledger state.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Updater} from 'tuf-js';
import {hash,hex,exact,integer} from './crypto.mjs';
import {loadRelease,readJSON,sha256,versionCompare} from './update-core.mjs';
import {validateConsumerProfile} from './consumer-profile.mjs';
const TARGET='home-indexed-profile.json';
export function validateTransitionDelivery(body,release,original,now=Math.floor(Date.now()/1000)){
 exact(body,['domain','sequence','fromProfileHash','toProfileHash','minimumVersion','issuedAt','expiresAt','profile']);
 assert.equal(body.domain,'DUEBYTE_HOME_PROFILE_DELIVERY_V1');integer(body.sequence,1);hex(body.fromProfileHash);hex(body.toProfileHash);
 assert.equal(release.edition,'home','Home profile required');assert.equal(body.fromProfileHash,release.networkPin,'profile predecessor');
 validateConsumerProfile(original,release.networkPin);validateConsumerProfile(body.profile,body.toProfileHash);
 assert(body.profile.indexed,'indexed transition required');assert.equal(body.profile.indexed.previousProfileHash,body.fromProfileHash);
 assert(versionCompare(body.minimumVersion,'0.3.42')>=0,'profile delivery support required');assert(versionCompare(release.version,body.minimumVersion)>=0,'newer software required');
 integer(body.issuedAt,1);integer(body.expiresAt,1);integer(now,1);
 assert(body.issuedAt<=now+30&&body.expiresAt>now&&body.expiresAt>body.issuedAt&&body.expiresAt-body.issuedAt<=7*86400,'expired/future profile');
 for(const name of ['config','genesis','policy','rpcServers','workers','basePort','walletPort'])assert.equal(hash(body.profile[name]),hash(original[name]),'profile must retain '+name);
 return body;
}
function durable(file,value){
 const temp=file+'.'+randomUUID()+'.pending',fd=fs.openSync(temp,'wx',0o600);
 try{fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);
 if(process.platform!=='win32'){const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
}
function lock(directory){
 // OS-backed SQLite locking is released on process death; no stale PID file
 // or racy stale-lock deletion can admit two concurrent catalog writers.
 const db=new DatabaseSync(path.join(directory,'delivery.sqlite'));
 try{db.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS delivery_lock(id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;');}
 catch(e){db.close();throw e;}return ()=>{try{db.exec('ROLLBACK');}finally{db.close();}};
}
export async function stageTransitionProfile({root,state,urls,fetcher}){
 const release=loadRelease(root),original=readJSON(path.join(root,'connection-profile.json'));
 assert.equal(readJSON(path.join(root,'connection-pin.json')).sha256,release.networkPin);validateConsumerProfile(original,release.networkPin);
 assert.equal(release.edition,'home');assert(versionCompare(release.version,'0.3.42')>=0,'profile delivery support required');
 const directory=path.join(state,'updates','profiles');fs.mkdirSync(directory,{recursive:true,mode:0o700});const unlock=lock(directory);
 const download=path.join(directory,randomUUID()+'.download');
 try{
  const metadata=path.join(directory,'metadata');fs.mkdirSync(metadata,{recursive:true,mode:0o700});
  const trust=path.join(metadata,'root.json');if(!fs.existsSync(trust))fs.copyFileSync(path.join(root,'update-root.json'),trust,fs.constants.COPYFILE_EXCL);
  const updater=new Updater({metadataDir:metadata,metadataBaseUrl:urls?.metadata??release.metadataUrl,targetBaseUrl:urls?.targets??release.targetsUrl,targetDir:directory,fetcher,config:{maxRootRotations:32,maxDelegations:8,rootMaxLength:262144,timestampMaxLength:32768,snapshotMaxLength:262144,targetsMaxLength:1048576,fetchTimeout:15000,fetchRetries:1,prefixTargetsWithHash:false}});
  await updater.refresh();const target=await updater.getTargetInfo(TARGET);assert(target&&target.length>0&&target.length<=16*1048576&&/^[a-f0-9]{64}$/.test(target.hashes.sha256),'profile target missing or oversized');
  await updater.downloadTarget(target,download);
  const body=validateTransitionDelivery(readJSON(download),release,original),digest=sha256(fs.readFileSync(download));assert.equal(digest,target.hashes.sha256);
  const binding=path.join(state,'installation.json');if(fs.existsSync(binding)){const installed=readJSON(binding);assert.equal(installed.network,original.config.chainId);assert([body.fromProfileHash,body.toProfileHash].includes(installed.profileHash),'unrelated installed profile');}
  const receiptFile=path.join(directory,'highest.json'),previous=fs.existsSync(receiptFile)?readJSON(receiptFile):null;
  if(previous){assert(body.sequence>=previous.sequence,'profile sequence rollback');if(body.sequence===previous.sequence)assert.equal(digest,previous.sha256,'changed profile at same sequence');}
  const file=path.join(directory,digest+'.json');
  if(fs.existsSync(file))assert.equal(sha256(fs.readFileSync(file)),digest,'stored profile damaged');
  else{
   // Retain exact signed bytes, including whitespace. The verified download
   // becomes visible atomically before its durable high-water receipt.
   const fd=fs.openSync(download,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(download,file);
   if(process.platform!=='win32'){const dir=fs.openSync(directory,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
  }
  assert.equal(sha256(fs.readFileSync(file)),digest);
  const receipt={schema:1,sequence:body.sequence,sha256:digest,fromProfileHash:body.fromProfileHash,toProfileHash:body.toProfileHash,expiresAt:body.expiresAt,status:'STAGED_COORDINATED_TRANSITION_REQUIRED',active:false,issuance:false};
  durable(receiptFile,receipt);return {...receipt,file};
 }finally{if(fs.existsSync(download))fs.unlinkSync(download);unlock();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)){
 const [root,state]=process.argv.slice(2);assert(root&&state,'usage: profile-delivery.mjs APPLICATION_ROOT STATE_DIRECTORY');
 const r=await stageTransitionProfile({root:path.resolve(root),state:path.resolve(state)});console.log(JSON.stringify({status:r.status,sequence:r.sequence,sha256:r.sha256,active:false,issuance:false}));
}
