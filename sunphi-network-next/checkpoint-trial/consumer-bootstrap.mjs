// Refresh bootstrap trust only for an empty, stopped, non-voting consumer.
// Never delete/replay a database or replace a key, wallet, or committed history.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import {randomUUID} from 'node:crypto';
import {verifyCheckpoint} from './checkpoint.mjs';import {hash} from './crypto.mjs';import {origin,stateHash} from './core.mjs';
export function refreshConsumerBootstrap(home,config,policy,checkpoint){
 const read=name=>JSON.parse(fs.readFileSync(path.join(home,name)));
 assert.equal(read('run-settings.json').isValidator,false,'bootstrap refresh is only for non-voting consumers');
 const lock=path.join(home,'supervisor.lock');
 if(fs.existsSync(lock)){
  const pid=Number(fs.readFileSync(lock,'utf8'));assert(Number.isSafeInteger(pid)&&pid>0,'invalid supervisor lock');
  try{process.kill(pid,0);return {changed:false,reason:'supervisor active or identity unconfirmed'};}catch(e){if(e.code!=='ESRCH')throw e;}
 }
 const file=path.join(home,'application.sqlite');
 if(fs.existsSync(file)){
  const db=new DatabaseSync(file,{readOnly:true});
  try{const row=db.prepare('SELECT height,body,root FROM blocks ORDER BY height DESC LIMIT 1').get();assert(row,'missing retained state');
   const state=JSON.parse(row.body);assert.equal(state.height,row.height);assert.equal(stateHash(state,config),row.root,'stored state integrity');
   if(row.height>0)return {changed:false,reason:'committed history retained'};
   assert.equal(hash(state),hash(origin(config)),'bootstrap requires unchanged genesis state');
  }finally{db.close();}
 }else assert(!fs.existsSync(path.join(home,'data/state.db'))&&!fs.existsSync(path.join(home,'data/blockstore.db')),'missing application database beside consensus history');
 const previous=read('checkpoint.json');
 // Authenticate the retained anchor at its original issuance time, then require
 // a fresh quorum-approved descendant, including the existing policy lineage.
 verifyCheckpoint(previous,policy,{now:previous.body.issuedAt,configHash:hash(config)});
 verifyCheckpoint(checkpoint,policy,{previous,allowGap:true,configHash:hash(config)});
 const toml=path.join(home,'config/config.toml'),before=fs.readFileSync(toml,'utf8');
 assert.equal((before.match(/^trust_height = .*$/gm)??[]).length,1);assert.equal((before.match(/^trust_hash = .*$/gm)??[]).length,1);
 const after=before.replace(/^trust_height = .*$/m,'trust_height = '+checkpoint.body.height).replace(/^trust_hash = .*$/m,'trust_hash = "'+checkpoint.body.blockHash.toUpperCase()+'"');
 if(hash(previous)===hash(checkpoint)&&before===after)return {changed:false,reason:'current bootstrap anchor'};
 const suffix='.'+randomUUID()+'.pending',checkpointFile=path.join(home,'checkpoint.json'),cpTemp=checkpointFile+suffix,tomlTemp=toml+suffix;
 fs.writeFileSync(cpTemp,JSON.stringify(checkpoint,null,2),{flag:'wx',mode:0o600});fs.writeFileSync(tomlTemp,after,{flag:'wx',mode:0o600});
 // A crash between renames is safe: the next run checks and completes both files.
 fs.renameSync(cpTemp,checkpointFile);fs.renameSync(tomlTemp,toml);
 return {changed:true,from:previous.body.height,to:checkpoint.body.height};
}
