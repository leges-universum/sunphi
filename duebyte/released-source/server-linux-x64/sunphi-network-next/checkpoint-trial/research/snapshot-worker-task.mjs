// A failed or timed-out task is not finished until its worker has exited.
// Callers may only then release installation ownership or start another task.
import {Worker} from 'node:worker_threads';
import assert from 'node:assert/strict';
export function snapshotWorkerTask(url,workerData,{timeoutMs=14*60*1000}={}){
 assert(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=14*60*1000);
 const worker=new Worker(url,{workerData});
 return new Promise((resolve,reject)=>{
  let result,failure;
  const timer=setTimeout(()=>{failure=Error('snapshot worker timeout');void worker.terminate().catch(e=>{failure=e;});},timeoutMs);
  worker.on('message',value=>{result=value;});
  worker.once('error',e=>{failure??=e;});
  worker.once('exit',code=>{clearTimeout(timer);if(failure)reject(failure);else if(code===0&&result)resolve(result);else reject(Error('snapshot worker failed'));});
 });
}
