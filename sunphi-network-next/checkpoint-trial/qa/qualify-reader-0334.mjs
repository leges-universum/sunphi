import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
const source=path.resolve(import.meta.dirname,'..'),work='D:/CodexData/duebyte-editions-0.3.34',dest=work+'/qualification/app';
const tests=['economic-policy-v2','economic-preparation','ecosystem-century-model','consumer-version','authority','network-reserves','payment-liability','reserve-recovery','wallet','delayed-payment','resource-limits','spend-protection','server-maintenance','catchup-recovery','bootstrap-recovery','consumer-errors','consumer-dashboard','updates','home-boot-health','windows-registry'];
assert(!fs.existsSync(dest));fs.mkdirSync(path.dirname(dest),{recursive:true});
fs.cpSync(work+'/packages-release/DueByte-Home-0.3.34-Windows-x64/resources/app',dest,{recursive:true});
const trial=dest+'/sunphi-network-next/checkpoint-trial';
fs.cpSync(source+'/test',trial+'/test',{recursive:true});
// Only test harness and fixtures may be added; shipped runtime remains immutable.
fs.mkdirSync(dest+'/sunphi-network-next/research/transition-core-20261103',{recursive:true});
for(const f of ['fixture.mjs','model.mjs'])fs.copyFileSync(path.resolve(source,'../research/transition-core-20261103',f),dest+'/sunphi-network-next/research/transition-core-20261103/'+f);
fs.mkdirSync(trial+'/qa',{recursive:true});fs.copyFileSync(source+'/qa/update-signing.mjs',trial+'/qa/update-signing.mjs');
// Offline custody helper is used by fixtures only and is not a runtime dependency.
fs.copyFileSync(source+'/reserve-management-vault.mjs',trial+'/reserve-management-vault.mjs');
for(const f of ['qualify.mjs','qualify-lifecycle.mjs'])fs.copyFileSync(source+'/'+f,trial+'/'+f);
for(const f of fs.readdirSync(source+'/qa').filter(f=>f.endsWith('.mjs')&&/network|lifecycle/.test(f)))fs.copyFileSync(source+'/qa/'+f,trial+'/qa/'+f);
fs.writeFileSync(work+'/qualification/test-list.json',JSON.stringify(tests));
const run=spawnSync(process.execPath,['--test','--test-concurrency=1',...tests.map(n=>'test/'+n+'.test.mjs')],{cwd:trial,encoding:'utf8',windowsHide:true,timeout:300000,maxBuffer:16*1024*1024});
fs.writeFileSync(work+'/qualification/windows.log',run.stdout+run.stderr);assert.equal(run.status,0,(run.stdout+run.stderr).slice(-9000));
console.log(run.stdout.slice(-500));
