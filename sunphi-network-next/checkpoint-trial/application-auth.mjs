// Per-start capability for the private application channel; never a wallet key.
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {writeFileSync,renameSync,lstatSync,existsSync,readFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
export const applicationAuthPath=home=>join(home,'application-auth');
export function createApplicationAuth(home){
 const file=applicationAuthPath(home),temp=file+'.'+process.pid+'.pending',token=randomBytes(32).toString('hex');
 if(existsSync(file))assert(lstatSync(file).isFile()&&!lstatSync(file).isSymbolicLink(),'unsafe application credential path');
 writeFileSync(temp,token,{flag:'wx',mode:0o600});
 if(process.platform==='win32'){
  const sid=execFileSync('whoami.exe',['/user','/fo','csv','/nh'],{windowsHide:true,encoding:'utf8'}).match(/S-1-5-\d+(?:-\d+)+/)?.[0];assert(sid,'current user identity');
  execFileSync('icacls.exe',[temp,'/inheritance:r','/grant:r','*'+sid+':F','*S-1-5-18:F'],{windowsHide:true,stdio:'ignore'});
 }
 renameSync(temp,file);if(process.platform!=='win32')chmodSync(file,0o600);return token;
}
export function readApplicationAuth(home){const token=readFileSync(applicationAuthPath(home),'utf8').trim();assert(/^[a-f0-9]{64}$/.test(token),'application credential format');return token;}
export function applicationAuthorized(value,token){return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)&&timingSafeEqual(Buffer.from(value,'hex'),Buffer.from(token,'hex'));}
export const privateApplicationMethods=new Set(['init','check','prepare','process','finalize','commit','offerSnapshot','applySnapshotChunk']);
