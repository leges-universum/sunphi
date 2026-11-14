// Runs from the OLD trusted package. Never restores/deletes chain or wallet data.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {connect} from 'node:net';
import {readJSON,writeJSON,loadRelease,checkUpdate,verifyPackage,automaticRouteEligible,updatePreferences} from './update-core.mjs';import {launchHome} from './home-updates.mjs';
import {consumerNodeHome} from './consumer-home.mjs';
export async function runHomeUpdate(pendingFile,{root=path.resolve(import.meta.dirname,'../..'),check=checkUpdate,launch=launchHome,healthAttempts=180}={}){
const pending=path.resolve(pendingFile),p=readJSON(pending),release=loadRelease(root);assert.equal(release.edition,'home');assert.equal(p.schema,1);assert(/^[a-f0-9-]{36}$/.test(p.ticket));assert.equal(pending,path.join(p.state,'updates','pending-'+p.ticket+'.json'));assert.equal(path.resolve(p.oldTop),process.platform==='win32'?path.resolve(root,'../..'):root);assert(Number.isSafeInteger(p.parentPid)&&p.parentPid>0);assert(Date.now()-Date.parse(p.createdAt)<5*60000);
const delay=ms=>new Promise(r=>setTimeout(r,ms)),alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}},pointer=path.join(p.state,'updates/installed.json'),previous=fs.existsSync(pointer)?readJSON(pointer):{disabled:true},port=readJSON(path.join(root,'connection-profile.json')).basePort;
async function portClosed(){const ports=[port+1,readJSON(path.join(root,'connection-profile.json')).walletPort];return (await Promise.all(ports.map(port=>new Promise(resolve=>{const s=connect(port,'127.0.0.1');s.once('connect',()=>{s.destroy();resolve(false)});s.once('error',()=>resolve(true));s.setTimeout(1000,()=>{s.destroy();resolve(false)});} )))).every(Boolean);}
let child,switched=false;try{
 for(let n=0;n<90&&alive(p.parentPid);n++)await delay(500);assert(!alive(p.parentPid),'Old application did not exit');assert(await portClosed(),'Old node still owns its RPC');
 const c=await check({root,state:p.state});assert.equal(c.descriptorSha256,p.staged.descriptorSha256,'Release changed while staging');assert(c.available&&c.routeAvailable!==false);assert(updatePreferences(p.state).automatic&&automaticRouteEligible(c,release,p.state),'Automatic installation is no longer eligible');assert.equal(path.resolve(p.staged.top),path.resolve(p.state,'updates/releases',c.descriptor.folder));assert.equal(verifyPackage(p.staged.top,c.descriptor).config.rootSha256,release.rootSha256,'Automatic trust-root replacement forbidden');
 writeJSON(pointer,p.staged);switched=true;child=launch(p.staged.top,{connect:p.connect,ticket:p.ticket,userDataDir:p.userDataDir});const health=path.join(p.state,'updates/health',p.ticket+'.json');let boot=null;for(let n=0;n<healthAttempts;n++){await delay(1000);if(fs.existsSync(health)){const candidate=readJSON(health);assert.equal(candidate.ticket,p.ticket);assert.equal(candidate.version,c.descriptor.version);assert.equal(candidate.pid,child.pid);if(candidate.phase==='ready'){boot=candidate;break;}}if(child.pid&&!alive(child.pid))break;}assert(boot,'Updated application did not become ready');writeJSON(path.join(p.state,'updates/last-install.json'),{passed:true,version:c.descriptor.version,at:new Date().toISOString(),dataRetained:true});return {passed:true};
}catch(e){
 if(switched){if(child?.pid&&alive(child.pid)){try{process.kill(child.pid,'SIGTERM');}catch{}}const node=consumerNodeHome(p.state);if(fs.existsSync(path.join(node,'run-settings.json')))fs.writeFileSync(path.join(node,'stop.request'),'stop');for(let n=0;n<30&&!(await portClosed());n++)await delay(1000);writeJSON(pointer,previous);}
 // Before switching, the new program has not run. A temporary metadata outage
 // must not permanently blacklist it. The next attempt still re-verifies TUF.
 const attempt={version:p.staged.descriptor.version,at:new Date().toISOString(),switched,reason:'Verified update did not complete; data was not rolled back',detail:String(e.message).slice(0,300)};
 writeJSON(path.join(p.state,'updates/last-attempt.json'),attempt);
 if(switched)writeJSON(path.join(p.state,'updates/failed.json'),attempt);
 if(!alive(p.parentPid)&&await portClosed())launch(p.oldTop,{connect:p.connect,userDataDir:p.userDataDir});return {passed:false};
}
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)){const result=await runHomeUpdate(process.argv[2]);if(!result.passed)process.exitCode=1;}
