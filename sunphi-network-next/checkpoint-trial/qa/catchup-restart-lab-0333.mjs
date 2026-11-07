// Unfunded isolated follower; inject stale UI observations, not ledger data.
// Exercise the real graceful restart against unchanged production protocol.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';import {fork} from 'node:child_process';
import {hash} from '../crypto.mjs';import {sha256,readJSON} from '../update-core.mjs';
const work='D:/CodexData/duebyte-editions-0.3.33',root=work+'/packages-release/DueByte-Home-0.3.33-Windows-x64/resources/app',code=root+'/sunphi-network-next/checkpoint-trial',lab=work+'/restart-lab-'+Date.now();fs.mkdirSync(lab);
let runner=fs.readFileSync(code+'/consumer-runner.mjs','utf8');
runner=runner.replace(/from ['"]\.\/([^'"]+)['"]/g,(_,f)=>'from '+JSON.stringify(pathToFileURL(code+'/'+f).href));
runner=runner.replace('here=import.meta.dirname','here='+JSON.stringify(code));
runner='let qaRecovered=false;\n'+runner.replace('async function retryBootstrap(catchup=false){','async function retryBootstrap(catchup=false){\n if(catchup){qaRecovered=true;process.send?.({qaRestart:true});}');
const marker=' const initialAction=recovery.observe(current)';assert(runner.includes(marker));
runner=runner.replace(marker,` if(!qaRecovered&&Number(current.height)>1000&&current.catchingUp===false){current.height=String(Number(current.height)-1000);current.time=new Date(Date.now()-14400000).toISOString();}\n`+marker);
const file=lab+'/runner.mjs';fs.writeFileSync(file,runner);
const p=readJSON(root+'/connection-profile.json'),url=s=>{const u=new URL(s);u.port=String(Number(u.port)+3000);return u.href;};p.basePort+=3000;p.walletPort+=3000;p.hosts.forEach(h=>h.forwards=h.forwards.map(([l,r])=>[l+3000,r]));p.peers.forEach(x=>x.port+=3000);p.rpcServers=p.rpcServers.map(url);p.workers=Object.fromEntries(Object.entries(p.workers).map(([k,v])=>[k,url(v)]));
fs.writeFileSync(lab+'/profile.json',JSON.stringify(p));
const state=lab+'/state',fd=fs.openSync(lab+'/runner.log','a'),child=fork(file,[lab+'/profile.json',hash(p),state],{execPath:root+'/runtime/node.exe',windowsHide:true,stdio:['ignore',fd,fd,'ipc']});fs.closeSync(fd);
let latest,failed,exit,restarts=0,originalPid,retained;const closed=new Promise(r=>child.once('close',(code,signal)=>{exit={code,signal};r();}));
child.on('message',m=>{if(m.rpc)latest=m;if(m.progress==='failed')failed=m.error;if(m.qaRestart)restarts++;});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
try{
 const start=Date.now();while(Date.now()-start<300000){
  assert(!failed&&!exit,failed||'Follower stopped');
  if(latest?.rpc&&Number(latest.rpc.height)>1000&&!retained){
   retained=['installation.json','reward-identity.json','node/config/node_key.json','node/config/priv_validator_key.json'].map(file=>({file,sha256:sha256(fs.readFileSync(state+'/'+file))}));
   originalPid=Number(fs.readFileSync(state+'/node/supervisor.lock'));console.log('Isolated follower ready; testing the two-minute recovery window');
  }
  if(restarts&&latest?.rpc&&!latest.rpc.catchingUp&&Date.now()-Date.parse(latest.rpc.time)<20000){
   const newPid=Number(fs.readFileSync(state+'/node/supervisor.lock'));assert.notEqual(newPid,originalPid);assert.equal(restarts,1);
   for(const f of retained)assert.equal(sha256(fs.readFileSync(state+'/'+f.file)),f.sha256);
   const wallet=await fetch('http://127.0.0.1:'+p.walletPort+'/');assert(wallet.ok);
   fs.mkdirSync(work+'/publication',{recursive:true});const result={passed:true,at:new Date().toISOString(),unfunded:true,isolated:true,observationInjection:true,realGracefulRestart:true,oldPid:originalPid,newPid,restarts,retainedFiles:retained.length,height:latest.rpc.height,walletAvailable:true,issuance:false};
   fs.writeFileSync(work+'/publication/restart-lab.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));break;
  }
  await delay(500);
 }
 assert(fs.existsSync(work+'/publication/restart-lab.json'),'Recovery test timeout');
}finally{if(!exit&&child.connected)child.send({command:'stop'});await Promise.race([closed,delay(20000)]);assert(exit,'Test follower did not stop safely');console.log('Isolated follower stopped');}
