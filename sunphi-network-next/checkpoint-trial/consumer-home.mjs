// Resolve only fixed, locally recorded homes; never accept a path from a peer.
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
export function consumerNodeDirectory(state){
 const file=join(state,'installation.json');
 const name=existsSync(file)?JSON.parse(readFileSync(file)).nodeDirectory??'node':'node';
 assert(['node','node-indexed-v6','node-fresh-v1'].includes(name),'invalid consumer node directory');return name;
}
export const consumerNodeHome=state=>join(state,consumerNodeDirectory(state));
export function assertConsumerStopped(home){
 const lock=join(home,'supervisor.lock');if(!existsSync(lock))return;
 const pid=Number(readFileSync(lock,'utf8'));assert(Number.isSafeInteger(pid)&&pid>0,'invalid supervisor lock');
 try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')return;throw e;}
 throw Error('Stop the existing node before changing its storage profile. Saved files are retained.');
}
