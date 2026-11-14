import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {sqlitePath} from './sqlite-path.mjs';

export const SCHEMA_INSTALL_PENDING='indexed-schema-install.pending.json';
export function assertStateInstallationComplete(home){
 assert(!fs.existsSync(path.join(home,SCHEMA_INSTALL_PENDING)),
  'schema installation is incomplete; resume the offline installation before starting this node');
}
// An OS-released SQLite lock, not a PID lease: a crash releases ownership on
// Windows and Linux, while a second application/installer cannot race recovery.
export function acquireStateAccess(home){
 const file=path.join(fs.realpathSync(home),'state-access.sqlite');
 for(const suffix of ['', '-journal','-wal','-shm'])if(fs.existsSync(file+suffix)){
  const s=fs.lstatSync(file+suffix);assert(s.isFile()&&!s.isSymbolicLink(),'regular state lock required');
 }
 const db=new DatabaseSync(sqlitePath(file));
 try{db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');}
 catch(e){db.close();throw new Error('node state is in use by another application or installer',{cause:e});}
 let closed=false;
 return ()=>{if(!closed){closed=true;db.exec('ROLLBACK');db.close();}};
}
