import {Worker} from 'node:worker_threads';
import {join} from 'node:path';
import assert from 'node:assert/strict';
// One application-owned worker retains verification authority from preparation
// through Comet's final install. Restart revalidates all retained objects.
export class ArchivePreparationSession{
 constructor(home,profile,{onProgress=()=>{},idleTimeoutMs=14*60*1000}={}){
  this.state='idle';this.sequence=0;this.pending=null;this.failure=null;this.last=Date.now();
  this.worker=new Worker(new URL('./archive-preflight-worker.mjs',import.meta.url),{workerData:{home,profile},resourceLimits:{maxOldGenerationSizeMb:512}});
  this.timer=setInterval(()=>{if(this.pending&&Date.now()-this.last>=idleTimeoutMs){this.failure=Error('archive preparation stopped making progress');void this.worker.terminate();}},Math.min(1000,idleTimeoutMs));this.timer.unref();
  this.worker.on('message',m=>{if(m.progress){this.last=Date.now();onProgress(m.progress);return;}const p=this.pending;assert(p&&p.id===m.id,'unexpected archive task response');this.pending=null;if(m.error){this.state='failed';this.failure=Error(m.error);p.reject(this.failure);}else{this.state='ready';p.resolve(m.result);}});
  this.worker.once('error',e=>{this.failure=e;});this.exited=new Promise(resolve=>this.worker.once('exit',()=>{clearInterval(this.timer);this.state='closed';this.pending?.reject(this.failure??Error('archive worker stopped'));this.pending=null;resolve();}));
 }
 call(operation,extra={}){assert(!this.pending&&this.state!=='closed','archive task already active or closed');this.state=operation;this.failure=null;this.last=Date.now();const id=++this.sequence;return new Promise((resolve,reject)=>{this.pending={id,resolve,reject};this.worker.postMessage({id,operation,...extra});});}
 prepare(){return this.call('prepare');}
 install(receiver,{beforePublish=()=>{}}={}){
  assert(receiver.complete(),'incomplete snapshot');beforePublish();const {target,metadata,policy,config,source,certificate,fresh,schemaUpgrade,previous,archiveSources}=receiver;
  return this.call('install',{receiver:{directory:join(receiver.directory,'..'),target,metadata,policy,config,source,certificate,fresh,schemaUpgrade,previous,archiveSources}});
 }
 async close(){if(this.state!=='closed'){if(this.pending)void this.worker.terminate();else this.worker.postMessage({operation:'close'});const timer=setTimeout(()=>void this.worker.terminate(),3000);await this.exited;clearTimeout(timer);}}
}
