// UI supplies only an expiring review token. All paths and commands are local.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {acquireStateAccess} from './state-access.mjs';
import {loadRelease,readJSON,writeJSON,sha256} from './update-core.mjs';
import {hash} from './crypto.mjs';

function syncDirectory(directory){const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function persistRegistry(file,value){writeJSON(file,value);const fd=fs.openSync(file,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDirectory(dirname(file));}

export function serverInstallationPlan({root,state,prefix='/opt/duebyte-server'}){
 const release=loadRelease(root);assert.equal(release.edition,'server');assert(/^\/opt\/[a-zA-Z0-9_-]+$/.test(prefix));assert(/^\/[a-zA-Z0-9_/-]+$/.test(state));
 const profile=readJSON(join(root,'connection-profile.json'));assert.equal(hash(profile),release.networkPin);assert.equal(readJSON(join(root,'connection-pin.json')).sha256,release.networkPin);
 const unit=prefix==='/opt/duebyte-server'?'duebyte-archive.service':'duebyte-'+prefix.split('/').at(-1)+'-archive.service';
 const directory=join(state,'archive-node'),argv=[join(root,'runtime/node'),join(root,'sunphi-network-next/checkpoint-trial/server-node-runner.mjs'),'run',directory];
 assert(argv.every(a=>/^\/[a-zA-Z0-9_./-]+$/.test(a)||a==='run'));
 const service='[Unit]\nDescription=DueByte full-history participant\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=300\nStartLimitBurst=3\n[Service]\nType=simple\nExecStart='+argv.join(' ')+'\nRestart=on-failure\nRestartSec=10\nKillMode=control-group\nTimeoutStopSec=30\nUMask=0077\nNoNewPrivileges=yes\n[Install]\nWantedBy=multi-user.target\n';
 return {unit,directory,argv,service,version:release.version,network:profile.config.chainId,profileHash:release.networkPin};
}
export function installServerNode({root,state,registry,prefix,systemDirectory='/etc/systemd/system',run=(...args)=>execFileSync('systemctl',args,{timeout:30000,stdio:'pipe'})}){
 assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);const plan=serverInstallationPlan({root,state,prefix});
 fs.mkdirSync(state,{recursive:true,mode:0o700});const unlock=acquireStateAccess(state);
 try{
  const rows=fs.existsSync(registry)?readJSON(registry).instances:[];assert(Array.isArray(rows)&&rows.length<64);const prior=rows.find(r=>r.unit===plan.unit);
  if(prior){assert.equal(prior.role,'archive');assert.deepEqual(prior.argv,plan.argv,'Existing service belongs to another reviewed package');}
  else assert(!rows.length,'Use existing managed services; initial installation is only for an empty server');
  const file=join(systemDirectory,plan.unit);
  if(fs.existsSync(file)){assert(fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink());assert.equal(sha256(fs.readFileSync(file)),prior?.unitBodyHash??sha256(plan.service),'Existing service retained');}
  else {fs.writeFileSync(file,plan.service,{flag:'wx',mode:0o644,flush:true});syncDirectory(systemDirectory);}
  // Register before enabling. An interrupted installation is visible and safely
  // resumable; it cannot leave an unmanaged auto-started service.
  if(!prior){rows.push({unit:plan.unit,role:'archive',argv:plan.argv,version:plan.version,unitBodyHash:sha256(plan.service)});persistRegistry(registry,{instances:rows});}
  run('daemon-reload');
  // A freshly written unit has no failed runtime state yet. Querying it loads
  // its definition; reset only an actual failure, including start-rate limits.
  if(String(run('show',plan.unit,'-p','ActiveState','--value')).trim()==='failed')run('reset-failed',plan.unit);
  run('enable','--now',plan.unit);return {unit:plan.unit,status:'started'};
 }finally{unlock();}
}
