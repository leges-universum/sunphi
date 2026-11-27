import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {commitArchiveSegment} from './journal-segment.mjs';
export const ARCHIVE_STORAGE='immutable-journal-v1';
export function startArchiveMaintenance(store,{enabled=false,interval=5000,rows=256,rawBytes=16*1024*1024,onError=()=>{},onProgress=()=>{}}={}){
 if(!enabled)return ()=>{};assert.equal(process.platform,'linux');assert(Number.isSafeInteger(rows)&&rows>=16&&rows<=1024);assert(Number.isSafeInteger(rawBytes)&&rawBytes>=1024*1024&&rawBytes<=64*1024*1024);
 let worker=null,stopped=false;
 const stop=()=>{stopped=true;clearInterval(timer);void worker?.terminate();};
 const timer=setInterval(()=>{if(stopped||worker||store.cache)return;
  try{const previous=store.journal.hasSegments()?store.db.prepare('SELECT last FROM journal_segments ORDER BY first DESC LIMIT 1').get()?.last??0:0,through=store.meta.sequence-64;
   // Seal regular batches, not one tiny file on every new block.
   if(through-previous<rows)return;let wal=0;try{wal=fs.statSync(store.file+'-wal').size;}catch{}if(wal>32*1024*1024){const c=store.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();if(c.log>c.checkpointed)return;}
   worker=new Worker(new URL('./archive-maintenance-worker.mjs',import.meta.url),{workerData:{file:path.resolve(store.file),through,rows,rawBytes},resourceLimits:{maxOldGenerationSizeMb:256}});let prepared;
   const timeout=setTimeout(()=>{stop();onError(Error('archive preparation timeout; committed history retained'));},60000);
   worker.once('message',value=>{prepared=value;});worker.once('error',e=>{stop();onError(e);});worker.once('exit',code=>{clearTimeout(timeout);worker=null;if(stopped)return;try{assert.equal(code,0);assert(prepared?.entry,'archive worker result missing');const result=commitArchiveSegment(store,prepared);for(const observer of store.commitObservers)observer();onProgress(result);}catch(e){stop();onError(e);}});
  }catch(e){stop();onError(e);}
 },interval);timer.unref();return stop;
}
