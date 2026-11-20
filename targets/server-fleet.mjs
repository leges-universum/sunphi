import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';

// A single systemd oneshot owns this fleet. Persist the flight before sending
// the request. A broken connection must never unlock a second restart.
export async function sweep(nodes,state,call,save,now=Date.now){
 const report=(id,values)=>{
  state.nodes[id]={...state.nodes[id],...values,checkedAt:now()};save(state);
 };
 for(const id of nodes){
  let current;
  try{current=await call(id,'inspect');assert(current.id===id&&/^\d+\.\d+\.\d+$/.test(current.version));}
  catch{
   // Keep the timestamp at which the version was actually observed.
   state.nodes[id]={checkedAt:now(),...state.nodes[id],state:'unreachable'};
   save(state);continue;
  }
  if(state.flight){
   report(id,{version:current.version,state:state.flight.id===id?'needs-review':'paused'});
   continue;
  }
  let check;
  try{check=await call(id,'check');assert(check.id===id&&check.version===current.version);}
  catch{report(id,{version:current.version,state:'check-failed'});continue;}
  if(check.state!=='available'){assert(['current','waiting'].includes(check.state));report(id,{version:current.version,state:check.state});continue;}
  assert(/^[a-f0-9]{64}$/.test(check.digest));
  // Capacity refusal happens before any mutation. Retry on a future sweep.
  try{await call(id,'ready');}catch{report(id,{version:current.version,state:'waiting-quorum'});continue;}
  state.flight={id,digest:check.digest,startedAt:now()};
  report(id,{version:current.version,state:'updating'});
  try{
   const result=await call(id,'apply',check.digest);
   if(result.id===id&&result.state==='waiting-quorum'&&result.version===current.version&&result.restarted===false){
    state.flight=null;report(id,{version:current.version,state:'waiting-quorum'});continue;
   }
   assert(result.id===id&&result.version===check.target&&Number.isSafeInteger(result.height)&&result.height>0);
   state.flight=null;report(id,{version:result.version,state:'current'});
  }catch{report(id,{version:current.version,state:'needs-review'});}
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const service='/var/lib/duebyte-fleet',file=service+'/report.json';
 if(process.argv[2]!=='--locked'){
  // The timer, a manual retry and a second service invocation share this lock.
  // The journal continues to protect an outstanding restart after a host crash.
  execFileSync('/usr/bin/flock',['--nonblock',service+'/queue.lock',process.execPath,process.argv[1],'--locked'],{stdio:'inherit'});
  process.exit(0);
 }
 const roster=JSON.parse(fs.readFileSync('/etc/duebyte-fleet/fleet.json'));
 const state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{nodes:{},flight:null};
 const save=s=>{
  fs.writeFileSync(file+'.next',JSON.stringify(s),{mode:0o644,flush:true});
  fs.renameSync(file+'.next',file);
  const fd=fs.openSync(service,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 };
 const run=promisify(execFile);
 await sweep(Object.keys(roster),state,async(id,action,digest)=>{
  assert(/^[a-f0-9]{64}$/.test(id));const host=roster[id];assert(/^fleet-[0-9]+$/.test(host));
  const {stdout}=await run('/usr/bin/ssh',['-F','/etc/duebyte-fleet/ssh_config',host,[action,id,digest].filter(Boolean).join(' ')],{timeout:1200000,maxBuffer:8192});
  return JSON.parse(stdout);
 },save);
}
