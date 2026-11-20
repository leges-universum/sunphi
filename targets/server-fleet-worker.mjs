// Restricted maintenance worker. The operator provisions the local unit roster.
// Requests contain a node ID and a signed target digest, never a URL or command.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as wait} from 'node:timers/promises';
import {rollingMaintenanceEvidence} from './server-maintenance.mjs';

const json=file=>JSON.parse(fs.readFileSync(file));
const system=(...args)=>execFileSync('systemctl',args,{encoding:'utf8',timeout:90000}).trim();
const roster=json('/etc/duebyte-fleet/nodes.json');
const [action,id,digest]=process.argv.slice(2);
assert(/^[0-9a-f]{64}$/.test(id)&&Object.hasOwn(roster,id));
const {unit,chain}=roster[id];
assert(/^duebyte-[a-z0-9-]+\.service$/.test(unit));
const registry='/etc/duebyte-server/instances.json';
const entries=json(registry),candidate=unit==='duebyte-candidate.service';
const mainArgs=()=>fs.readFileSync('/proc/'+system('show',unit,'-p','MainPID','--value')+'/cmdline','utf8').split('\0').filter(Boolean);
const row=candidate?{role:'candidate',argv:mainArgs()}:entries.instances.find(r=>r.unit===unit);
assert((candidate||row?.role==='validator')&&row.argv[2]==='run');
const runtime=()=>fs.realpathSync('/proc/'+system('show',unit,'-p','MainPID','--value')+'/exe');
const root=path.resolve(runtime(),'../..');
assert(/^\/opt\/duebyte-server\/releases\/\d+\.\d+\.\d+$/.test(root)&&runtime()===root+'/runtime/node');
const sub='/sunphi-network-next/checkpoint-trial/';
const core=await import(root+sub+'update-core.mjs');
const release=core.loadRelease(root),state='/var/lib/duebyte-server-updates/fleet';
assert.equal(release.edition,'server');assert.equal(path.basename(root),release.version);
const candidateSource='/usr/local/lib/duebyte-connect/validator-candidate.mjs';
if(candidate){
 assert.equal(row.argv.length,5);assert.equal(row.argv[3],'/var/lib/duebyte-server-updates/archive-node');
 assert(/^[A-Za-z0-9_-]{43}$/.test(row.argv[4]));
 assert([candidateSource,'/etc/duebyte-fleet/candidates/'+release.version+'/runner.mjs'].includes(row.argv[1]));
}
const rpc=async(method,params={})=>{
 const port=candidate?28001:json(row.argv[3]+'/run-settings.json').basePort+1;
 assert(Number.isInteger(port)&&port>1024&&port<=65535);
 const r=await fetch('http://127.0.0.1:'+port,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(5000)});
 const data=await r.json();assert(r.ok&&!data.error&&data.result);return data.result;
};
async function evidence(afterHeight){
 const s=await rpc('status');assert.equal(s.node_info.network,chain);
 if(candidate)assert.equal(s.validator_info.address,roster[id].validatorAddress);
 return rollingMaintenanceEvidence(rpc,s,{afterHeight});
}
function eligible(c){
 if(coordinated(c))return true;
 const included=d=>Date.now()>=Date.parse(d.notBefore)&&!d.protocolChange&&!d.dataMigration&&
  parseInt(core.sha256(id+':'+d.version).slice(0,8),16)%100<d.rolloutPercent;
 return c.available&&c.routeAvailable&&c.descriptor.autoFrom.includes(release.version)&&
  core.versionCompare(c.descriptor.version,release.version)>0&&included(c.descriptor)&&included(c.channelDescriptor);
}
// Only the signed channel head can authorize a tested protocol transition for
// enrolled, quorum-checked fleets. Ordinary unattended readers keep their gate.
function coordinated(c){
 const d=c.descriptor;
 return c.available&&d===c.channelDescriptor&&d.protocolChange===true&&d.dataMigration===false&&
  core.versionCompare(d.version,release.version)>0&&Date.now()>=Date.parse(d.notBefore)&&
  d.rolloutPercent===100&&d.fleetPredecessors?.[release.version]===core.sha256(fs.readFileSync(path.join(root,'manifest.json')));
}
async function stageProtocol(c,dir){
 const d=c.descriptor,archive=path.join(dir,d.artifact);
 core.requireUpdateSpace(dir,c.artifact.length);
 await c.artifactUpdater.downloadTarget(c.artifact,archive,d.artifactBaseUrl);
 const top=await core.extractPackage(archive,path.join(dir,'stage'),d.folder,d.platform);
 const verified=core.verifyPackage(top,d);assert.equal(verified.config.rootSha256,release.rootSha256);
 const executables=['runtime/node','sunphi-network-next/checkpoint-trial/build/duebyte-abci','sunphi-network-next/.local/bft-runtime/bin/cometbft'];
 for(const name of [...executables,'start.sh','install.sh','duebyte-server'])fs.chmodSync(path.join(top,name),0o755);
 if(fs.existsSync(path.join(top,'compat/v6/manifest.json')))for(const name of executables)fs.chmodSync(path.join(top,'compat/v6',name),0o755);
 return top;
}
async function apply(c){
 assert(eligible(c)&&digest===c.descriptorSha256,'Signed update changed');
 const d=c.descriptor,target='/opt/duebyte-server/releases/'+d.version;
 if(!fs.existsSync(target)){
  const scratch=fs.mkdtempSync('/opt/duebyte-server/releases/.fleet-');
  try{
   if(coordinated(c)){
    const top=await stageProtocol(c,scratch);fs.renameSync(top,target);
   }else{
    const staged=await core.stageUpdate(c,{state});
    fs.cpSync(staged.top,scratch,{recursive:true});core.verifyPackage(scratch,d);
    fs.renameSync(scratch,target);
   }
  }finally{if(fs.existsSync(scratch))fs.rmSync(scratch,{recursive:true});}
 }
 core.verifyPackage(target,d);
 assert.equal(core.loadRelease(target).rootSha256,release.rootSha256);
 const lock='/etc/duebyte-server/update.lock',fd=fs.openSync(lock,'wx',0o600);
 try{
  assert.deepEqual(json(registry),entries);
  assert.equal(runtime(),row.argv[0]);
  const exec=system('show',unit,'-p','ExecStart','--value');
  assert(exec.includes('argv[]='+row.argv.join(' ')+' ; ignore_errors='));
  if(!candidate)assert.equal(row.argv[1],root+sub+'operator.mjs');
  const next=row.argv.map(arg=>arg.startsWith(root+'/')?target+arg.slice(root.length):arg);
  if(candidate){
   const bytes=fs.readFileSync(candidateSource);
   assert.equal(core.sha256(bytes),roster[id].runnerSha256,'Candidate launcher changed');
   const gate="assert(['0.3.109','0.3.115','0.3.120'].includes(release.version));";
   const source=bytes.toString();assert(source.includes(gate));
   next[1]='/etc/duebyte-fleet/candidates/'+d.version+'/runner.mjs';
   fs.mkdirSync(path.dirname(next[1]),{recursive:true,mode:0o700});
   fs.writeFileSync(next[1],source.replace(gate,'assert.equal(release.version, '+JSON.stringify(d.version)+');'),{mode:0o600,flush:true});
  }
  assert(next.every(arg=>/^[a-zA-Z0-9_./:@-]+$/.test(arg)));
  const file='/etc/systemd/system/'+unit+'.d/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-duebyte-managed.conf';
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const old=fs.existsSync(file)?fs.readFileSync(file):null;
  let before,anchor;
  try{
   before=await evidence();assert(candidate||before.validator);
   anchor=(await rpc('block',{height:String(before.height)})).block_id.hash;
   assert(/^[A-F0-9]{64}$/.test(anchor));
   await evidence();
  }catch{
   // No unit file or running process has been touched at this point.
   return {id,version:release.version,state:'waiting-quorum',restarted:false};
  }
  const current='/opt/duebyte-server/current',management='duebyte-management.service';
  const followCurrent=candidate&&Object.keys(roster).length===1&&fs.lstatSync(current).isSymbolicLink()&&fs.realpathSync(current)===root&&system('is-active',management)==='active'&&system('show',management,'-p','ExecStart','--value').includes('argv[]='+current+'/runtime/node '+current+sub+'server-management.mjs');
  const switchCurrent=dir=>{
   const temporary=fs.mkdtempSync('/opt/duebyte-server/.fleet-current-');
   try{const link=path.join(temporary,'current');fs.symlinkSync(dir,link);fs.renameSync(link,current);}
   finally{fs.rmSync(temporary,{recursive:true,force:true});}
  };
  let switched=false;
  try{
   fs.writeFileSync(file,'[Service]\nExecStart=\nExecStart='+next.join(' ')+'\n',{flush:true});
   system('daemon-reload');system('restart',unit);
   let floor=null,proof=null;
   for(let i=0;i<60;i++){
    await wait(2000);
    try{
     assert.equal(runtime(),next[0]);
     const s=await rpc('status');
     floor??=Math.max(before.height,Number(s.sync_info.latest_block_height));
     const recovered=await evidence(floor);assert((!before.validator||recovered.validator)&&recovered.target===before.target);
     assert.equal((await rpc('block',{height:String(before.height)})).block_id.hash,anchor);
     proof=recovered;break;
    }catch{/* Wait for local replay and the first new signature. */}
   }
   assert(proof,'Validator did not resume signing');
   if(followCurrent){
    switchCurrent(target);switched=true;system('restart',management);
    assert.equal(fs.realpathSync('/proc/'+system('show',management,'-p','MainPID','--value')+'/exe'),next[0]);
   }
   if(!candidate){row.argv=next;row.version=d.version;core.writeJSON(registry,entries);}
   return {id,version:d.version,state:'current',height:proof.height};
  }catch(err){
   if(switched){switchCurrent(root);system('restart',management);}
   if(old)fs.writeFileSync(file,old,{flush:true});else fs.rmSync(file,{force:true});
   system('daemon-reload');system('restart',unit);throw err;
  }
 }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
assert(['inspect','ready','check','apply'].includes(action));
let result={id,version:release.version,state:'current'};
if(action==='ready'){const e=await evidence();assert(candidate||e.validator);result.height=e.height;}
if(action==='apply'||action==='check'){
 const c=await core.checkUpdate({root,state});
 if(action==='apply')result=await apply(c);
 else if(eligible(c))result={...result,state:'available',digest:c.descriptorSha256,target:c.descriptor.version};
 else if(c.available)result.state='waiting';
}
console.log(JSON.stringify(result));
