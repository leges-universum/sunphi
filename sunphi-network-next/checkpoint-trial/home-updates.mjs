import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {randomUUID} from 'node:crypto';
import {loadRelease,checkUpdate,stageUpdate,verifyPackage,readJSON,writeJSON,updatePreferences,setAutomaticUpdates,automaticRouteEligible,installedHome,packageRoot} from './update-core.mjs';
import {collectHomeUpdates} from './update-retention.mjs';
export function launchHome(top,{connect=false,ticket,userDataDir}={}){const win=process.platform==='win32',root=win?path.join(top,'resources/app'):top,exe=win?path.join(top,'DueByte.exe'):path.join(root,'runtime/node'),args=win?[]:[path.join(root,'sunphi-network-next/checkpoint-trial/consumer-cli.mjs')];if(connect)args.push('--connect');if(ticket)args.push('--duebyte-update-ticket='+ticket);if(userDataDir)args.push('--user-data-dir='+userDataDir);const p=spawn(exe,args,{windowsHide:!win,detached:true,stdio:'ignore',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});p.on('error',()=>{});p.unref();return p;}
export function forwardHome(root,state,options={}){let record;try{record=installedHome(state,loadRelease(root));}catch{writeJSON(path.join(state,'updates/launch-warning.json'),{at:new Date().toISOString(),message:'Managed update failed local verification. Starting the original trusted package.'});return false;}if(!record)return false;launchHome(record.top,options);return true;}
export function reportHomeBoot(root,state,phase='ready'){const ticket=process.argv.find(a=>a.startsWith('--duebyte-update-ticket='))?.slice('--duebyte-update-ticket='.length);if(!ticket)return;assert(/^[a-f0-9-]{36}$/.test(ticket));writeJSON(path.join(state,'updates/health',ticket+'.json'),{ticket,pid:process.pid,version:loadRelease(root).version,phase,at:new Date().toISOString()});}
export class HomeUpdates{
 constructor({root,state,prepare,stop,quit,connected,userDataDir,check=checkUpdate,stage=stageUpdate,collect=collectHomeUpdates,now=Date.now}){this.root=root;this.state=state;this.release=loadRelease(root);assert.equal(this.release.edition,'home');this.prepare=prepare;this.stop=stop;this.quit=quit;this.connected=connected;this.userDataDir=userDataDir;this.checkRelease=check;this.stage=stage;this.collect=collect;this.now=now;this.retryAttempt=0;this.installFailures=0;this.installRetryAt=0;this.collectionAt=null;this.value={current:this.release.version,automatic:updatePreferences(state).automatic,phase:'idle',message:'Automatic updates keep this Home edition current.'};this.busy=false;this.ending=false;this.checked=null;}
 start(){this.first=setTimeout(()=>void this.check(),30000+Math.floor(Math.random()*30000));this.first.unref();this.interval=setInterval(()=>void this.check(),6*60*60*1000);this.interval.unref();this.ready=setInterval(()=>void this.resume().catch(()=>{}),30000);this.ready.unref();}
 async resume(){
  if(this.busy||this.ending)return;
  if(this.checked&&this.value.automatic){if(this.installRetryAt&&this.now()>=this.installRetryAt){this.installRetryAt=0;await this.check({retry:true});}else await this.install();}
  else if(this.value.phase==='current'){this.busy=true;try{await this.collectUpdates();}finally{this.busy=false;}}
 }
 close(){clearTimeout(this.first);clearTimeout(this.retry);clearInterval(this.interval);clearInterval(this.ready);this.ending=true;}
 snapshot(){return {...this.value,retryInSeconds:this.installRetryAt?Math.max(0,Math.ceil((this.installRetryAt-this.now())/1000)):null};}
 async collectUpdates(){
  if(this.collectionAt!==null&&this.now()-this.collectionAt<600000)return;
  this.collectionAt=this.now();
  try{const result=await this.collect({state:this.state,currentTop:packageRoot(this.root)});if(['update pending','busy'].includes(result.skipped))this.collectionAt=this.now()-540000;writeJSON(path.join(this.state,'updates/retention.json'),{at:new Date(this.now()).toISOString(),...result});}
  catch{try{writeJSON(path.join(this.state,'updates/retention.json'),{at:new Date(this.now()).toISOString(),skipped:'verification or filesystem unavailable'});}catch{}}
 }
 setAutomatic(enabled){setAutomaticUpdates(this.state,enabled);this.value.automatic=enabled;if(!enabled&&this.installRetryAt){this.value.phase='waiting';this.value.message='Automatic installation is off. Your current version keeps working.';}return this.snapshot();}
 recordCheck(error){
  // Store bounded diagnostics only; exception messages can contain URLs or paths.
  const codes=new Set(['ETIMEDOUT','ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET','ENOSPC','EACCES','EPERM','ERR_ASSERTION']);
  const names=new Set(['TimeoutError','AbortError','DownloadError','DownloadHTTPError','DownloadLengthMismatchError','RepositoryError','BadVersionNumberError','ExpiredMetadataError','UnsignedMetadataError','LengthOrHashMismatchError']);
  const code=[error?.code,error?.cause?.code].find(c=>codes.has(c))??null;
  const type=names.has(error?.name)?error.name:error?'VerificationError':null;
  try{writeJSON(path.join(this.state,'updates/last-check.json'),{at:new Date().toISOString(),version:this.release.version,passed:!error,code,type,retryAttempt:this.retryAttempt,nextRetryAt:this.value.nextRetryAt??null});}catch{/* Diagnostics must never interrupt the node or update verification. */}
 }
 async check({retry=false}={}){
  if(this.busy||this.ending)return;
  clearTimeout(this.retry);if(!retry){this.retryAttempt=0;this.installRetryAt=0;}
  this.busy=true;this.value.nextRetryAt=null;this.value.phase='checking';this.value.message='Checking the signed release catalog…';
  try{
   const c=await this.checkRelease({root:this.root,state:this.state});if(this.ending)return;
   if(this.checked?.descriptorSha256!==c.descriptorSha256){this.installFailures=0;this.installRetryAt=0;}
   this.checked=c.available?c:null;this.retryAttempt=0;
   // Collection never races a new install and cannot fail the update check.
   if(!c.available)await this.collectUpdates();
   this.value={...this.value,phase:c.available?'available':'current',available:c.available?c.descriptor.version:null,target:c.channelVersion??c.descriptor.version,route:c.route??null,required:c.descriptor.required,deadline:c.descriptor.deadline,checkedAt:c.checkedAt,message:c.available?c.descriptor.summary:'You have the current verified Home release.'};this.recordCheck();
  }catch(error){
   this.checked=null;if(this.ending)return;
   this.value.phase='unavailable';this.value.message='Updates could not be verified. Your current node keeps running; DueByte will retry.';
   const delay=[60000,300000,900000,1800000][Math.min(this.retryAttempt++,3)];
   if(delay){this.value.nextRetryAt=new Date(Date.now()+delay).toISOString();this.retry=setTimeout(()=>void this.check({retry:true}),delay);this.retry.unref();}
   this.recordCheck(error);
  }finally{this.busy=false;}
  if(this.checked&&!this.ending)await this.install();
 }
 async install({manual=false}={}){if(this.busy||this.ending||!this.checked||(!this.value.automatic&&!manual))return;if(!manual&&this.now()<this.installRetryAt){this.value.phase='retrying';this.value.message=this.installRetryMessage;return;}const c=this.checked,d=c.descriptor,failed=path.join(this.state,'updates/failed.json');if(fs.existsSync(failed)&&readJSON(failed).version===d.version){this.value.phase='failed';this.value.message='The new version could not start. Your previous version and saved data were retained.';return;}
 if(c.routeAvailable===false||!d.autoFrom.includes(this.release.version)){this.value.phase='unavailable';this.value.message='No verified automatic upgrade path is published for this version yet. Your wallet and saved data are retained.';return;}
 if(!automaticRouteEligible(c,this.release,this.state)){this.value.phase='waiting';this.value.message=d.protocolChange||d.dataMigration?'This release needs a coordinated upgrade. Automatic installation is paused.':'This verified update will reach your installation in a later rollout group.';return;}
 this.busy=true;try{this.value.phase='cleaning';this.value.message='Checking storage and safely removing eligible old update packages…';await this.collectUpdates();if(this.ending)return;this.installRetryAt=0;this.value.phase='downloading';this.value.message='Downloading and verifying the Home update. This can take a few minutes.';const file=path.join(this.state,'updates/staged.json');let staged=fs.existsSync(file)?readJSON(file):null;if(staged?.descriptorSha256!==c.descriptorSha256)staged=await this.stage(c,{state:this.state,onPhase:phase=>{this.value.phase=phase;this.value.message=phase==='extracting'?'Checking storage and preparing the downloaded package…':'Checking the application files before installation…';}});else{this.value.phase='verifying';this.value.message='Checking the saved update package…';verifyPackage(staged.top,d);}
 this.installFailures=0;
 if((!this.value.automatic&&!manual)||this.ending)return;const ready=await this.prepare();if(!ready){this.value.phase='ready';this.value.message='Update ready. Lock your wallet or return to the node; installation will continue automatically.';return;}
 if((!this.value.automatic&&!manual)||this.ending)return;
 // A wallet can remain open for hours after staging. Revalidate the signed
 // channel while the old node is still running, before handing off shutdown.
 const fresh=await this.checkRelease({root:this.root,state:this.state});
 if((!this.value.automatic&&!manual)||this.ending)return;
 if(!fresh.available||fresh.descriptorSha256!==c.descriptorSha256||fresh.routeAvailable===false||!automaticRouteEligible(fresh,this.release,this.state)){
  this.checked=fresh.available?fresh:null;
  this.value={...this.value,phase:fresh.available?'available':'current',available:fresh.available?fresh.descriptor.version:null,target:fresh.channelVersion??fresh.descriptor.version,message:fresh.available?'The signed release catalog changed. Preparing the current update while your node keeps running.':'You have the current verified Home release.'};
  return;
 }
 const reconnect=!!this.connected(),ticket=randomUUID(),pending=path.join(this.state,'updates','pending-'+ticket+'.json');writeJSON(pending,{schema:1,ticket,parentPid:process.pid,oldTop:packageRoot(this.root),state:this.state,staged,connect:reconnect,userDataDir:this.userDataDir??null,createdAt:new Date().toISOString()});this.value.phase='installing';this.value.message='Installing the verified update. Your node will restart with its saved data.';
 const runtime=path.join(this.root,'runtime',process.platform==='win32'?'node.exe':'node'),helper=spawn(runtime,[path.join(import.meta.dirname,'update-home-helper.mjs'),pending],{windowsHide:true,detached:true,stdio:'ignore',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});await new Promise((ok,fail)=>{helper.once('spawn',ok);helper.once('error',fail);});helper.unref();this.close();await this.stop();await this.quit();
 }catch(error){
  if(this.ending)return;
  const allowed=new Set(['ENOSPC','EACCES','EPERM','EBUSY','EIO','ETIMEDOUT','ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET']);
  const code=[error?.code,error?.cause?.code].find(c=>allowed.has(c))??'VERIFY_OR_IO';
  const delay=[60000,300000,900000,1800000][Math.min(this.installFailures++,3)];this.installRetryAt=this.now()+delay;
  const space=Number.isSafeInteger(error?.requiredBytes)&&Number.isSafeInteger(error?.availableBytes)?{requiredBytes:error.requiredBytes,availableBytes:error.availableBytes}:{};
  this.installRetryMessage=code==='ENOSPC'?`Not enough free disk space for the update.${space.requiredBytes?` Required: ${Math.ceil(space.requiredBytes/1048576)} MiB; available: ${Math.floor(space.availableBytes/1048576)} MiB.`:''} Safe cleanup will be checked again. Your current version keeps working.`:code==='EACCES'||code==='EPERM'||code==='EBUSY'?'Windows has not released an update file. DueByte will retry automatically; your current version keeps working.':'The update could not finish verification or preparation. DueByte will retry safely; your current version and data are retained.';
  this.value.phase='retrying';this.value.message=this.installRetryMessage;
  try{writeJSON(path.join(this.state,'updates/last-install-error.json'),{at:new Date(this.now()).toISOString(),version:d.version,code,...space,attempt:this.installFailures,nextRetryAt:new Date(this.installRetryAt).toISOString()});}catch{}
 }finally{this.busy=false;}}
}
