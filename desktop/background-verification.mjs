import {verificationFailure} from './verification-failure.mjs';

// Worker-owned scheduler, independent of document visibility/navigation.
// Foreground commands have priority between bounded verification batches.
// Lock removes private material; only the public trust journal keeps syncing.
export class BackgroundVerification{
 constructor(session){this.session=session;this.queue=[];this.active=false;this.stopping=false;this.nextAt=Infinity;this.progress={revision:0,running:false};this.timer=setInterval(()=>this.pump(),100);}
 view(){return {...this.session.view(),verification:{...this.progress}};}
 request(action,args){
  if(this.stopping)return Promise.reject(Error('Worker is stopping'));
  if(action==='status')return Promise.resolve(this.view());
  if(action==='refresh'){this.nextAt=0;this.pump();return Promise.resolve(this.view());}
  return new Promise((resolve,reject)=>{this.queue.push({action,args,resolve,reject});this.pump();});
 }
 async pump(){
  if(this.active||this.stopping)return;
  const job=this.queue.shift();
  if(!job&&(!this.session.network||Date.now()<this.nextAt))return;
  this.active=true;
  try{
   if(job){const value=await this.session.execute(job.action,job.args);if(['open','create','restore'].includes(job.action))this.progress={revision:this.progress.revision+1,running:false};if(['open','create','restore','lock','send','recover','import'].includes(job.action))this.nextAt=0;job.resolve(value);}
   else{
    this.progress.running=true;
    try{const value=await this.session.execute(this.session.wallet?'refresh':'verify-history'),step=value.recoveryStep;this.progress={revision:this.progress.revision+1,running:false,result:step?.acceptedEpochs>0?'progress':step&&!step.ready?'retry':'complete',acceptedEpochs:step?.acceptedEpochs??0,checkedAt:Date.now()};this.nextAt=Date.now()+(step?.acceptedEpochs>0?100:5000);}
    catch(e){this.progress={revision:this.progress.revision+1,running:false,result:verificationFailure(e),acceptedEpochs:0,checkedAt:Date.now()};this.nextAt=Date.now()+5000;}
   }
  }catch(e){job?.reject(e);}finally{this.active=false;if(this.queue.length)queueMicrotask(()=>this.pump());}
 }
 async close(){this.stopping=true;clearInterval(this.timer);for(const job of this.queue.splice(0))job.reject(Error('Worker is stopping'));while(this.active)await new Promise(r=>setTimeout(r,50));await this.session.close();}
}
