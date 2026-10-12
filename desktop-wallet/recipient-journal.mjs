// Local demonstration only. A durable redo record commits both holder journals.
import {readFile,open,rename,unlink,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest,publicKey} from '../wallet/crypto.mjs';
const active=new Set();
export async function serialDirectory(directory,fn){
 if(active.has(directory))throw Error('Adapter operation in progress');
 active.add(directory);try{return await fn();}finally{active.delete(directory);}
}
function validate(record){
 if(record.version!==1||!Array.isArray(record.states)||record.states.length!==2||new Set(record.states.map(s=>s.holder)).size!==2||record.checksum!==digest(record.states))throw Error('Invalid recipient transfer recovery record');
 for(const s of record.states){publicKey(s.holder);if(s.version!==1||!Number.isSafeInteger(s.sequence)||!s.keys||!Array.isArray(s.positions)||!Array.isArray(s.transactions))throw Error('Invalid holder recovery state');}
}
export async function recoverPair(directory,save){
 const path=join(directory,'recipient-transfer-pending.json');let record;
 try{if((await stat(path)).size>34*1024*1024)throw Error('Recipient recovery record too large');record=JSON.parse(await readFile(path,'utf8'));}
 catch(e){if(e.code==='ENOENT')return;throw e;}
 validate(record);
 for(const s of record.states)await save(join(directory,digest({holder:s.holder})+'.json'),s);
 await unlink(path);
}
export async function commitPair(directory,states,save,failpoint=()=>{}){
 const record={version:1,states,checksum:digest(states)};validate(record);
 const path=join(directory,'recipient-transfer-pending.json'),temp=path+'.'+randomUUID()+'.tmp';
 const h=await open(temp,'wx',0o600);
 try{await h.writeFile(JSON.stringify(record));await h.sync();}finally{await h.close();}
 try{await rename(temp,path);}catch(e){await unlink(temp).catch(()=>{});throw e;}
 await failpoint('after-intent');
 await save(join(directory,digest({holder:states[0].holder})+'.json'),states[0]);
 await failpoint('after-source');
 await save(join(directory,digest({holder:states[1].holder})+'.json'),states[1]);
 await failpoint('after-destination');
 await unlink(path);
}
