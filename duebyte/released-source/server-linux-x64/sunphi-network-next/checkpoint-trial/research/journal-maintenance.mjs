import fs from 'node:fs';
import {compactJournalBatch,WRITE_COMPRESSED_JOURNAL} from './journal-codec.mjs';
// Runs between event-loop tasks; never another writable connection/thread.
// Pause while WAL readers prevent reclamation instead of forcing their leases off.
export function startJournalMaintenance(store,{enabled=WRITE_COMPRESSED_JOURNAL,interval=1000,walLimit=32*1024*1024,onError=()=>{},onProgress=()=>{}}={}){
 if(!enabled)return ()=>{};
 let cursor=0,stopped=false;
 const timer=setInterval(()=>{
  if(stopped)return;
  try{
   let wal=0;try{wal=fs.statSync(store.file+'-wal').size;}catch{}
   if(wal>walLimit){const p=store.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();if(p.log>p.checkpointed)return;}
   const r=compactJournalBatch(store.db,{after:cursor,rows:16,bytes:2*1024*1024});cursor=r.after;
   // Preserve the normal bounded lease/WAL bookkeeping after physical writes.
   if(r.changed)for(const observe of store.commitObservers)observe();
   onProgress(r);
   if(r.rows===0){stopped=true;clearInterval(timer);}
  }catch(error){stopped=true;clearInterval(timer);onError(error);}
 },interval);timer.unref();return ()=>{stopped=true;clearInterval(timer);};
}
