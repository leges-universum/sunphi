// Only unpublished temporary files live here. Immutable objects and resumable
// references stay in the archive directory and are never removed by this helper.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const UUID='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const temporary=new RegExp('^(?:\\.pending-'+UUID+'\\.sqlite(?:-journal)?|\\.rebuild-'+UUID+'\\.sqlite(?:-journal)?|\\.download-'+UUID+'\\.pending|\\.reference-[a-f0-9]{64}\\.'+UUID+'\\.pending)$');
function sync(dir){if(process.platform==='win32')return;const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
export function archiveStaging(directory){
 const dir=path.join(directory,'.staging');if(!fs.existsSync(dir)){fs.mkdirSync(dir,{mode:0o700});sync(directory);}const s=fs.lstatSync(dir);assert(s.isDirectory()&&!s.isSymbolicLink(),'archive staging directory type');return dir;
}
// Call only after acquiring the node's exclusive state-access lock and before
// starting any receiver/maintenance worker. Bound work even after repeated kills.
export function cleanArchiveStaging(file,{limit=128}={}){
 assert(path.isAbsolute(file));assert(Number.isSafeInteger(limit)&&limit>0&&limit<=1024);
 const directory=file+'.history';if(!fs.existsSync(directory))return {removed:0};assert(!fs.lstatSync(directory).isSymbolicLink());
 const staging=path.join(directory,'.staging');if(!fs.existsSync(staging))return {removed:0};assert(fs.lstatSync(staging).isDirectory()&&!fs.lstatSync(staging).isSymbolicLink());
 let removed=0,scanned=0;const dir=fs.opendirSync(staging);try{for(let entry;(entry=dir.readSync())&&scanned++<limit;){assert(temporary.test(entry.name),'unknown archive staging entry retained');const name=path.join(staging,entry.name),s=fs.lstatSync(name);assert(s.isFile()&&!s.isSymbolicLink(),'unexpected archive staging type retained');fs.unlinkSync(name);removed++;}}finally{dir.closeSync();}if(removed)sync(staging);return {removed};
}
