// Compatibility-first release. Pending precision and reward changes are excluded.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {sha256,readJSON,verifyPackage} from '../update-core.mjs';
const prior='D:/CodexData/duebyte-editions-0.3.33',work='D:/CodexData/duebyte-editions-0.3.34',out=work+'/packages-release',source=path.resolve(import.meta.dirname,'..');
assert(!fs.existsSync(out),'Immutable build exists');fs.mkdirSync(out,{recursive:true});
for(const f of ['connection-profile.json','connection-pin.json','update-root.json'])fs.copyFileSync(prior+'/'+f,work+'/'+f,fs.constants.COPYFILE_EXCL);
const run=(exe,args)=>{const r=spawnSync(exe,args,{windowsHide:true,encoding:'utf8',timeout:600000});assert.equal(r.status,0,r.stderr);};
let core=fs.readFileSync(source+'/core.mjs','utf8');
for(const line of core.split('\n').filter(s=>s.includes('PRECISION_ACTION')||s.includes('payment denomination mismatch')))core=core.replace(line+'\n','');
assert(!core.includes('token-precision')&&!core.includes('unitScale'));
const overlays=['consumer-runner.mjs','consumer-version.mjs','economic-preparation.mjs','economic-policy-v2.mjs','ecosystem-century-model.mjs'];
const releases=[],changes=[];
for(const p of readJSON(prior+'/packages-release/release.json').releases){
 const win=p.platform==='windows-x64',oldRoot=p.folder+(win?'/resources/app':''),descriptor=readJSON(prior+'/updates/stable/targets/'+p.edition+'-'+p.platform+'.json');verifyPackage(p.folder,descriptor);
 const name=path.basename(p.folder).replace('0.3.33','0.3.34'),folder=out+'/'+name;fs.cpSync(p.folder,folder,{recursive:true});const root=folder+(win?'/resources/app':''),manifest=readJSON(root+'/manifest.json');
 const write=(name,data)=>{fs.writeFileSync(root+'/'+name,data);manifest.files[name]=sha256(data);};
 write('sunphi-network-next/checkpoint-trial/core.mjs',core);
 for(const f of overlays){const b=fs.readFileSync(source+'/'+f);assert(!/[\u0400-\u04ff]/.test(b.toString()));write('sunphi-network-next/checkpoint-trial/'+f,b);}
 for(const f of ['consumer.html','wallet.html']){const name='sunphi-network-next/checkpoint-trial/'+f;write(name,fs.readFileSync(root+'/'+name,'utf8').replaceAll('0.3.33','0.3.34'));}
 for(const name of ['release-config.json','package.json']){const value=readJSON(root+'/'+name);assert.equal(value.version,'0.3.33');value.version='0.3.34';write(name,JSON.stringify(value));}
 if(!win){const name='install.sh';write(name,fs.readFileSync(root+'/'+name,'utf8').replaceAll('0.3.33','0.3.34'));}
 manifest.version='0.3.34';fs.writeFileSync(root+'/manifest.json',JSON.stringify(manifest));
 const old=readJSON(oldRoot+'/manifest.json'),changed=Object.keys(manifest.files).filter(n=>manifest.files[n]!==old.files[n]);assert(Object.keys(old.files).every(n=>n in manifest.files));
 const allowed=[...overlays,'core.mjs','consumer.html','wallet.html','release-config.json','package.json','install.sh'];assert(changed.every(n=>allowed.includes(path.basename(n))));
 for(const f of ['payment-model.mjs','node-rewards.mjs','funded-reward-work.mjs','reward-worker.mjs','reward-coordinator.mjs','reward-scheduler.mjs'])assert.equal(manifest.files['sunphi-network-next/checkpoint-trial/'+f],old.files['sunphi-network-next/checkpoint-trial/'+f]);
 assert(!manifest.files['sunphi-network-next/checkpoint-trial/token-precision.mjs']);changes.push({edition:p.edition,platform:p.platform,changed});
 fs.writeFileSync(folder+'/START-HERE.txt',fs.readFileSync(folder+'/START-HERE.txt','utf8').replaceAll('0.3.33','0.3.34')+'\nEconomic preparation reader: supports the approved century plan without activating it. Home peers advertise the application version. Existing payment amounts, fees and reward rules are unchanged. No issuance. A separate coordinated action is required before writing a new economic plan to network history.\n');
 if(win)run(path.resolve(source,'../../sunphi-wander-lab/desktop/node_modules/electron-winstaller/vendor/rcedit.exe'),[folder+'/DueByte.exe','--set-file-version','0.3.34','--set-product-version','0.3.34']);
 const archive=folder+(win?'.zip':'.tar.gz');
 if(win)run('powershell.exe',['-NoProfile','-Command',`Compress-Archive -LiteralPath '${folder}' -DestinationPath '${archive}'`]);
 else{const w=folder.replace(/^([A-Z]):/,(_,d)=>'/mnt/'+d.toLowerCase());run('wsl.exe',['-d','SunPhiWanderProver','--','sh','-c',`chmod +x '${w}/start.sh' '${w}/install.sh' '${w}/runtime/node' '${w}/sunphi-network-next/checkpoint-trial/build/duebyte-abci' '${w}/sunphi-network-next/.local/bft-runtime/bin/cometbft' ${p.edition==='server'?"'"+w+"/duebyte-server'":''} && tar -czf '${w}.tar.gz' -C '${w}/..' '${name}'`]);}
 releases.push({...p,folder,archive,name:path.basename(archive),sha256:sha256(fs.readFileSync(archive)),bytes:fs.statSync(archive).size});console.log('Built '+name);
}
fs.writeFileSync(out+'/release.json',JSON.stringify({version:'0.3.34',profileHash:readJSON(work+'/connection-pin.json').sha256,releases},null,2));
fs.writeFileSync(work+'/source-changes.json',JSON.stringify({basedOn:'0.3.33',economicReader:true,precisionExcluded:true,rewardRulesUnchanged:true,changes},null,2));
