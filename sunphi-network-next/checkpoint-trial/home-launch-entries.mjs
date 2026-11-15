import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {loadRelease,versionCompare,readJSON,verifyPackage,writeJSON} from './update-core.mjs';

// Legacy applications recognise only "DueByte.exe --connect" and overwrite it.
// This marker keeps their automatic migration away from a managed entry.
export const managedLaunch='--duebyte-managed-launch';
export const managedStartupArgs=[managedLaunch,'--connect'];
const normalArgs=new Set(['','--connect',managedLaunch,managedStartupArgs.join(' ')]);
export const sameExe=(a,b)=>path.win32.normalize(a).toLowerCase()===path.win32.normalize(b).toLowerCase();
export function releaseAtExe(exe){return loadRelease(path.win32.join(path.win32.dirname(exe),'resources/app'));}
export function launchEntryAllowed(entry,current,{readRelease=releaseAtExe}={}){
 if(!entry||typeof entry.target!=='string'||path.win32.basename(entry.target).toLowerCase()!=='duebyte.exe'||!normalArgs.has(entry.args??''))return false;
 try{const old=readRelease(entry.target);return old.edition==='home'&&old.platform==='windows-x64'&&old.rootSha256===current.rootSha256&&versionCompare(old.version,current.version)<=0;}catch{return false;}
}
export function parseStartup(command){const m=/^"([^"\r\n]+)"\s+(.+)$/.exec(command??'');return m&&normalArgs.has(m[2])&&m[2].split(' ').includes('--connect')?{target:m[1],args:m[2]}:null;}

// A staged pointer alone is not success: the OLD helper must accept boot health.
export function acceptedHomeInstall(root,state,{read=readJSON,verify=verifyPackage,release=loadRelease}={}){
 try{
  const current=release(root),installed=read(path.join(state,'updates/installed.json')),receipt=read(path.join(state,'updates/last-install.json'));
  if(current.platform!=='windows-x64'||current.edition!=='home'||!receipt.passed||receipt.version!==current.version||installed.disabled||installed.descriptor.version!==current.version)return false;
  assert.equal(path.resolve(installed.top),path.resolve(root,'../..'));
  assert.equal(path.resolve(installed.top),path.resolve(state,'updates/releases',installed.descriptor.folder));
  assert.equal(verify(installed.top,installed.descriptor).config.rootSha256,current.rootSha256);
  return true;
 }catch{return false;}
}
export function shortcutFiles(directories){
 const files=[],seen=new Set();let entries=0;
 function visit(dir,depth){if(depth>6||entries>5000)return;let list;try{list=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
  for(const e of list){if(++entries>5000)return;if(e.isSymbolicLink())continue;const file=path.join(dir,e.name);if(e.isDirectory())visit(file,depth+1);else if(e.isFile()&&/\.lnk$/i.test(e.name)&&!seen.has(file.toLowerCase())){seen.add(file.toLowerCase());files.push(file);}}
 }
 for(const dir of directories)visit(dir,0);return files;
}
export function reconcileShortcuts({files,shell,exe,current,state,readRelease=releaseAtExe}){
 const result={updated:0,unchanged:0,skipped:0,failed:0};
 for(const file of files){
  try{
   const before=shell.readShortcutLink(file);
   if(!launchEntryAllowed(before,current,{readRelease})){result.skipped++;continue;}
   const args=(before.args??'').split(' ').includes('--connect')?managedStartupArgs.join(' '):managedLaunch;
   if(sameExe(before.target,exe)&&before.args===args){result.unchanged++;continue;}
   const dir=path.join(state,'updates/shortcut-backups');fs.mkdirSync(dir,{recursive:true});
   const backup=path.join(dir,Date.now()+'-'+result.updated+'-'+path.basename(file));fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);
   assert.deepEqual(shell.readShortcutLink(file),before,'Shortcut changed during reconciliation');
   assert(shell.writeShortcutLink(file,'update',{target:exe,cwd:path.dirname(exe),args,icon:exe,iconIndex:0}),'Shortcut update failed');
   const after=shell.readShortcutLink(file);assert(sameExe(after.target,exe)&&after.args===args,'Shortcut verification failed');result.updated++;
  }catch{result.failed++;}
 }
 return result;
}
export function startLaunchReconciliation({root,state,exe=process.execPath,isolated=false,platform=process.platform,app,shell,autoStart,intervalMs=1000}){
 if(platform!=='win32'||isolated)return ()=>{};
 let finished=false;
 const check=()=>{
  if(finished||!acceptedHomeInstall(root,state))return;
  finished=true;clearInterval(timer);
  try{
   const current=loadRelease(root),roaming=app.getPath('appData');
   const files=shortcutFiles([app.getPath('desktop'),path.join(roaming,'Microsoft/Windows/Start Menu/Programs'),path.join(roaming,'Microsoft/Internet Explorer/Quick Launch/User Pinned')]);
   const result=reconcileShortcuts({files,shell,exe,current,state});autoStart.reconcile();
   writeJSON(path.join(state,'updates/launch-entries.json'),{version:current.version,at:new Date().toISOString(),...result});
  }catch{writeJSON(path.join(state,'updates/launch-entries.json'),{at:new Date().toISOString(),failed:true});}
 };
 const timer=setInterval(check,intervalMs);timer.unref();return ()=>clearInterval(timer);
}
