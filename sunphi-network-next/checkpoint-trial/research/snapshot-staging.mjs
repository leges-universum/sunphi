// An uninstalled, exclusively owned receiver may discard superseded snapshot
// chunks and unpublished assembly files. Durable history objects live beside
// the FINAL database and are deliberately outside this directory.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',temporary=new RegExp('^(?:assembled|catalogue|preflight)-'+uuid+'\\.sqlite(?:-wal|-shm|-journal)?$'),links=new RegExp('^assembled-'+uuid+'\\.sqlite\\.history$');
function directory(file){const s=fs.lstatSync(file);assert(s.isDirectory()&&!s.isSymbolicLink(),'snapshot staging directory type');}
function unlink(file){const s=fs.lstatSync(file);assert(s.isFile()&&!s.isSymbolicLink(),'snapshot staging file type');fs.unlinkSync(file);}
export function cleanSnapshotCandidates(home,{keep,onProgress=()=>{}}){
 assert(path.isAbsolute(home)&&/^[a-f0-9]{64}$/.test(keep));assert(!fs.existsSync(path.join(home,'application-indexed.sqlite')),'active state cannot be cleaned by receiver');
 const root=path.join(home,'indexed-incoming');if(!fs.existsSync(root))return;directory(root);const entries=fs.opendirSync(root);let removed=0;
 try{for(let entry;(entry=entries.readSync());){
  if(entry.name==='.archive-validation')continue;
  assert(/^[a-f0-9]{64}$/.test(entry.name),'unknown snapshot staging entry retained');const candidate=path.join(root,entry.name);directory(candidate);const files=fs.opendirSync(candidate);
  try{for(let file;(file=files.readSync());){const name=path.join(candidate,file.name),chunk=/^(?:0|[1-9][0-9]{0,5})\.json$/.test(file.name),pending=/^(?:0|[1-9][0-9]{0,5})\.json\.pending$/.test(file.name);
   if(chunk&&entry.name===keep)continue;
   if(chunk||pending||temporary.test(file.name))unlink(name);
   else if(links.test(file.name)){directory(name);const objects=fs.opendirSync(name);try{for(let object;(object=objects.readSync());){assert(/^[a-f0-9]{64}\.sqlite$/.test(object.name),'unknown assembly link retained');unlink(path.join(name,object.name));if(++removed%128===0)onProgress({phase:'cleaning-snapshot-staging',removed});}}finally{objects.closeSync();}fs.rmdirSync(name);}
   else throw Error('unknown snapshot staging file retained');
   if(++removed%128===0)onProgress({phase:'cleaning-snapshot-staging',removed});
  }}finally{files.closeSync();}
  if(entry.name!==keep)fs.rmdirSync(candidate);
 }}finally{entries.closeSync();}
 if(process.platform!=='win32'){const fd=fs.openSync(root,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 return {removed};
}
