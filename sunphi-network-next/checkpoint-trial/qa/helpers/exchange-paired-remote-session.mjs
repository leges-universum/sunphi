// Native exchange rehearsal with journals in separate physical fault domains.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';import {createServer,connect} from 'node:net';
import {randomBytes,X509Certificate} from 'node:crypto';
import {SourceTextModule} from 'node:vm';
import {remote,run,upload,hosts,sshArgs} from '../admin-remote.mjs';
import {hash,digest} from '../../crypto.mjs';
import {remoteCoordinator} from '../../research/exchange-coordinator-service.mjs';
import {pairedCoordinator,recoveryProtectedCoordinator} from '../../research/exchange-coordinator-continuity.mjs';

export async function pairedRemoteSession(out,config,id,protectBoth=false){
 assert(/^r[1-9][0-9]*$/.test(id));
 const output=path.join(out,'paired-journals'),root='/var/lib/duebyte-qa-continuity56-'+id;
 assert(!fs.existsSync(output));fs.mkdirSync(output);const privateDir=output+'/private';fs.mkdirSync(privateDir);
const source=path.resolve(import.meta.dirname,'../..'),runtime='/opt/duebyte-server/releases/0.3.55/runtime/node';
const scope=hash(config),events=[],members=[],tunnels=[],sourceFiles=new Set();
function visit(file){if(sourceFiles.has(file))return;assert(/^[a-zA-Z0-9_./-]+\.mjs$/.test(file));sourceFiles.add(file);
 const m=new SourceTextModule(fs.readFileSync(path.join(source,file),'utf8'));for(const s of m.dependencySpecifiers)if(s.startsWith('.')){const f=path.resolve(source,path.dirname(file),s);assert(f.startsWith(source+path.sep));visit(path.relative(source,f).replaceAll('\\','/'));}}
visit('qa/helpers/continuity-host.mjs');
fs.writeFileSync(output+'/sources.txt',[...sourceFiles].sort().join('\n')+'\n');
fs.writeFileSync(output+'/manifest.json',JSON.stringify([...sourceFiles].sort().map(file=>({file,sha256:digest(fs.readFileSync(path.join(source,file)))})),null,2));
await run('tar.exe',['-cf',output+'/source.tar','-C',source,'-T',output+'/sources.txt']);const sourceHash=digest(fs.readFileSync(output+'/source.tar'));
const ssl=args=>assert.equal(spawnSync('C:/Program Files/Git/usr/bin/openssl.exe',args,{cwd:privateDir,windowsHide:true,stdio:'ignore'}).status,0,'isolated certificate generation failed');
ssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','1','-subj','/CN=DueByte isolated continuity CA']);
const read=name=>fs.readFileSync(privateDir+'/'+name,'utf8');
function certificate(name,server){ssl(['req','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN='+name]);
 fs.writeFileSync(privateDir+'/'+name+'.ext',server?'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth':'extendedKeyUsage=clientAuth');
 ssl(['x509','-req','-in',name+'.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out',name+'.pem','-days','1','-extfile',name+'.ext']);
 return {key:read(name+'.key'),cert:read(name+'.pem'),fingerprint:new X509Certificate(read(name+'.pem')).fingerprint256};}

 const client=certificate('client',false);
 function record(name,extra={}){const event={name,at:new Date().toISOString(),...extra};events.push(event);fs.writeFileSync(output+'/events.json',JSON.stringify(events,null,2));console.log('PAIR '+JSON.stringify(event));}
 async function put(host,file,to){const staging='/tmp/duebyte-continuity56-'+id+'-upload-'+randomBytes(6).toString('hex'),incoming=staging+'/data';
 await run('ssh.exe',[...sshArgs,hosts[host],'bash -s'],`set -eu\numask 077\nmkdir '${staging}'\n`);
 await upload(host,file,incoming);await remote(host,`install -m 600 '${incoming}' '${to}'\nrm -- '${incoming}'\nrmdir '${staging}'\n`);}
async function privateRead(host,file){return JSON.parse(await remote(host,`cat '${file}'\n`));}
async function fetchFile(host,file,to){const bytes=Buffer.from(await remote(host,`base64 -w0 '${file}'\n`),'base64');assert(bytes.length<16*1024*1024);assert.equal(digest(bytes),(await remote(host,`sha256sum '${file}'\n`)).split(' ')[0]);fs.writeFileSync(to,bytes);}
async function stop(m,kill=false){if(!m.started)return;await remote(m.host,kill?`systemctl kill --kill-whom=main --signal=KILL '${m.unit}'\n`:`systemctl stop '${m.unit}' 2>/dev/null || true\n`);
 for(let i=0;i<30;i++){const s=await remote(m.host,`ss -Hln sport = :${m.port}\n`);if(!s.includes('127.0.0.1:'+m.port)){m.started=false;return;}await new Promise(r=>setTimeout(r,100));}throw Error('isolated service did not stop');}
async function start(m){
 await remote(m.host,`systemctl reset-failed '${m.unit}' 2>/dev/null || true\nsystemd-run --quiet --unit='${m.unit}' --collect --property=RuntimeMaxSec=1800 --property=MemoryMax=256M --property=CPUQuota=40% --property=UMask=0077 --property=NoNewPrivileges=yes --property=ProtectSystem=strict --property='ReadWritePaths=${root}' --property=PrivateTmp=yes --property=TasksMax=32 '${runtime}' '${root}/source/qa/helpers/continuity-host.mjs' serve '${root}' '${m.label}'\n`);m.started=true;
 for(let i=0;i<30;i++){const s=await remote(m.host,`ss -Hln sport = :${m.port}\n`);if(s.includes('127.0.0.1:'+m.port))return;await new Promise(r=>setTimeout(r,100));}throw Error('isolated service not listening');
}
async function supervisor(m,command){assert(!m.started);return JSON.parse(await remote(m.host,`'${runtime}' '${root}/source/qa/helpers/continuity-host.mjs' ${command} '${root}' '${m.label}'\n`));}
async function tunnel(m){
 const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));let child;
 const t={port,async open(){child=spawn('ssh.exe',[...sshArgs,'-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','-N','-L',`127.0.0.1:${port}:127.0.0.1:${m.port}`,hosts[m.host]],{windowsHide:true,stdio:'ignore'});
  let failure;child.once('error',e=>{failure=e;});const until=Date.now()+15000;
  while(Date.now()<until){assert(!failure&&child.exitCode===null&&child.signalCode===null,'isolated SSH tunnel exited');
   const ready=await new Promise(resolve=>{const s=connect({host:'127.0.0.1',port});s.setTimeout(300);const done=v=>{s.destroy();resolve(v);};s.once('connect',()=>done(true));s.once('error',()=>done(false));s.once('timeout',()=>done(false));});
   if(ready)return;await new Promise(r=>setTimeout(r,100));}throw Error('isolated tunnel readiness timeout');},
 async close(){if(!child||child.exitCode!==null||child.signalCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill();await done;}};
 tunnels.push(t);await t.open();return t;
}
async function provision(group,role,host,port,recovered){
 const label=group+'-'+role,dir=root+'/'+label,tls=certificate(label,true),m={label,role:role.endsWith('witness')?'witness':role==='recovery'?'recovery':'primary',host,port,tls,unit:'duebyte-qa-continuity56-'+id+'-'+label,started:false,dir};members.push(m);
 await remote(host,`test ! -e '${dir}'\nmkdir -m 700 '${dir}'\n`);
 const profile={file:dir+'/inventory.sqlite',config,role:m.role,port,clients:[client.fingerprint]},credentials={key:recovered?.key??randomBytes(32).toString('hex'),tlsKey:tls.key,tlsCert:tls.cert,tlsCA:read('ca.pem'),...(recovered?{continuity:recovered.continuity}:{})};
 for(const [name,value] of [['profile.json',profile],['credentials.json',credentials]]){const file=privateDir+'/'+label+'-'+name;fs.writeFileSync(file,JSON.stringify(value));await put(host,file,dir+'/'+name);}
 if(recovered){await put(host,recovered.localFile,profile.file);}else await supervisor(m,'init');
 m.credentials=await privateRead(host,dir+'/credentials.json');await start(m);m.tunnel=await tunnel(m);m.channel=channel(m);await m.channel.checkpoint(randomBytes(32).toString('hex'));console.log(JSON.stringify({ready:label,host}));return m;
}
function options(m){return {url:`https://127.0.0.1:${m.tunnel.port}/coordinate`,key:client.key,cert:client.cert,ca:read('ca.pem'),serverFingerprint:m.tls.fingerprint,timeoutMs:10000,continuity:m.credentials.continuity};}
function channel(m){return remoteCoordinator(options(m));}
function pair(p,w){return anchor?recoveryProtectedCoordinator(p.channel,w.channel,anchor.channel,scope):pairedCoordinator(p.channel,w.channel,scope);}

 let p,w,anchor,active,btcFault=false,evmFault=false,closed=false;
 async function close(){
  if(closed)return;closed=true;
  const services=await Promise.allSettled(members.map(m=>stop(m))),links=await Promise.allSettled(tunnels.map(t=>t.close()));
  fs.writeFileSync(output+'/cleanup.json',JSON.stringify({services:services.map(r=>r.status),tunnels:links.map(r=>r.status)},null,2));
  assert(services.every(r=>r.status==='fulfilled')&&links.every(r=>r.status==='fulfilled'),'isolated journal cleanup failed');
 }
 try{
  const probes=await Promise.allSettled([1,2,3].map(async host=>{
  const before=await remote(host,`hostname\ndf -Pk /var/tmp\ntest -x '${runtime}'\ntest ! -e '${root}'\nss -Hln sport = :29456\nss -Hln sport = :29457\nss -Hln sport = :29458\n`);
  assert(!before.includes('LISTEN'),'isolated port occupied');
  const incoming='/tmp/duebyte-continuity56-'+id+'-source.tar';await upload(host,output+'/source.tar',incoming);
  await remote(host,`test "$(sha256sum '${incoming}' | cut -d ' ' -f1)" = '${sourceHash}'\nmkdir -m 700 '${root}'\nmkdir -m 700 '${root}/source'\ntar -xf '${incoming}' -C '${root}/source'\nrm -- '${incoming}'\n`);return {host,before};
 }));for(const p of probes)if(p.status==='rejected')throw p.reason;fs.writeFileSync(output+'/hosts.json',JSON.stringify(probes.map(p=>p.value),null,2));

 p=await provision('clean','primary',2,29456);w=await provision('clean','witness',1,29456);
 if(protectBoth)anchor=await provision('clean','recovery',3,29456);
 active=pair(p,w);
 record('native-session-ready',{primaryHost:2,witnessHost:1,...(anchor?{recoveryHost:3}:{}),scope});
 return {
  get channel(){return active;},get options(){return {primary:options(p),witness:options(w),...(anchor?{recovery:options(anchor)}:{})};},
  get evidence(){return events;},
  async execute(asset,purpose,operation,count){
   if(asset==='BTC'&&purpose==='FUNDING'&&!btcFault){
    btcFault=true;const before=count();
    for(const [name,m] of [['primary',p],['witness',w],...(anchor?[['recovery',anchor]]:[])]){
     await m.tunnel.close();try{await assert.rejects(operation);assert.equal(count(),before);}finally{await m.tunnel.open();}
     record('native-BTC-'+name+'-partition-no-signature');
    }
    if(anchor){
     const originalP=p,originalW=w,oldPair=active;let exact;
     active=recoveryProtectedCoordinator(p.channel,{...w.channel,commit:async(_intent,_permit,result)=>{
      exact=structuredClone(result);await stop(originalP,true);await stop(originalW,true);throw Error('injected native dual journal loss');
     }},anchor.channel,scope);
     await assert.rejects(operation,/injected native dual journal loss/);assert.equal(count(),before+1);assert(exact);
     record('native-BTC-recovery-durable-both-working-journals-killed',{transaction:exact.transaction});
     await stop(anchor);const report=await supervisor(anchor,'recover-pair'),recovered=await privateRead(anchor.host,anchor.dir+'/pair-recovery-private.json');
     for(const role of ['primary','witness']){
      const r=recovered[role];assert(r.file.startsWith(anchor.dir+'/coordinator-recovered-')&&r.file.endsWith('/inventory.sqlite'));
      r.localFile=privateDir+'/rebuilt-'+role+'.sqlite';await fetchFile(anchor.host,r.file,r.localFile);
     }
     anchor.credentials=await privateRead(anchor.host,anchor.dir+'/credentials.json');await start(anchor);anchor.channel=channel(anchor);
     p=await provision('clean','rebuilt-primary',2,29457,recovered.primary);
     w=await provision('clean','rebuilt-witness',1,29457,recovered.witness);active=pair(p,w);
     const replay=await operation();assert.deepEqual(replay,exact);assert.equal(count(),before+1);
     await start(originalP);await start(originalW);await assert.rejects(()=>oldPair.checkpoint());await stop(originalP);await stop(originalW);
     record('native-BTC-both-journals-rebuilt-exact-replay-old-profile-fenced',{recovery:report});return replay;
    }
    const original=p,oldPair=active;let exact;
    active=pairedCoordinator({...p.channel,commit:async(_intent,_permit,result)=>{exact=structuredClone(result);await stop(original,true);throw Error('injected native primary crash');}},w.channel,scope);
    await assert.rejects(operation,/injected native primary crash/);assert.equal(count(),before+1);assert(exact);
    record('native-BTC-signed-witness-durable-primary-killed',{transaction:exact.transaction});
    await stop(w);const report=await supervisor(w,'recover'),recovered=await privateRead(w.host,w.dir+'/recovery-private.json');
    assert(recovered.file.startsWith(w.dir+'/coordinator-recovered-')&&recovered.file.endsWith('/inventory.sqlite'));
    recovered.localFile=privateDir+'/restored-inventory.sqlite';await fetchFile(w.host,recovered.file,recovered.localFile);
    w.credentials=await privateRead(w.host,w.dir+'/credentials.json');await start(w);w.channel=channel(w);
    p=await provision('clean','replacement',3,29456,recovered);active=pair(p,w);
    const replay=await operation();assert.deepEqual(replay,exact);assert.equal(count(),before+1);
    await start(original);await assert.rejects(()=>oldPair.checkpoint());await stop(original);
    record('native-BTC-third-host-recovery-exact-replay-old-authority-fenced',{replacementHost:3,recovery:report});
    return replay;
   }
   if(asset==='USDC'&&purpose==='PAYOUT'&&!evmFault){
    evmFault=true;const before=count(),saved=await operation();assert.equal(count(),before+1);
    const all=[p,w,...(anchor?[anchor]:[])];for(const m of all)await m.tunnel.close();
    try{await assert.rejects(operation);assert.equal(count(),before+1);}finally{for(const m of all)await m.tunnel.open();}
    const replay=await operation();assert.deepEqual(replay,saved);assert.equal(count(),before+1);
    record('native-USDC-durable-signature-total-link-loss-exact-replay',{transaction:replay.transaction});return replay;
   }
   return operation();
  },
  async stop(role='primary'){const m=role==='recovery'?anchor:role==='witness'?w:p;assert(m);await stop(m);},
  async start(role='primary'){const m=role==='recovery'?anchor:role==='witness'?w:p;assert(m);await start(m);},
  async restart(){for(const m of [p,w,...(anchor?[anchor]:[])]){await stop(m,true);await start(m);}},
  async status(){const all=[p,w,...(anchor?[anchor]:[])];for(const m of all)await stop(m);
   try{const a=await supervisor(p,'status');for(const m of all.slice(1))assert.deepEqual(a.status,(await supervisor(m,'status')).status);
    assert(btcFault&&evmFault,'native fault coverage incomplete');return a.status;
   }finally{for(const m of all)await start(m);}},
  close
 };
 }catch(e){await close();throw e;}
}

