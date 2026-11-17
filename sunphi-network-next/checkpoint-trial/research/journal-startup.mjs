import assert from 'node:assert/strict';
import {hash,exact,integer,hex} from '../crypto.mjs';
import {RECORD_DOMAIN,EMPTY} from './record-proof.mjs';
import {decodeJournal} from './journal-codec.mjs';
import {isArchiveAuditSession} from './archive-audit-session.mjs';
export const RESTART_JOURNAL_ROWS=64;

export function verifyRetainedRow(row,body,{parent,previous,sequence,bridge=null}){
 exact(body,['domain','sequence','parent','root','previousJournal','event','changes']);
 assert.equal(body.domain,RECORD_DOMAIN+'/JOURNAL');assert.equal(row.sequence,sequence);assert.equal(row.parent,parent);assert.equal(body.sequence,sequence);assert.equal(body.parent,parent);assert.equal(body.root,row.root);assert.equal(body.previousJournal,previous);assert.equal(hash(body),row.digest);assert(Array.isArray(body.changes));
 if(sequence===bridge?.sequence){for(const k of ['parent','root','digest'])assert.equal(row[k],bridge[k]);assert.equal(previous,bridge.previousJournal);assert.deepEqual(body.event,bridge.event);}
 else{assert.equal(body.event.height,sequence-(bridge&&sequence>bridge.sequence?1:0));assert.equal(body.event.filter,false);}
}

// Current state is authenticated on access and reconciled by consensus. This is
// a local suffix check, not proof that all archived bytes remain intact. Imports
// and recovery require full=true before accepting an unfamiliar database.
export function verifyRetainedJournal(handler,{genesisRoot,bridge=null},{full=false,archiveAudit=null}={}){
 assert(!archiveAudit||(full&&isArchiveAuditSession(archiveAudit)),'live archive audit session required');
 const journal=handler.store.journal,m=handler.store.meta,bridgeSequence=bridge?.sequence;
 integer(m.sequence,bridgeSequence??0);hex(m.journalHash);
 assert.equal(handler.networkHeader().height,m.sequence-(bridge?1:0));
 if(bridge){const row=journal.header(bridgeSequence);assert(row,'missing schema bridge');for(const key of ['sequence','parent','root','digest'])assert.equal(row[key],bridge[key],'changed schema bridge');}
 const last=journal.head();
 if(m.sequence===0){assert(!last);assert.equal(handler.root,genesisRoot);assert.equal(m.journalHash,EMPTY);return {rows:0,full};}
 assert.equal(last?.sequence,m.sequence);
 let start=full?1:Math.max(1,m.sequence-RESTART_JOURNAL_ROWS+1);
 let sequence=start-1,parent=genesisRoot,previous=EMPTY;
 if(full&&archiveAudit){
  for(const entry of journal.segments()){
   assert.equal(entry.first,sequence+1,'archive prefix gap');assert.equal(entry.parent,parent);assert.equal(entry.previous,previous);
   archiveAudit.verify(entry,{genesisRoot,bridge});sequence=entry.last;parent=entry.root;previous=entry.digest;
  }
  start=sequence+1;
 }
 if(start>1&&!archiveAudit){const prior=journal.header(start-1);assert(prior,'missing journal predecessor');hex(prior.root);hex(prior.digest);parent=prior.root;previous=prior.digest;}
 for(const row of journal.headers({from:start,to:m.sequence})){
  assert.equal(row.sequence,++sequence);assert.equal(row.parent,parent);
  const isBridge=sequence===bridgeSequence;
  if(isBridge)assert.equal(previous,bridge.previousJournal);
  // The conversion write-set may be population-sized; inspect it only offline.
  if(!isBridge||full){
   const body=decodeJournal(journal.get(sequence,{offlineLegacy:true}).body);
   verifyRetainedRow(row,body,{parent,previous,sequence,bridge});
  }
  parent=row.root;previous=row.digest;
 }
 assert.equal(sequence,m.sequence,'missing journal tail');assert.equal(parent,handler.root);assert.equal(previous,m.journalHash);
 return {rows:sequence-start+1,full};
}
