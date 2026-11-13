import assert from 'node:assert/strict';
import {hash,exact,integer,hex} from '../crypto.mjs';
import {RECORD_DOMAIN,EMPTY} from './record-proof.mjs';
export const RESTART_JOURNAL_ROWS=64;

// Current state is authenticated on access and reconciled by consensus. This is
// a local suffix check, not proof that all archived bytes remain intact. Imports
// and recovery require full=true before accepting an unfamiliar database.
export function verifyRetainedJournal(handler,{genesisRoot,bridge=null},{full=false}={}){
 const db=handler.store.db,m=handler.store.meta,bridgeSequence=bridge?.sequence;
 integer(m.sequence,bridgeSequence??0);hex(m.journalHash);
 assert.equal(handler.networkHeader().height,m.sequence-(bridge?1:0));
 if(bridge){const row=db.prepare('SELECT sequence,parent,root,digest FROM journal WHERE sequence=?').get(bridgeSequence);assert(row,'missing schema bridge');for(const key of ['sequence','parent','root','digest'])assert.equal(row[key],bridge[key],'changed schema bridge');}
 const last=db.prepare('SELECT sequence FROM journal ORDER BY sequence DESC LIMIT 1').get();
 if(m.sequence===0){assert(!last);assert.equal(handler.root,genesisRoot);assert.equal(m.journalHash,EMPTY);return {rows:0,full};}
 assert.equal(last?.sequence,m.sequence);
 const start=full?1:Math.max(1,m.sequence-RESTART_JOURNAL_ROWS+1);
 let sequence=start-1,parent=genesisRoot,previous=EMPTY;
 if(start>1){const prior=db.prepare('SELECT root,digest FROM journal WHERE sequence=?').get(start-1);assert(prior,'missing journal predecessor');hex(prior.root);hex(prior.digest);parent=prior.root;previous=prior.digest;}
 for(const row of db.prepare('SELECT sequence,parent,root,digest FROM journal WHERE sequence>=? AND sequence<=? ORDER BY sequence').iterate(start,m.sequence)){
  assert.equal(row.sequence,++sequence);assert.equal(row.parent,parent);
  const isBridge=sequence===bridgeSequence;
  if(isBridge)assert.equal(previous,bridge.previousJournal);
  // The conversion write-set may be population-sized; inspect it only offline.
  if(!isBridge||full){
   const body=JSON.parse(db.prepare('SELECT body FROM journal WHERE sequence=?').get(sequence).body);
   exact(body,['domain','sequence','parent','root','previousJournal','event','changes']);
   assert.equal(body.domain,RECORD_DOMAIN+'/JOURNAL');assert.equal(body.sequence,sequence);assert.equal(body.parent,parent);assert.equal(body.root,row.root);assert.equal(body.previousJournal,previous);assert.equal(hash(body),row.digest);assert(Array.isArray(body.changes));
   if(isBridge)assert.deepEqual(body.event,bridge.event);
   else{assert.equal(body.event.height,sequence-(bridge&&sequence>bridgeSequence?1:0));assert.equal(body.event.filter,false);}
  }
  parent=row.root;previous=row.digest;
 }
 assert.equal(sequence,m.sequence,'missing journal tail');assert.equal(parent,handler.root);assert.equal(previous,m.journalHash);
 return {rows:sequence-start+1,full};
}
