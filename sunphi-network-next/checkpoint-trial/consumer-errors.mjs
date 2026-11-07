// Expose known error categories, never raw logs, credentials or filesystem paths.
import fs from 'node:fs';import path from 'node:path';
const names=['node-supervisor.log','node/application.log','node/consensus.log'];
export function nodeLogOffsets(state){return Object.fromEntries(names.map(name=>{try{return [name,fs.statSync(path.join(state,name)).size];}catch{return [name,0];}}));}
// Only a fresh, terminal CometBFT state-sync event can shorten bootstrap wait.
// Never interpret old attempts or arbitrary peer error text as a new failure.
export function bootstrapFailed(state,offsets){
 let fd;try{const name='node/consensus.log',file=path.join(state,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())return false;
  fd=fs.openSync(file,'r');const size=fs.fstatSync(fd).size,start=Math.max(size<(offsets[name]??0)?0:offsets[name]??0,size-32768),b=Buffer.alloc(Math.max(0,size-start));fs.readSync(fd,b,0,b.length,start);
  return /^E\[[^\r\n]+\] State sync failed\s+module=statesync(?:\s|$)/m.test(b.toString('utf8'));
 }catch{return false;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
export function nodeFailureMessage(state,offsets,code,signal){
 let text='';
 for(const name of names){let fd;try{
  const file=path.join(state,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())continue;
  fd=fs.openSync(file,'r');const size=fs.fstatSync(fd).size,start=Math.max(size<offsets[name]?0:offsets[name]??0,size-32768),buffer=Buffer.alloc(Math.max(0,size-start));
  fs.readSync(fd,buffer,0,buffer.length,start);text+='\n'+buffer.toString('utf8');
 }catch{}finally{if(fd!==undefined)fs.closeSync(fd);}}
 let reason='Open node-supervisor.log, node/application.log and node/consensus.log for the local startup error.';
 if(/supervisor already running or PID reused/i.test(text))reason='Another node process or a retained process lock is preventing startup. Do not delete wallet or node data.';
 else if(/EADDRINUSE|address already in use|Only one usage of each socket address/i.test(text))reason='A required local port is already in use. Close any other DueByte copy and retry.';
 else if(/ENOSPC|no space left on device|disk is full/i.test(text))reason='The disk holding node data is full. Free disk space without deleting wallet or node data, then retry.';
 else if(/EACCES|EPERM|permission denied|access is denied/i.test(text))reason='The operating system blocked access to a required node file or process.';
 else if(/old header has expired|expired\/future trust/i.test(text))reason='The saved bootstrap checkpoint has expired. Retry to request a fresh verified checkpoint.';
 else if(/stored state integrity|database disk image is malformed|SQLITE_CORRUPT/i.test(text))reason='Saved node history failed an integrity check. Keep the data for diagnosis; do not reset the wallet.';
 else if(/database is locked|SQLITE_BUSY|resource temporarily unavailable/i.test(text))reason='Another process is holding the node data. Close any other DueByte copy and retry.';
 else if(/ENOENT|could not start \(ENOENT\)/i.test(text))reason='A required node file is missing. Restore the complete verified application package; keep the saved data.';
 else if(/application startup timeout after 120 seconds/i.test(text))reason='The local history service did not become ready within two minutes. Check available disk space and application.log; keep wallet and node data.';
 const exit=Number.isInteger(code)?' Exit code: '+code+'.':typeof signal==='string'&&/^[A-Z0-9]+$/.test(signal)?' Signal: '+signal+'.':'';
 return 'The local node stopped.'+exit+' Saved history is retained. '+reason;
}
