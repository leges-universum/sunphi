import { fork } from 'node:child_process';
import { resolve } from 'node:path';

// One long-lived PRIVATE local worker: setup/compilation is paid once, not on
// every click. No HTTP route, telemetry, remote prover or logging of witnesses.
export class ProverSession {
  #worker;#jobs=new Map();#counter=0;#closed=false;#ready;#resolveReady;#rejectReady;#startupTimer;
  constructor({mode,cachePath,workers=4,onProgress=()=>{}}={}){
    if(mode!=='isolated'||!cachePath||![1,2,4,8].includes(workers))throw new Error('explicit isolated prover configuration required');
    this.#ready=new Promise((r,j)=>{this.#resolveReady=r;this.#rejectReady=j;});this.#ready.catch(()=>{});
    this.#worker=fork(new URL('./prover-worker.mjs',import.meta.url),[resolve(cachePath)],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,env:{...process.env,SUNPHI_PROVER_WORKERS:String(workers)}});
    this.#worker.on('message',m=>{
      if(m.type==='ready'){clearTimeout(this.#startupTimer);this.#resolveReady();onProgress({phase:'ready'});return;}
      if(m.type==='progress'){onProgress({id:m.id,phase:m.phase});return;}
      const job=this.#jobs.get(m.id);if(!job)return;clearTimeout(job.timer);this.#jobs.delete(m.id);
      if(m.error)job.reject(new Error(m.error));else job.resolve(m.proof);
    });
    this.#worker.on('error',()=>this.#fail(new Error('local prover failed')));
    this.#worker.on('exit',()=>{if(!this.#closed)this.#fail(new Error('local prover exited'));});
    this.#startupTimer=setTimeout(()=>this.#fail(new Error('prover initialization timeout')),180000);
  }
  ready(){return this.#ready;}
  async prove(payload,{timeoutMs=180000}={}){
    if(this.#closed||this.#jobs.size>=4)throw new Error('prover closed or queue full');
    if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>600000)throw new Error('timeout bound');
    if(!payload||!['mint','transfer'].includes(payload.kind)||JSON.stringify(payload).length>16384)throw new Error('invalid private proving request');
    await this.#ready;if(this.#closed||this.#jobs.size>=4)throw new Error('prover closed or queue full');
    const id=++this.#counter;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.#fail(new Error('proving timeout; no transaction submitted')),timeoutMs);
      this.#jobs.set(id,{resolve,reject,timer});this.#worker.send({id,payload});
    });
  }
  #fail(e){this.#closed=true;clearTimeout(this.#startupTimer);this.#rejectReady(e);for(const job of this.#jobs.values()){clearTimeout(job.timer);job.reject(e);}this.#jobs.clear();this.#worker.kill('SIGKILL');}
  async close(){const done=this.#worker.exitCode!==null||this.#worker.signalCode!==null?Promise.resolve():new Promise(r=>this.#worker.once('exit',r));this.#fail(new Error('prover closed; no transaction submitted'));await done;}
}
