import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,realpathSync,existsSync } from 'node:fs';
import { dirname,basename,join,resolve } from 'node:path';

export class ControllerBusyError extends Error{}

// Local filesystem only. Kernel-managed SQLite locks are released on process
// death, never stolen because a heartbeat is late or a PID appears absent.
// Lock BEFORE opening/replaying either state database. No secret state here.
export function lockController(paths){
 const names=paths.map(path=>{const p=resolve(path);mkdirSync(dirname(p),{recursive:true});return (existsSync(p)?realpathSync(p):join(realpathSync(dirname(p)),basename(p)))+'.owner-lock';});
 const held=[];
 try{for(const path of [...new Set(names)].sort()){
  const db=new DatabaseSync(path);held.push(db);
  try{db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');}
  catch(e){if(e.errcode===5||e.errcode===6)throw new ControllerBusyError('controller state is already owned');throw e;}
 }}catch(e){for(const db of held.reverse()){try{db.exec('ROLLBACK');}catch{}db.close();}throw e;}
 let closed=false;return ()=>{if(closed)return;closed=true;for(const db of held.reverse()){try{db.exec('ROLLBACK');}finally{db.close();}}};
}
