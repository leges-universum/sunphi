import {parentPort,workerData} from 'node:worker_threads';
import fs from 'node:fs';
import {join} from 'node:path';
import {preflightArchive,preflightJournalTerms} from './archive-preflight.mjs';
import {ArchiveAuditSession} from './archive-audit-session.mjs';
import {IndexedSnapshotReceiver} from './indexed-snapshot.mjs';
let last=0;
const progress=value=>{if(Date.now()-last>=500){last=Date.now();parentPort.postMessage({progress:value});}},directory=join(workerData.home,'indexed-incoming','.archive-validation');fs.mkdirSync(directory,{recursive:true,mode:0o700});
// The parent holds the exclusive application-state lock. These files contain
// only obsolete ephemeral validation receipts, never history objects or keys.
if(fs.lstatSync(directory).isSymbolicLink())throw Error('validation directory link');
const entries=fs.opendirSync(directory);let cleaned=0;try{for(let entry;(entry=entries.readSync());){if(++cleaned>128)throw Error('validation cleanup limit');if(!/^archive-validation-[a-f0-9-]{36}\.sqlite$/.test(entry.name))throw Error('unexpected validation file retained');const file=join(directory,entry.name);if(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink())throw Error('validation file type');fs.unlinkSync(file);}}finally{entries.closeSync();}
const cache=new ArchiveAuditSession(join(workerData.home,'application-indexed.sqlite'),preflightJournalTerms(workerData.profile),{directory,onProgress:progress});let busy=false;
parentPort.on('message',async message=>{if(busy)throw Error('overlapping archive preparation');if(message.operation==='close'){cache.close();parentPort.close();return;}busy=true;
 try{let result;if(message.operation==='prepare')result=await preflightArchive(workerData.home,workerData.profile,{archiveAudit:cache,stateOwned:true,onProgress:progress});else if(message.operation==='install')result=await new IndexedSnapshotReceiver(message.receiver).installWithArchives({archiveAudit:cache,onProgress:progress});else throw Error('unknown preparation operation');parentPort.postMessage({id:message.id,result});}
 catch(e){parentPort.postMessage({id:message.id,error:e.message});}finally{busy=false;}
});
