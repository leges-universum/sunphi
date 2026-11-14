// Signed delivery only. This module never opens a wallet or sends a chain command.
import nodeFs from 'node:fs';
// Electron treats .asar as virtual read-only directories. The updater must
// write and verify literal archive bytes, including resources/default_app.asar.
const fs=process.versions.electron?(await import('original-fs')).default:nodeFs;
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Updater} from 'tuf-js';
import * as tar from 'tar';
import yauzl from 'yauzl';

export const sha256=b=>createHash('sha256').update(b).digest('hex');
export const readJSON=p=>JSON.parse(fs.readFileSync(p,'utf8'));
export function writeJSON(p,value){fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});const tmp=p+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});fs.renameSync(tmp,p);}
export function versionCompare(a,b){const parse=s=>{assert(/^\d+\.\d+\.\d+$/.test(s),'Invalid release version');const n=s.split('.').map(Number);assert(n.every(Number.isSafeInteger));return n;};const x=parse(a),y=parse(b);for(let i=0;i<3;i++)if(x[i]!==y[i])return Math.sign(x[i]-y[i]);return 0;}
export function packageRoot(applicationRoot){return process.platform==='win32'?path.resolve(applicationRoot,'../..'):path.resolve(applicationRoot);}
export function loadRelease(applicationRoot){const r=readJSON(path.join(applicationRoot,'release-config.json'));assert.equal(r.schema,1);assert(['home','server'].includes(r.edition));assert(['windows-x64','linux-x64'].includes(r.platform));assert(!(r.edition==='server'&&r.platform!=='linux-x64'));versionCompare(r.version,r.version);assert(/^[a-f0-9]{64}$/.test(r.networkPin));assert.equal(sha256(fs.readFileSync(path.join(applicationRoot,'update-root.json'))),r.rootSha256);for(const u of [r.metadataUrl,r.targetsUrl]){const url=new URL(u);assert.equal(url.protocol,'https:');assert(url.hostname==='duebyte.com'||(url.hostname==='raw.githubusercontent.com'&&url.pathname.startsWith('/leges-universum/sunphi/duebyte-updates-stable/')),'Unapproved update metadata origin');assert(!url.username&&!url.password&&!url.search&&!url.hash);}return r;}
export function safeRelative(name){assert(typeof name==='string'&&name.length>0&&name.length<512&&!name.includes('\\')&&!name.includes(':')&&!name.includes('\0'),'Unsafe archive path');assert(!name.startsWith('/'));const parts=name.replace(/\/$/,'').split('/');assert(parts.every(s=>s&&s!=='.'&&s!=='..'&&!/[. ]$/.test(s)&&!/[<>"|?*]/.test(s)&&! /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)),'Unsafe archive path');return parts.join('/');}
export function validateOffer(d,r){
 assert.equal(d.schema,1);assert.equal(d.edition,r.edition,'Wrong edition');assert.equal(d.platform,r.platform,'Wrong platform');assert.equal(d.networkPin,r.networkPin,'Wrong network');assert.equal(d.channel,'stable');assert(Number.isSafeInteger(d.sequence)&&d.sequence>0);versionCompare(d.version,r.version);
 assert(typeof d.summary==='string'&&d.summary.length<=2000);assert(typeof d.required==='boolean');assert(d.deadline===null||Number.isFinite(Date.parse(d.deadline)));assert(d.activationHeight===null||(Number.isSafeInteger(d.activationHeight)&&d.activationHeight>0));
 assert.equal(d.dataFormat,1,'Unsupported persistent data format');assert(typeof d.protocolChange==='boolean');assert(typeof d.dataMigration==='boolean');assert(Array.isArray(d.autoFrom)&&d.autoFrom.every(v=>versionCompare(v,v)===0));
 assert(Number.isInteger(d.rolloutPercent)&&d.rolloutPercent>=0&&d.rolloutPercent<=100);assert(Number.isFinite(Date.parse(d.notBefore)));assert(/^[a-f0-9]{64}$/.test(d.manifestSha256));
 const folder=`DueByte-${d.edition==='home'?'Home':'Server'}-${d.version}-${d.platform==='windows-x64'?'Windows':'Linux'}-x64`;assert.equal(d.folder,folder);assert.equal(d.artifact,folder+(d.platform==='windows-x64'?'.zip':'.tar.gz'));safeRelative(d.artifact);
 const u=new URL(d.artifactBaseUrl);assert.equal(u.href,`https://github.com/leges-universum/sunphi/releases/download/duebyte-v${d.version}/`,'Unapproved artifact origin');return d;
}
export function automaticEligible(d,r,installationId,now=Date.now()){return r.edition==='home'&&versionCompare(d.version,r.version)>0&&!d.protocolChange&&!d.dataMigration&&d.autoFrom.includes(r.version)&&now>=Date.parse(d.notBefore)&&parseInt(sha256(installationId+':'+d.version).slice(0,8),16)%100<d.rolloutPercent;}
export function automaticRouteEligible(checked,release,installationId,now=Date.now()){
 if(checked.routeAvailable===false||!automaticEligible(checked.descriptor,release,installationId,now))return false;
 const head=checked.channelDescriptor??checked.descriptor;
 // A held final release also holds its bridges. Only the first edge needs
 // to name the installed version; rollout and time restrictions apply to both.
 return automaticEligible({...head,autoFrom:[release.version]},release,installationId,now);
}
// Edges are explicit, qualified transitions, not permission to skip migrations.
// The graph is bounded and contains only increasing versions of this network.
export function selectUpdateRoute(head,release,catalog){
 validateOffer(head,release);
 if(versionCompare(head.version,release.version)<=0)return [];
 const offers=[head];
 if(catalog){
  assert.equal(catalog.schema,1);assert.equal(catalog.sequence,head.sequence);assert.equal(catalog.version,head.version);
  assert(Array.isArray(catalog.bridges)&&catalog.bridges.length<=256,'Update route catalog exceeds bounds');
  const seen=new Set([head.version]);
  for(const d of catalog.bridges){validateOffer(d,release);assert(!d.routes,'Nested update routes forbidden');assert(!seen.has(d.version),'Duplicate update route version');assert(versionCompare(d.version,head.version)<0,'Bridge must precede channel head');seen.add(d.version);offers.push(d);}
 }
 const queue=[{version:release.version,route:[]}],visited=new Set([release.version]);
 for(let cursor=0;cursor<queue.length;cursor++){
  const current=queue[cursor];if(current.route.length>=32)continue;
  for(const d of offers){
   if(d.protocolChange||d.dataMigration||versionCompare(d.version,current.version)<=0||!d.autoFrom.includes(current.version)||visited.has(d.version))continue;
   const route=[...current.route,d];
   if(d.version===head.version)return route;
   visited.add(d.version);queue.push({version:d.version,route});
  }
 }
 return null;
}
export async function checkUpdate({root,state,release=loadRelease(root),urls,fetcher,artifactFetchTimeout=600000}){
 const cache=path.join(state,'updates','metadata');fs.mkdirSync(cache,{recursive:true,mode:0o700});const trusted=path.join(cache,'root.json');if(!fs.existsSync(trusted))fs.copyFileSync(path.join(root,'update-root.json'),trusted,fs.constants.COPYFILE_EXCL);
 const updater=new Updater({metadataDir:cache,metadataBaseUrl:urls?.metadata??release.metadataUrl,targetBaseUrl:urls?.targets??release.targetsUrl,targetDir:path.join(state,'updates'),fetcher,config:{maxRootRotations:32,maxDelegations:8,rootMaxLength:262144,timestampMaxLength:32768,snapshotMaxLength:262144,targetsMaxLength:1048576,fetchTimeout:15000,fetchRetries:1,prefixTargetsWithHash:false}});
 await updater.refresh();const info=await updater.getTargetInfo(`${release.edition}-${release.platform}.json`);assert(info&&info.length<=65536,'Release channel missing');const file=path.join(state,'updates','channel-'+release.edition+'-'+release.platform+'.json');await updater.downloadTarget(info,file);const descriptor=validateOffer(readJSON(file),release),highFile=path.join(state,'updates','highest.json'),high=fs.existsSync(highFile)?readJSON(highFile):null;
 if(high){assert(descriptor.sequence>=high.sequence,'Release sequence rollback');assert(versionCompare(descriptor.version,high.version)>=0,'Release version rollback');if(descriptor.sequence===high.sequence)assert.equal(info.hashes.sha256,high.descriptorSha256,'Changed release at same sequence');}
 let catalog;
 if(descriptor.routes){
  const ref=descriptor.routes;assert(typeof ref.target==='string'&&/^routes-[a-z0-9.-]+\.json$/.test(ref.target),'Invalid route target');assert(/^[a-f0-9]{64}$/.test(ref.sha256),'Invalid route digest');
  const target=await updater.getTargetInfo(ref.target);assert(target&&target.length>0&&target.length<=524288&&target.hashes.sha256===ref.sha256,'Update route target mismatch');
  const routeFile=path.join(state,'updates',ref.target);await updater.downloadTarget(target,routeFile);catalog=readJSON(routeFile);
 }
 const route=selectUpdateRoute(descriptor,release,catalog),selected=route?.[0]??descriptor;
 writeJSON(highFile,{sequence:descriptor.sequence,version:descriptor.version,descriptorSha256:info.hashes.sha256});const artifact=await updater.getTargetInfo(selected.artifact);assert(artifact&&artifact.length>0&&artifact.length<600*1024*1024&&/^[a-f0-9]{64}$/.test(artifact.hashes.sha256),'Invalid artifact metadata');
 // Large signed archives need a separate deadline from small metadata. A
 // metadata timeout must not abort an otherwise healthy home connection.
 assert(Number.isSafeInteger(artifactFetchTimeout)&&artifactFetchTimeout>0&&artifactFetchTimeout<=600000);
 const artifactUpdater=new Updater({metadataDir:cache,metadataBaseUrl:urls?.metadata??release.metadataUrl,targetBaseUrl:urls?.targets??release.targetsUrl,targetDir:path.join(state,'updates'),fetcher,config:{fetchTimeout:artifactFetchTimeout,fetchRetries:1,prefixTargetsWithHash:false}});
 return {updater,artifactUpdater,descriptor:selected,channelDescriptor:descriptor,channelVersion:descriptor.version,route:route?.map(d=>d.version)??null,routeAvailable:route!==null,artifact,release,available:versionCompare(descriptor.version,release.version)>0,descriptorSha256:selected===descriptor?info.hashes.sha256:sha256(JSON.stringify(selected)),checkedAt:new Date().toISOString()};
}
function guardedEntry(name,kind,size,folder,seen,counter){const clean=safeRelative(name);assert(clean===folder||clean.startsWith(folder+'/'),'Archive has unexpected root');assert(['File','Directory'].includes(kind),'Links and special files are forbidden');assert(Number.isSafeInteger(size)&&size>=0);counter.files++;counter.bytes+=size;assert(counter.files<=20000&&counter.bytes<=2*1024*1024*1024,'Archive exceeds bounds');const key=clean.toLowerCase();assert(!seen.has(key),'Duplicate archive path');seen.add(key);return clean;}
export async function extractPackage(archive,destination,folder,platform){
 assert(!fs.existsSync(destination),'Extraction requires a new directory');fs.mkdirSync(destination,{recursive:true,mode:0o700});const seen=new Set(),counter={files:0,bytes:0};
 if(platform==='linux-x64'){
  let invalid;await tar.t({file:archive,strict:true,onReadEntry:e=>{try{guardedEntry(e.path,e.type,e.size,folder,seen,counter);}catch(error){invalid??=error;}}});if(invalid)throw invalid;
  await tar.x({file:archive,cwd:destination,strict:true,preservePaths:false,noChmod:true,noMtime:true,preserveOwner:false,filter:(_p,e)=>['File','Directory'].includes(e.type)});
 }else{
  await new Promise((resolve,reject)=>yauzl.open(archive,{lazyEntries:true,strictFileNames:true,validateEntrySizes:true},(err,zip)=>{if(err){reject(err);return;}zip.on('error',reject);zip.on('end',resolve);zip.on('entry',e=>{void(async()=>{const directory=e.fileName.endsWith('/'),unix=(e.externalFileAttributes>>>16)&0o170000;assert(!unix||unix===0o100000||unix===0o040000,'ZIP links forbidden');const name=guardedEntry(e.fileName,directory?'Directory':'File',e.uncompressedSize,folder,seen,counter),to=path.join(destination,name);if(directory)fs.mkdirSync(to,{recursive:true,mode:0o700});else{fs.mkdirSync(path.dirname(to),{recursive:true,mode:0o700});const stream=await new Promise((ok,fail)=>zip.openReadStream(e,(error,s)=>error?fail(error):ok(s)));await pipeline(stream,fs.createWriteStream(to,{flags:'wx',mode:0o600}));}zip.readEntry();})().catch(e=>{zip.close();reject(e);});});zip.readEntry();}));
 }
 const top=path.join(destination,folder);assert(fs.statSync(top).isDirectory());return top;
}
export function verifyPackage(top,offer){const root=offer.platform==='windows-x64'?path.join(top,'resources/app'):top,manifestFile=path.join(root,'manifest.json');assert.equal(sha256(fs.readFileSync(manifestFile)),offer.manifestSha256,'Package manifest mismatch');const m=readJSON(manifestFile);assert.equal(m.version,offer.version);assert.equal(m.edition,offer.edition);assert.equal(m.platform,offer.platform);const actual=[];function walk(dir,prefix=''){for(const e of fs.readdirSync(dir,{withFileTypes:true})){assert(!e.isSymbolicLink(),'Package symlink');const p=prefix+e.name;if(e.isDirectory())walk(path.join(dir,e.name),p+'/');else{assert(e.isFile());actual.push(p);}}}walk(root);for(const [name,sha]of Object.entries(m.files)){safeRelative(name);assert.equal(sha256(fs.readFileSync(path.join(root,name))),sha,'Package file mismatch '+name);}assert.deepEqual(actual.filter(p=>p!=='manifest.json'&&p!=='START-HERE.txt').sort(),Object.keys(m.files).sort(),'Unexpected package files');const config=loadRelease(root);assert.equal(config.version,offer.version);assert.equal(config.edition,offer.edition);assert.equal(config.platform,offer.platform);assert.equal(config.networkPin,offer.networkPin);return {root,config,manifest:m};}
export async function stageUpdate(checked,{state,artifactBaseUrl,onPhase=()=>{}}){
 assert(checked.available,'No newer release');assert(checked.routeAvailable!==false,'No qualified update route');const d=checked.descriptor,dir=path.join(state,'updates'),archive=path.join(dir,d.artifact);await (checked.artifactUpdater??checked.updater).downloadTarget(checked.artifact,archive,artifactBaseUrl??d.artifactBaseUrl);
 const staging=path.join(dir,'staging',d.version+'-'+randomUUID());try{
 onPhase('extracting');const top=await extractPackage(archive,staging,d.folder,d.platform);onPhase('verifying');const verified=verifyPackage(top,d);assert.equal(verified.config.rootSha256,checked.release.rootSha256,'Automatic trust-root replacement forbidden');
 if(d.platform==='linux-x64')for(const file of ['start.sh','install.sh','runtime/node','sunphi-network-next/checkpoint-trial/build/duebyte-abci','sunphi-network-next/.local/bft-runtime/bin/cometbft',...(d.edition==='server'?['duebyte-server']:[])])fs.chmodSync(path.join(top,file),0o755);
 if(d.platform==='linux-x64'&&fs.existsSync(path.join(top,'compat/v6/manifest.json')))for(const file of ['runtime/node','sunphi-network-next/checkpoint-trial/build/duebyte-abci','sunphi-network-next/.local/bft-runtime/bin/cometbft'])fs.chmodSync(path.join(top,'compat/v6',file),0o755);
 const target=path.join(dir,'releases',d.folder);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});if(fs.existsSync(target))verifyPackage(target,d);else fs.renameSync(top,target);
 const record={schema:1,descriptor:d,descriptorSha256:checked.descriptorSha256,top:target,stagedAt:new Date().toISOString()};writeJSON(path.join(dir,'staged.json'),record);return record;
 }finally{
  // Only this invocation's fresh scratch directory; never a release or data.
  assert.equal(path.dirname(path.resolve(staging)),path.resolve(dir,'staging'));
  if(fs.existsSync(staging)){assert(!fs.lstatSync(staging).isSymbolicLink());fs.rmSync(staging,{recursive:true,force:true});}
 }
}
export function installedHome(state,current){const file=path.join(state,'updates','installed.json');if(!fs.existsSync(file))return null;const r=readJSON(file);if(r.disabled)return null;const d=validateOffer(r.descriptor,current);if(versionCompare(d.version,current.version)<=0)return null;assert.equal(path.resolve(r.top),path.resolve(state,'updates/releases',d.folder),'Managed path mismatch');verifyPackage(r.top,d);return r;}
export function updatePreferences(state){const p=path.join(state,'updates/preferences.json');return fs.existsSync(p)?readJSON(p):{automatic:true};}
export function setAutomaticUpdates(state,automatic){assert.equal(typeof automatic,'boolean');writeJSON(path.join(state,'updates/preferences.json'),{automatic});}
export function homeStateBase(network){return process.platform==='win32'?path.join(process.env.APPDATA,'Duebyte/checkpoint-node',network):path.join(process.env.XDG_STATE_HOME||path.join(os.homedir(),'.local/state'),'duebyte',network);}
