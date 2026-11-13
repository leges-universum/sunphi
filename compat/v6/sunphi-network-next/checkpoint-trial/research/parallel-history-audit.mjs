// Offline audit workers. Capabilities are process-local, never caller receipts.
import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';import {availableParallelism} from 'node:os';import {resolve} from 'node:path';
import {stateHash,validateConfig} from '../core.mjs';import {decodeHistoryRow,readHistory} from '../history-codec.mjs';import {hash} from '../crypto.mjs';
const certificates=new WeakMap(),seed=(first,last)=>hash({domain:'DUEBYTE_HISTORY_AUDIT_CHUNK_V1',first,last}),step=(previous,row,bodyHash=hash(row.body))=>hash({previous,height:row.height,root:row.root,bodyHash});
if(!isMainThread&&workerData?.domain==='DUEBYTE_HISTORY_AUDIT_WORKER_V1'){
 const {file,config}=workerData,db=new DatabaseSync(file,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=3000;');
 parentPort.on('message',task=>{if(task.shutdown){db.close();parentPort.close();return;}try{db.exec('BEGIN');const prior=db.prepare('SELECT height,root FROM blocks WHERE height<? ORDER BY height DESC LIMIT 1').get(task.first);let previous=prior??null,state=prior?readHistory(db,prior.height):null,count=0,digest=seed(task.first,task.last);if(state)assert.equal(stateHash(state,config),prior.root);
  for(const row of db.prepare('SELECT height,body,root FROM blocks WHERE height>=? AND height<=? ORDER BY height').iterate(task.first,task.last)){state=decodeHistoryRow(row,state,previous);assert.equal(stateHash(state,config),row.root,'chunk state audit');digest=step(digest,row);count++;previous=row;}
  db.exec('COMMIT');parentPort.postMessage({id:task.id,first:task.first,last:task.last,count,digest});
 }catch(e){try{db.exec('ROLLBACK');}catch{}parentPort.postMessage({id:task.id,error:e.message});}});
}
export async function auditHistoryParallel(file,config,expectedAppHash,{workers=Math.min(4,Math.max(1,availableParallelism()-2)),chunkRows=2048,onProgress}={}){
 assert(isMainThread);assert(Number.isSafeInteger(workers)&&workers>=1&&workers<=8);assert(Number.isSafeInteger(chunkRows)&&chunkRows>=16&&chunkRows<=8192);const configHash=validateConfig(config),db=new DatabaseSync(file,{readOnly:true});let first,last;
 try{first=db.prepare('SELECT height FROM blocks ORDER BY height LIMIT 1').get()?.height;last=db.prepare('SELECT height,root FROM blocks ORDER BY height DESC LIMIT 1').get();assert(first!==undefined&&last);assert.equal(last.root,expectedAppHash,'parallel source pin');}finally{db.close();}
 const tasks=Array.from({length:Math.ceil((last.height-first+1)/chunkRows)},(_,id)=>({id,first:first+id*chunkRows,last:Math.min(last.height,first+(id+1)*chunkRows-1)})),results=new Array(tasks.length),pool=[];let cursor=0,completed=0,rows=0,stopping=false;
 try{await Promise.all(Array.from({length:Math.min(workers,tasks.length)},()=>new Promise((ok,fail)=>{
  const worker=new Worker(new URL(import.meta.url),{workerData:{domain:'DUEBYTE_HISTORY_AUDIT_WORKER_V1',file:resolve(file),config}});pool.push({worker,exited:new Promise(done=>worker.once('exit',done))});let settled=false;
  const next=()=>{if(cursor===tasks.length){settled=true;ok();return;}worker.postMessage(tasks[cursor++]);};
  worker.on('error',fail);worker.on('exit',code=>{if(!settled)fail(Error('audit worker stopped '+code));});worker.on('message',result=>{if(stopping)return;try{if(result.error)throw Error(result.error);assert(!results[result.id]);results[result.id]=result;rows+=result.count;completed++;onProgress?.({phase:'parallel-audit',completed,chunks:tasks.length,rows});next();}catch(e){fail(e);}});next();
 })));
 }finally{stopping=true;for(const {worker} of pool)worker.postMessage({shutdown:true});await Promise.all(pool.map(p=>p.exited));}
 assert.equal(completed,tasks.length);assert(Array.from(results).every(Boolean));const token=Object.freeze({});certificates.set(token,{file:resolve(file),configHash,appHash:expectedAppHash,first,last:last.height,chunkRows,results});return token;
}
export function verifiedHistoryScan(token,file,config,expectedAppHash){
 const cert=certificates.get(token);assert(cert,'untrusted history audit capability');assert.equal(cert.file,resolve(file));assert.equal(cert.configHash,hash(config));assert.equal(cert.appHash,expectedAppHash);
 let index=0,count=0,digest=seed(cert.results[0].first,cert.results[0].last),total=0,previous=-1;
 const finishChunk=()=>{const expected=cert.results[index];assert.equal(count,expected.count,'audited chunk row count');assert.equal(digest,expected.digest,'audited chunk changed');index++;count=0;if(index<cert.results.length)digest=seed(cert.results[index].first,cert.results[index].last);};
 return {row(row,bodyHash){assert(row.height>previous&&row.height>=cert.first&&row.height<=cert.last,'audited height order');while(row.height>cert.results[index].last)finishChunk();digest=step(digest,row,bodyHash);count++;total++;previous=row.height;},finish(summary){while(index<cert.results.length)finishChunk();assert.equal(summary.count,total);assert.equal(summary.first,cert.first);assert.equal(summary.last,cert.last);assert.equal(summary.appHash,cert.appHash);}};
}
