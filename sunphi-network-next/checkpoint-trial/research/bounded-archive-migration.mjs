// Offline bridge: immutable legacy history and a new, explicitly versioned root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {sqlitePath} from '../sqlite-path.mjs';
import {hash,hex} from '../crypto.mjs';
import {stateHash} from '../core.mjs';
import {readHistory,decodeHistoryRow} from '../history-codec.mjs';
import {verifiedHistoryScan} from './parallel-history-audit.mjs';
import {BoundedNetworkInterpreter} from './bounded-network-interpreter.mjs';
const DOMAIN='DUEBYTE_BOUNDED_LEGACY_ARCHIVE_V1';
function scan(db,visit=()=>{}){let count=0,first=null,last=null,appHash=null,digest=hash(DOMAIN);for(const row of db.prepare('SELECT height,body,root FROM blocks ORDER BY height').iterate()){if(last!==null)assert.equal(row.height,last+1,'archive gap');first??=row.height;last=row.height;appHash=row.root;digest=hash({previous:digest,height:row.height,root:row.root,bodyHash:hash(row.body)});count++;visit(row);}assert(count>0);return {count,first,last,appHash,digest};}
export function migrateBoundedArchive(sourceFile,targetFile,config,expectedAppHash,{auditReceipt,expectedHeight,onProgress,afterCopy,beforeCommit}={}){
 assert.notEqual(resolve(sourceFile),resolve(targetFile));assert(!fs.existsSync(targetFile),'fresh migration target required');hex(expectedAppHash);const source=new DatabaseSync(sqlitePath(sourceFile),{readOnly:true});let target;
 source.exec('BEGIN');try{
  const verified=auditReceipt?verifiedHistoryScan(auditReceipt,sourceFile,config,expectedAppHash):null;let previous=null,state=null,n=0;
  const summary=scan(source,row=>{if(verified)verified.row(row);else{state=decodeHistoryRow(row,state,previous);assert.equal(stateHash(state,config),row.root);}previous=row;if(++n%4096===0)onProgress?.({phase:'audit',rows:n});});verified?.finish(summary);assert.equal(summary.appHash,expectedAppHash,'archive source pin');if(expectedHeight!==undefined)assert.equal(summary.last,expectedHeight);state=readHistory(source,summary.last);assert.equal(stateHash(state,config),expectedAppHash);
  target=BoundedNetworkInterpreter.create(targetFile,state,config,expectedAppHash,{archive:{status:'PENDING',domain:DOMAIN,...summary}});target.store.db.exec('CREATE TABLE blocks(height INTEGER PRIMARY KEY,body TEXT NOT NULL,root TEXT NOT NULL)');
  target.store.transact(target.root,{domain:DOMAIN,type:'MIGRATE',source:summary},tx=>{const insert=target.store.db.prepare('INSERT INTO blocks VALUES(?,?,?)');let rows=0;const copied=scan(source,row=>{insert.run(row.height,row.body,row.root);if(++rows%4096===0)onProgress?.({phase:'copy',rows});});assert.deepEqual(copied,summary);afterCopy?.();const anchor=tx.get('meta/anchor');anchor.archive.status='READY';tx.set('meta/anchor',anchor);},{beforeCommit});
  const pin=target.root;target.close();target=null;source.exec('COMMIT');return BoundedNetworkInterpreter.open(targetFile,config,pin);
 }catch(e){target?.close();throw e;}finally{try{source.exec('ROLLBACK');}catch{}source.close();}
}
export function verifyBoundedArchive(handler){handler.store.db.exec('BEGIN');try{const m=handler.store.meta,anchor=handler.store._find({key:m.rootKey,hash:m.rootHash},'meta/anchor');assert.equal(anchor.archive?.status,'READY');const {status,domain,...expected}=anchor.archive;assert.equal(domain,DOMAIN);const result=scan(handler.store.db);assert.deepEqual(result,expected,'retained archive digest');assert.equal(result.last,anchor.height);assert.equal(result.appHash,anchor.sourceStateHash);const tip=readHistory(handler.store.db,result.last);assert.equal(stateHash(tip,handler.config),anchor.sourceStateHash);handler.store.db.exec('COMMIT');return {...result,passed:true};}catch(e){handler.store.db.exec('ROLLBACK');throw e;}}
