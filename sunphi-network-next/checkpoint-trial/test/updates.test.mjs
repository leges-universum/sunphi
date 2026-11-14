import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import * as tar from 'tar';
import {authority,rootBytes,feed} from '../qa/update-signing.mjs';
import {checkUpdate,automaticEligible,validateOffer,extractPackage,verifyPackage,stageUpdate,sha256,writeJSON,loadRelease,installedHome,selectUpdateRoute} from '../update-core.mjs';
import {runHomeUpdate} from '../update-home-helper.mjs';
import {HomeUpdates} from '../home-updates.mjs';
import {spawn,execFileSync} from 'node:child_process';import {randomUUID} from 'node:crypto';
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'duebyte-update-'));

test('Home retries a failed catalog check with a bounded schedule and no node shutdown',async t=>{
 const f=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});let calls=0,stops=0;
 const u=new HomeUpdates({root:f.root,state:f.state,stop:()=>stops++,check:async()=>{calls++;throw Object.assign(new Error('private URL and local path must not be saved'),{code:'ETIMEDOUT'});}});t.after(()=>u.close());
 await u.check();assert.equal(u.snapshot().phase,'unavailable');
 for(const delay of [60000,300000,900000]){t.mock.timers.tick(delay);await new Promise(setImmediate);}
 assert.equal(calls,4);assert.equal(stops,0);assert.equal(u.checked,null);assert.equal(u.snapshot().nextRetryAt,null);
 t.mock.timers.tick(6*60*60*1000);await new Promise(setImmediate);assert.equal(calls,4);
 const log=fs.readFileSync(path.join(f.state,'updates/last-check.json'),'utf8');assert(!log.includes('private'));assert.equal(JSON.parse(log).code,'ETIMEDOUT');
 await u.check();assert.equal(calls,5);assert(u.snapshot().nextRetryAt,'manual check starts a fresh bounded cycle');
});

test('Home accepts recovery only after a new signed check, retaining wallet bytes',async t=>{
 const f=await fixture(t),wallet=path.join(f.state,'wallet/retained.json');writeJSON(wallet,{amount:'123',key:'synthetic'});const before=fs.readFileSync(wallet);
 let calls=0;const u=new HomeUpdates({root:f.root,state:f.state,check:async()=>{calls++;if(calls===1)throw Error('temporary outage');const c=await f.check();return {...c,available:false};}});t.after(()=>u.close());
 await u.check();assert.equal(u.checked,null);await u.check();assert.equal(u.snapshot().phase,'current');assert.equal(u.snapshot().nextRetryAt,null);assert.equal(JSON.parse(fs.readFileSync(path.join(f.state,'updates/last-check.json'))).passed,true);assert.deepEqual(fs.readFileSync(wallet),before);
});

test('Home never installs from a rejected signature and cancels pending retries on close',async t=>{
 const f=await fixture(t);f.a.roles.targets.threshold=1;f.publish();let installs=0;
 const u=new HomeUpdates({root:f.root,state:f.state,check:()=>f.check()});u.install=async()=>installs++;t.after(()=>u.close());
 await u.check();assert.equal(u.snapshot().phase,'unavailable');assert.equal(u.checked,null);assert.equal(installs,0);
 u.close();await u.check();assert.equal(installs,0);assert(u.retry._destroyed);
});

test('closing Home while a catalog check is pending cannot start installation',async t=>{
 const f=await fixture(t);let resolve,installs=0;const u=new HomeUpdates({root:f.root,state:f.state,check:()=>new Promise(r=>resolve=r)});u.install=async()=>installs++;
 const pending=u.check();u.close();resolve({available:true,descriptor:f.d});await pending;assert.equal(installs,0);assert.equal(u.checked,null);assert.equal(u.busy,false);
});

test('temporary verification outage before switching restarts the old app without blacklisting the release',async t=>{
 const f=await fixture(t),ticket=randomUUID(),oldTop=process.platform==='win32'?path.resolve(f.root,'../..'):f.root;
 writeJSON(path.join(f.root,'connection-profile.json'),{basePort:31580,walletPort:31589});
 writeJSON(path.join(f.state,'wallet/retained.json'),{balance:'900',sequence:17});
 const retained=fs.readFileSync(path.join(f.state,'wallet/retained.json'));
 const previous={disabled:true};writeJSON(path.join(f.state,'updates/installed.json'),previous);
 const pending=path.join(f.state,'updates','pending-'+ticket+'.json');
 const parentPid=Number(execFileSync(process.execPath,['-p','process.pid'],{encoding:'utf8',windowsHide:true}));
 writeJSON(pending,{schema:1,ticket,parentPid,oldTop,state:f.state,staged:{descriptor:f.d,descriptorSha256:'c'.repeat(64),top:path.join(f.state,'updates/releases',f.d.folder)},connect:true,createdAt:new Date().toISOString()});
 const launches=[];const r=await runHomeUpdate(pending,{root:f.root,check:async()=>{throw new Error('temporary metadata connection loss');},launch:(top,options)=>{launches.push({top,options});return {};}});
 assert.equal(r.passed,false);assert.equal(launches.length,1);assert.equal(launches[0].top,oldTop);assert.equal(launches[0].options.connect,true);
 assert.deepEqual(fs.readFileSync(path.join(f.state,'wallet/retained.json')),retained);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.state,'updates/installed.json'))),previous);
 assert(!fs.existsSync(path.join(f.state,'updates/failed.json')),'A temporary outage must not permanently blacklist an unstarted release');
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.state,'updates/last-attempt.json'))).switched,false);
});
async function fixture(t){const dir=temp(),root=path.join(dir,'app'),state=path.join(dir,'state'),a=authority(),trust=rootBytes(a);fs.mkdirSync(root);fs.writeFileSync(path.join(root,'update-root.json'),trust);const r={schema:1,version:'0.3.18',edition:'home',platform:'linux-x64',networkPin:'a'.repeat(64),rootSha256:sha256(trust),metadataUrl:'https://duebyte.com/updates/stable/metadata/',targetsUrl:'https://duebyte.com/updates/stable/targets/'};writeJSON(path.join(root,'release-config.json'),r);
 const d={schema:1,edition:r.edition,platform:r.platform,networkPin:r.networkPin,channel:'stable',version:'0.3.19',sequence:19,summary:'Qualified update',required:false,deadline:null,activationHeight:null,dataFormat:1,protocolChange:false,dataMigration:false,autoFrom:['0.3.18'],rolloutPercent:100,notBefore:new Date(Date.now()-1000).toISOString(),manifestSha256:'b'.repeat(64),folder:'DueByte-Home-0.3.19-Linux-x64',artifact:'DueByte-Home-0.3.19-Linux-x64.tar.gz',artifactBaseUrl:'https://github.com/leges-universum/sunphi/releases/download/duebyte-v0.3.19/'};
 let contents={};const server=http.createServer((req,res)=>{const data=contents[req.url];if(!data){res.writeHead(404);res.end();}else res.end(data);});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>server.close(ok)));const base='http://127.0.0.1:'+server.address().port,urls={metadata:base+'/metadata/',targets:base+'/targets/'};
 function publish({descriptor=d,version=1,payload=Buffer.from('archive fixture'),now=Date.now(),timestampDays=30,mutate,extraTargets={}}={}){const targets={...extraTargets,'home-linux-x64.json':Buffer.from(JSON.stringify(descriptor)),[descriptor.artifact]:payload},meta=feed(a,targets,{version,now,timestampDays});contents={'/metadata/1.root.json':trust,...Object.fromEntries(Object.entries(meta).map(([n,b])=>['/metadata/'+n,b])),...Object.fromEntries(Object.entries(targets).map(([n,b])=>['/targets/'+n,b]))};mutate?.(contents);}
 publish();return {dir,root,state,a,r,d,trust,base,urls,publish,check:()=>checkUpdate({root,state,urls})};
}
test('TUF verifies threshold signed descriptors and archive bytes',async t=>{const f=await fixture(t),c=await f.check();assert(c.available);assert.equal(c.descriptor.version,'0.3.19');const p=path.join(f.dir,'download');await c.updater.downloadTarget(c.artifact,p,f.urls.targets);assert.equal(fs.readFileSync(p,'utf8'),'archive fixture');});
test('signed bridge routing retains head anti-rollback protection across restart',async t=>{
 const f=await fixture(t),bridge=f.d,head={...f.d,version:'0.3.20',sequence:20,autoFrom:['0.3.19'],folder:'DueByte-Home-0.3.20-Linux-x64',artifact:'DueByte-Home-0.3.20-Linux-x64.tar.gz',artifactBaseUrl:'https://github.com/leges-universum/sunphi/releases/download/duebyte-v0.3.20/'};
 const routes=Buffer.from(JSON.stringify({schema:1,version:head.version,sequence:head.sequence,bridges:[bridge]}));head.routes={target:'routes-home-linux-x64.json',sha256:sha256(routes)};
 const extraTargets={[head.routes.target]:routes,[bridge.artifact]:Buffer.from('bridge archive')};f.publish({descriptor:head,extraTargets});
 const wallet=path.join(f.state,'wallet/retained');fs.mkdirSync(path.dirname(wallet),{recursive:true});fs.writeFileSync(wallet,'retained wallet');
 const c=await f.check();assert.deepEqual(c.route,['0.3.19','0.3.20']);assert.equal(c.descriptor.version,'0.3.19');assert.equal(c.channelVersion,'0.3.20');assert.equal(c.descriptorSha256,sha256(JSON.stringify(bridge)));
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.state,'updates/highest.json'))).version,'0.3.20');
 const next=await checkUpdate({root:f.root,state:f.state,urls:f.urls,release:{...f.r,version:'0.3.19'}});assert.deepEqual(next.route,['0.3.20']);
 f.publish({descriptor:bridge,version:2});await assert.rejects(f.check,/rollback/);assert.equal(fs.readFileSync(wallet,'utf8'),'retained wallet');
});
test('route catalog substitution, absent route and rollout are distinct',async t=>{
 const f=await fixture(t),head={...f.d,autoFrom:[]};f.publish({descriptor:head});const c=await f.check();assert(c.available);assert.equal(c.routeAvailable,false);
 const u=new HomeUpdates({root:f.root,state:f.state,check:()=>f.check()});t.after(()=>u.close());await u.check();assert.equal(u.snapshot().phase,'unavailable');assert.match(u.snapshot().message,/No verified automatic upgrade path/);assert(!u.snapshot().message.includes('rollout'));
 const bytes=Buffer.from(JSON.stringify({schema:1,version:head.version,sequence:head.sequence,bridges:[]}));head.routes={target:'routes-home-linux-x64.json',sha256:'0'.repeat(64)};head.sequence++;
 f.publish({descriptor:head,version:2,extraTargets:{[head.routes.target]:bytes}});await assert.rejects(f.check,/route target mismatch/);
});
test('slow signed archive uses its own bounded deadline and still rejects altered bytes',async t=>{
 const f=await fixture(t),c=await checkUpdate({root:f.root,state:f.state,urls:f.urls,artifactFetchTimeout:5000});
 assert.equal(c.updater.config.fetchTimeout,15000);assert.equal(c.artifactUpdater.config.fetchTimeout,5000);
 let changed=false;const slow=http.createServer((req,res)=>{res.writeHead(200);res.flushHeaders();setTimeout(()=>res.end(changed?'archive altered':'archive fixture'),250);});
 await new Promise(ok=>slow.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>slow.close(ok)));
 const url='http://127.0.0.1:'+slow.address().port+'/',p=path.join(f.dir,'slow-download');
 const short=await checkUpdate({root:f.root,state:f.state,urls:f.urls,artifactFetchTimeout:50});
 await assert.rejects(short.artifactUpdater.downloadTarget(short.artifact,p,url));assert(!fs.existsSync(p));
 await c.artifactUpdater.downloadTarget(c.artifact,p,url);assert.equal(fs.readFileSync(p,'utf8'),'archive fixture');
 changed=true;await assert.rejects(c.artifactUpdater.downloadTarget(c.artifact,path.join(f.dir,'bad-slow'),url));assert(!fs.existsSync(path.join(f.dir,'bad-slow')));
});
test('one target signature cannot authorize a package',async t=>{const f=await fixture(t);const roles=f.a.roles.targets;roles.threshold=1;f.publish();await assert.rejects(f.check());});
test('tampered archive is rejected before extraction',async t=>{const f=await fixture(t);f.publish({mutate:c=>c['/targets/'+f.d.artifact]=Buffer.from('tampered bytes!')});const c=await f.check();await assert.rejects(c.updater.downloadTarget(c.artifact,path.join(f.dir,'bad'),f.urls.targets));});
test('expired timestamp is rejected without changing saved wallet data',async t=>{const f=await fixture(t);writeJSON(path.join(f.state,'wallet/sentinel.json'),{balance:'123',key:'qa-only'});const before=fs.readFileSync(path.join(f.state,'wallet/sentinel.json'));f.publish({timestampDays:-1});await assert.rejects(f.check());assert.deepEqual(fs.readFileSync(path.join(f.state,'wallet/sentinel.json')),before);});
test('metadata rollback and release sequence rollback are both rejected',async t=>{const f=await fixture(t);f.publish({version:2});await f.check();f.publish({version:1});await assert.rejects(f.check());f.publish({version:3,descriptor:{...f.d,sequence:18}});await assert.rejects(f.check(),/sequence rollback/);});
test('a newer signed metadata version cannot silently replace the same release sequence',async t=>{const f=await fixture(t);await f.check();f.publish({version:2,descriptor:{...f.d,summary:'changed content'}});await assert.rejects(f.check(),/same sequence/);});
test('wrong network, edition, platform and artifact origin fail closed',async t=>{const f=await fixture(t);for(const change of [{networkPin:'c'.repeat(64)},{edition:'server'},{platform:'windows-x64'},{artifactBaseUrl:'https://attacker.example/'},{dataFormat:2}])assert.throws(()=>validateOffer({...f.d,...change},f.r));});
test('only a compatible home rollout is automatic; servers and migrations never are',async t=>{const f=await fixture(t);assert(automaticEligible(f.d,f.r,'install'));for(const change of [{protocolChange:true},{dataMigration:true},{rolloutPercent:0},{autoFrom:[]},{notBefore:new Date(Date.now()+600000).toISOString()}])assert(!automaticEligible({...f.d,...change},f.r,'install'));assert(!automaticEligible(f.d,{...f.r,edition:'server'},'install'));});
test('traversal and duplicate TAR entries fail before extraction',async()=>{const dir=temp(),file=path.join(dir,'input');fs.mkdirSync(file);fs.writeFileSync(path.join(file,'value'),'must not escape');for(const [label,options,entries]of [['traversal',{prefix:'../escape'},['value']],['duplicate',{prefix:'Package'},['value','value']]]){const archive=path.join(dir,label+'.tgz');await tar.c({cwd:file,file:archive,gzip:true,...options},entries);await assert.rejects(extractPackage(archive,path.join(dir,label),'Package','linux-x64'));}assert(!fs.existsSync(path.join(dir,'escape')));});
test('complete package is staged, launch pointer stays unset, wallet stays intact',async t=>{const f=await fixture(t),top=path.join(f.dir,f.d.folder);fs.mkdirSync(top);const files={'update-root.json':f.trust,'release-config.json':Buffer.from(JSON.stringify({...f.r,version:f.d.version}))};for(const n of ['start.sh','install.sh','runtime/node','sunphi-network-next/checkpoint-trial/build/duebyte-abci','sunphi-network-next/.local/bft-runtime/bin/cometbft'])files[n]=Buffer.from('fixture');for(const [n,b]of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(top,n)),{recursive:true});fs.writeFileSync(path.join(top,n),b);}writeJSON(path.join(top,'manifest.json'),{version:f.d.version,edition:f.d.edition,platform:f.d.platform,files:Object.fromEntries(Object.entries(files).map(([n,b])=>[n,sha256(b)]))});f.d.manifestSha256=sha256(fs.readFileSync(path.join(top,'manifest.json')));const archive=path.join(f.dir,'package.tgz');await tar.c({cwd:f.dir,file:archive,gzip:true},[f.d.folder]);f.publish({payload:fs.readFileSync(archive)});writeJSON(path.join(f.state,'wallet/retained.json'),{amount:'900'});const c=await f.check(),phases=[],s=await stageUpdate(c,{state:f.state,artifactBaseUrl:f.urls.targets,onPhase:phase=>phases.push(phase)});assert.deepEqual(phases,['extracting','verifying']);verifyPackage(s.top,f.d);assert.equal(installedHome(f.state,loadRelease(f.root)),null);assert.equal(JSON.parse(fs.readFileSync(path.join(f.state,'wallet/retained.json'))).amount,'900');fs.writeFileSync(path.join(s.top,'unexpected'),'extra');assert.throws(()=>verifyPackage(s.top,f.d),/Unexpected/);await assert.rejects(stageUpdate(c,{state:f.state,artifactBaseUrl:f.urls.targets}),/Unexpected/);assert.deepEqual(fs.readdirSync(path.join(f.state,'updates/staging')),[],'Successful and failed staging must not leave scratch copies');});
for(const phase of ['ready','starting','crash'])test('real child-process update handoff: '+phase+' retains wallet and correct executable pointer',async t=>{const f=await fixture(t),top=path.join(f.state,'updates/releases',f.d.folder);fs.mkdirSync(top,{recursive:true});const files={'update-root.json':f.trust,'release-config.json':Buffer.from(JSON.stringify({...f.r,version:f.d.version}))};for(const [n,b]of Object.entries(files))fs.writeFileSync(path.join(top,n),b);writeJSON(path.join(top,'manifest.json'),{version:f.d.version,edition:f.d.edition,platform:f.d.platform,files:Object.fromEntries(Object.entries(files).map(([n,b])=>[n,sha256(b)]))});f.d.manifestSha256=sha256(fs.readFileSync(path.join(top,'manifest.json')));writeJSON(path.join(f.root,'connection-profile.json'),{basePort:31580,walletPort:31589});writeJSON(path.join(f.state,'wallet/retained.json'),{balance:'900',sequence:17});const sentinel=fs.readFileSync(path.join(f.state,'wallet/retained.json')),ticket=randomUUID(),pending=path.join(f.state,'updates','pending-'+ticket+'.json'),oldTop=process.platform==='win32'?path.resolve(f.root,'../..'):f.root;
 const parentPid=Number(execFileSync(process.execPath,['-p','process.pid'],{encoding:'utf8',windowsHide:true})),staged={descriptor:f.d,descriptorSha256:'c'.repeat(64),top};writeJSON(pending,{schema:1,ticket,parentPid,oldTop,state:f.state,staged,connect:true,createdAt:new Date().toISOString()});const launches=[];let child;
 const result=await runHomeUpdate(pending,{root:f.root,healthAttempts:2,check:async()=>({available:true,descriptor:f.d,descriptorSha256:staged.descriptorSha256}),launch:(target,options)=>{launches.push(target);if(target===oldTop)return {};const health=path.join(f.state,'updates/health',ticket+'.json');fs.mkdirSync(path.dirname(health),{recursive:true});const script=phase==='crash'?'process.exit(1)':`require('fs').writeFileSync(${JSON.stringify(health)},JSON.stringify({ticket:${JSON.stringify(ticket)},pid:process.pid,version:'0.3.19',phase:${JSON.stringify(phase)}}));setTimeout(()=>{},10000);`;child=spawn(process.execPath,['-e',script],{windowsHide:true,stdio:'ignore'});t.after(()=>child?.kill());return child;}});
 assert.equal(result.passed,phase==='ready');assert.deepEqual(fs.readFileSync(path.join(f.state,'wallet/retained.json')),sentinel);const pointer=JSON.parse(fs.readFileSync(path.join(f.state,'updates/installed.json')));if(phase==='ready'){assert.equal(pointer.top,top);assert.deepEqual(launches,[top]);}else{assert(pointer.disabled);assert.deepEqual(launches,[top,oldTop]);}
});

async function packageBytes(f,version){
 const folder=`DueByte-Home-${version}-Linux-x64`,top=path.join(f.dir,folder);
 fs.mkdirSync(top);const files={'update-root.json':f.trust,'release-config.json':Buffer.from(JSON.stringify({...f.r,version})),'connection-profile.json':Buffer.from(JSON.stringify({basePort:31580,walletPort:31589}))};
 for(const n of ['start.sh','install.sh','runtime/node','sunphi-network-next/checkpoint-trial/build/duebyte-abci','sunphi-network-next/.local/bft-runtime/bin/cometbft'])files[n]=Buffer.from('isolated fixture');
 for(const [n,b]of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(top,n)),{recursive:true});fs.writeFileSync(path.join(top,n),b);}
 writeJSON(path.join(top,'manifest.json'),{version,edition:f.r.edition,platform:f.r.platform,files:Object.fromEntries(Object.entries(files).map(([n,b])=>[n,sha256(b)]))});
 const file=path.join(f.dir,folder+'.tgz');await tar.c({cwd:f.dir,file,gzip:true},[folder]);
 return {payload:fs.readFileSync(file),descriptor:{...f.d,version,folder,artifact:folder+'.tar.gz',artifactBaseUrl:`https://github.com/leges-universum/sunphi/releases/download/duebyte-v${version}/`,manifestSha256:sha256(fs.readFileSync(path.join(top,'manifest.json')))}};
}

test('two signed downloads and two real process handoffs preserve wallet and head sequence',async t=>{
 const f=await fixture(t),bridge=await packageBytes(f,'0.3.19'),head=await packageBytes(f,'0.3.20');
 head.descriptor.autoFrom=['0.3.19'];head.descriptor.sequence=20;
 const routes=Buffer.from(JSON.stringify({schema:1,version:'0.3.20',sequence:20,bridges:[bridge.descriptor]}));
 head.descriptor.routes={target:'routes-home-linux-x64.json',sha256:sha256(routes)};
 f.publish({descriptor:head.descriptor,payload:head.payload,extraTargets:{[head.descriptor.routes.target]:routes,[bridge.descriptor.artifact]:bridge.payload}});
 writeJSON(path.join(f.root,'connection-profile.json'),{basePort:31580,walletPort:31589});
 const wallet=path.join(f.state,'wallet/retained');fs.mkdirSync(path.dirname(wallet),{recursive:true});fs.writeFileSync(wallet,'unchanged encrypted wallet fixture');
 let root=f.root;
 for(const expected of ['0.3.19','0.3.20']){
  const checked=await checkUpdate({root,state:f.state,urls:f.urls});assert.equal(checked.descriptor.version,expected);
  const staged=await stageUpdate(checked,{state:f.state,artifactBaseUrl:f.urls.targets}),ticket=randomUUID(),pending=path.join(f.state,'updates','pending-'+ticket+'.json');
  const parentPid=Number(execFileSync(process.execPath,['-p','process.pid'],{encoding:'utf8',windowsHide:true}));
  writeJSON(pending,{schema:1,ticket,parentPid,oldTop:process.platform==='win32'?path.resolve(root,'../..'):root,state:f.state,staged,connect:false,createdAt:new Date().toISOString()});
  let child;
  try{
   const result=await runHomeUpdate(pending,{root,healthAttempts:4,check:()=>checkUpdate({root,state:f.state,urls:f.urls}),launch:(top)=>{
    assert.equal(top,staged.top);const health=path.join(f.state,'updates/health',ticket+'.json');fs.mkdirSync(path.dirname(health),{recursive:true});
    child=spawn(process.execPath,['-e',`require('fs').writeFileSync(${JSON.stringify(health)},JSON.stringify({ticket:${JSON.stringify(ticket)},pid:process.pid,version:${JSON.stringify(expected)},phase:'ready'}));setTimeout(()=>{},10000);`],{windowsHide:true,stdio:'ignore'});return child;
   }});
   assert(result.passed);assert.equal(JSON.parse(fs.readFileSync(path.join(f.state,'updates/installed.json'))).descriptor.version,expected);
  }finally{if(child){const ended=new Promise(r=>child.once('exit',r));child.kill();await ended;}}
  assert.equal(fs.readFileSync(wallet,'utf8'),'unchanged encrypted wallet fixture');root=staged.top;
 }
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.state,'updates/highest.json'))).version,'0.3.20');
});

for(const kind of ['held','removed-route','changed-descriptor'])test('fresh check prevents '+kind+' installation after staging',async t=>{
 const f=await fixture(t),pkg=await packageBytes(f,'0.3.19');f.publish({descriptor:pkg.descriptor,payload:pkg.payload});
 writeJSON(path.join(f.root,'connection-profile.json'),{basePort:31580,walletPort:31589});
 const checked=await f.check(),staged=await stageUpdate(checked,{state:f.state,artifactBaseUrl:f.urls.targets});
 const next={...pkg.descriptor,sequence:20,...(kind==='held'?{rolloutPercent:0}:kind==='removed-route'?{autoFrom:[]}:{summary:'revoked previous offer'})};
 f.publish({descriptor:next,payload:pkg.payload,version:2});
 const ticket=randomUUID(),pending=path.join(f.state,'updates','pending-'+ticket+'.json'),oldTop=process.platform==='win32'?path.resolve(f.root,'../..'):f.root;
 const parentPid=Number(execFileSync(process.execPath,['-p','process.pid'],{encoding:'utf8',windowsHide:true}));
 writeJSON(pending,{schema:1,ticket,parentPid,oldTop,state:f.state,staged,connect:false,createdAt:new Date().toISOString()});
 const launches=[];const result=await runHomeUpdate(pending,{root:f.root,check:()=>f.check(),launch:top=>{launches.push(top);return {};}});
 assert(!result.passed);assert.deepEqual(launches,[oldTop]);assert(!fs.existsSync(path.join(f.state,'updates/installed.json')));
});
