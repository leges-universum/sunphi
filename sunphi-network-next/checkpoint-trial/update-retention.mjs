// Only reproducible updater-owned files are eligible. Wallet/history are outside
// this namespace. Unknown files, links and incomplete launch scans fail closed.
import nodeFs from 'node:fs';
const fs=process.versions.electron?(await import('original-fs')).default:nodeFs;
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
const folder=/^DueByte-Home-\d+\.\d+\.\d+-(Windows|Linux)-x64$/;
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
function direct(root,name){assert(folder.test(name),'Unexpected package name');const p=path.resolve(root,name);assert(same(path.dirname(p),root));assert(!fs.lstatSync(p).isSymbolicLink(),'Linked package');return p;}
async function digest(file){const h=createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex');}
export async function packageInventory(top){
 const files=[];const walk=(dir,prefix='')=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){assert(!e.isSymbolicLink(),'Linked package content');const p=path.join(dir,e.name),name=prefix+e.name;if(e.isDirectory())walk(p,name+'/');else{assert(e.isFile());assert(files.length<20000);files.push({name,bytes:fs.statSync(p).size});}}};walk(top);
 for(const f of files)f.sha256=await digest(path.join(top,f.name));return files.sort((a,b)=>a.name.localeCompare(b.name));
}
export async function recordPackageInventory(state,record,expected,artifact){
 const dir=path.join(state,'updates/package-inventory');fs.mkdirSync(dir,{recursive:true});
 const top=direct(path.join(state,'updates/releases'),record.descriptor.folder);assert(same(top,record.top));
 const files=await packageInventory(top);assert(expected,'Fresh signed extraction inventory required');assert.deepEqual(files,expected,'Installed package differs from signed archive');
 const value={schema:1,version:record.descriptor.version,descriptorSha256:record.descriptorSha256,files,...(artifact?{archive:{name:record.descriptor.artifact,bytes:artifact.length,sha256:artifact.hashes.sha256}}:{})};
 const file=path.join(dir,record.descriptor.folder+'.json'),temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(value),{mode:0o600});fs.renameSync(temp,file);
}
export function runningAndLaunchPaths(){
 if(process.platform!=='win32'){
  const paths=[];for(const pid of fs.readdirSync('/proc').filter(s=>/^\d+$/.test(s))){try{paths.push(fs.readlinkSync('/proc/'+pid+'/exe'));}catch(e){if(!['ENOENT','EACCES','EPERM'].includes(e.code))throw e;}}
  // Linux Home has no managed desktop launcher today. Preserve any manually
  // installed desktop entries that refer to the release directory.
  for(const dir of [path.join(process.env.HOME??'','/.local/share/applications'),'/usr/share/applications'])if(fs.existsSync(dir))for(const n of fs.readdirSync(dir))if(n.endsWith('.desktop'))paths.push(fs.readFileSync(path.join(dir,n),'utf8'));
  return {complete:true,paths};
 }
 const script=`$ErrorActionPreference='Stop'
$paths=@(Get-CimInstance Win32_Process | Where-Object ExecutablePath | ForEach-Object ExecutablePath)
$run=Get-ItemProperty -LiteralPath 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Run' -ErrorAction SilentlyContinue
if ($run) { $paths+=@($run.PSObject.Properties | Where-Object {$_.Name -notlike 'PS*'} | ForEach-Object Value) }
$shell=New-Object -ComObject WScript.Shell
foreach($dir in @([Environment]::GetFolderPath('Desktop'),(Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs'),(Join-Path $env:APPDATA 'Microsoft/Internet Explorer/Quick Launch/User Pinned'))) {
 if(Test-Path -LiteralPath $dir) { foreach($f in @(Get-ChildItem -LiteralPath $dir -Filter '*.lnk' -Recurse -File)) { $paths+=$shell.CreateShortcut($f.FullName).TargetPath } }
}
@{complete=$true;paths=@($paths)} | ConvertTo-Json -Compress`;
 return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:30000,encoding:'utf8',maxBuffer:2*1024*1024}));
}
export async function collectHomeUpdates({state,currentTop,scan=runningAndLaunchPaths,now=Date.now(),minimumAgeMs=86400000,maxPackages=2}){
 const updates=path.resolve(state,'updates'),releases=path.join(updates,'releases');
 // The OS releases this lock on process death. No PID reuse or stale-file
 // deletion can accidentally admit two concurrent collectors.
 const lock=new DatabaseSync(path.join(updates,'retention.sqlite'));
 try{lock.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS retention_lock(id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;');}
 catch(e){lock.close();if(e.errcode===5||e.errcode===6)return {skipped:'busy'};throw e;}
 const result={removed:[],retained:[],freedBytes:0};
 try{
  const installed=read(path.join(updates,'installed.json')),receipt=read(path.join(updates,'last-install.json'));
  assert(receipt.passed&&receipt.version===installed.descriptor.version&&same(installed.top,currentTop),'Accepted current install required');
  const keep=new Set([path.basename(currentTop)]);
  for(const name of ['installed.json','last-good.json','staged.json']){const f=path.join(updates,name);if(fs.existsSync(f)){const r=read(f);if(r.top)keep.add(path.basename(r.top));}}
  // Old helpers may still own their previous package. A fresh request pauses
  // collection entirely, including when its process is between launch phases.
  for(const n of fs.readdirSync(updates))if(/^pending-[a-f0-9-]+\.json$/.test(n)){const r=read(path.join(updates,n));if(now-Date.parse(r.createdAt)<600000)return {skipped:'update pending'};}
  // An older updater can install this collector without writing last-good.
  // Recover only its exact accepted handoff, including the ready health ticket.
  const rollback=path.join(updates,'last-good.json');
  if(!fs.existsSync(rollback)){
   for(const name of fs.readdirSync(updates).filter(n=>/^pending-[a-f0-9-]+\.json$/.test(n))){
    const pending=read(path.join(updates,name)),health=path.join(updates,'health',pending.ticket+'.json');
    if(pending.staged?.descriptorSha256!==installed.descriptorSha256||!pending.staged?.top||!same(pending.staged.top,currentTop)||!fs.existsSync(health))continue;
    const ready=read(health);if(ready.phase!=='ready'||ready.ticket!==pending.ticket||ready.version!==installed.descriptor.version||!(Date.parse(receipt.at)>=Date.parse(pending.createdAt))||typeof pending.oldTop!=='string'||same(pending.oldTop,currentTop)||!fs.existsSync(pending.oldTop))continue;
    const temp=rollback+'.tmp',fd=fs.openSync(temp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify({top:path.resolve(pending.oldTop),acceptedAt:receipt.at,recoveredFromTicket:pending.ticket}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,rollback);keep.add(path.basename(pending.oldTop));break;
   }
   if(!fs.existsSync(rollback))return {skipped:'rollback pointer absent'};
  }
  const refs=await scan();if(!refs.complete)return {skipped:'launch scan incomplete'};
  const names=fs.readdirSync(releases).filter(n=>folder.test(n));
  for(const name of names){
   const top=direct(releases,name),inventoryFile=path.join(updates,'package-inventory',name+'.json');
   if(keep.has(name)||refs.paths.some(p=>String(p).toLowerCase().includes(top.toLowerCase()))||now-fs.statSync(top).mtimeMs<minimumAgeMs||!fs.existsSync(inventoryFile)||result.removed.length>=maxPackages){result.retained.push(name);continue;}
   const inventory=read(inventoryFile);assert.equal(inventory.schema,1);
   const actual=await packageInventory(top);
   if(JSON.stringify(actual)!==JSON.stringify(inventory.files)){result.retained.push(name);continue;}
   const again=await scan();assert(again.complete);if(again.paths.some(p=>String(p).toLowerCase().includes(top.toLowerCase()))){result.retained.push(name);continue;}
   assert.deepEqual(read(path.join(updates,'installed.json')),installed,'Install changed');
   // Checked absolute direct child, no links anywhere, exact known file set.
   // Failure (e.g. an OS file lock) leaves remaining files for a later review.
   fs.rmSync(direct(releases,name),{recursive:true});
   result.freedBytes+=actual.reduce((n,f)=>n+f.bytes,0);result.removed.push(name);
   const archive=path.join(updates,name+(name.endsWith('Windows-x64')?'.zip':'.tar.gz'));
   if(inventory.archive?.name===path.basename(archive)&&fs.existsSync(archive)&&fs.lstatSync(archive).isFile()&&fs.statSync(archive).size===inventory.archive.bytes&&await digest(archive)===inventory.archive.sha256){result.freedBytes+=fs.statSync(archive).size;fs.unlinkSync(archive);}
   fs.unlinkSync(inventoryFile);
  }
  return result;
 }finally{try{lock.exec('ROLLBACK');}finally{lock.close();}}
}
