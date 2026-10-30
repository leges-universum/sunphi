import {fork,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {mkdirSync} from 'node:fs';

// One owned child, bounded display log, no shell commands or renderer paths.
export class NodeController {
 constructor(root,state,onChange=()=>{}){this.root=root;this.state=state;this.changed=onChange;this.child=null;this.done=Promise.resolve();this.value={phase:'idle',role:null,log:'',result:null,port:null};}
 snapshot(){return structuredClone(this.value);}
 launch(role,args){
  if(this.child)throw Error('A node operation is already running');
  mkdirSync(this.state,{recursive:true});
  this.value={phase:'starting',role,log:'',result:null,port:role==='trial-follower'?34401:role==='full-node'?Number(args[3])+1:null};
  const child=fork(join(this.root,args[0]),args.slice(1),{execPath:join(this.root,'runtime/node.exe'),cwd:this.root,stdio:['ignore','pipe','pipe','ipc'],windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,O1JS_BACKEND:'wasm',SUNPHI_PROVER_WORKERS:'1',RAYON_NUM_THREADS:'1'}});
  this.child=child;let out='';
  this.done=new Promise(resolve=>{
   const log=b=>{this.value.log=(this.value.log+b.toString()).slice(-16000);this.changed();};
   child.stdout.on('data',b=>{out=(out+b.toString()).slice(-32000);log(b);});child.stderr.on('data',log);
   child.on('error',()=>{this.value.phase='failed';log('Unable to start the bundled runtime.\n');});
   child.once('close',code=>{
    const stopped=this.value.phase==='stopping';this.child=null;
    this.value.phase=stopped?'stopped':code===0?'completed':'failed';
    if(role==='archive-verifier'&&code===0){try{this.value.result=JSON.parse(out.trim().split('\n').at(-1));}catch{this.value.phase='failed';}}
    this.changed();resolve();
   });
  });this.value.phase='running';this.changed();return this.snapshot();
 }
 verify(){return this.launch('archive-verifier',['distribution/node.mjs','verify',join(this.state,'replica')]);}
 async connectionRequest(){const r=await promisify(execFile)(join(this.root,'runtime/node.exe'),[join(this.root,'tools/trial-client.mjs'),'request',join(this.state,'trial')],{windowsHide:true,timeout:30000,maxBuffer:16384,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});return JSON.parse(r.stdout);}
 connect(){return this.launch('trial-follower',['tools/trial-client.mjs','connect',join(this.state,'trial')]);}
 start(home,base){if(!Number.isInteger(base)||base<1024||base>65530)throw Error('Base port must be 1024–65530');return this.launch('full-node',['tools/run-node.mjs',home,join(this.root,'runtime'),String(base)]);}
 async stop(){if(!this.child)return;if(this.value.role==='archive-verifier')throw Error('Let archive verification finish before closing');this.value.phase='stopping';this.changed();if(this.child.connected)this.child.send({command:'stop'});await this.done;}
 async status(){const s=this.snapshot();if(this.child&&['full-node','trial-follower'].includes(s.role)&&s.phase==='running'){
  try{const r=await fetch(`http://127.0.0.1:${s.port}/status`,{signal:AbortSignal.timeout(800)}),j=await r.json();s.rpc={chain:j.result.node_info.network,height:j.result.sync_info.latest_block_height,catchingUp:j.result.sync_info.catching_up,votingPower:j.result.validator_info.voting_power};}catch{s.rpc=null;}
 }return s;}
}
