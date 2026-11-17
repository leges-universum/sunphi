import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotWorkerTask} from '../research/snapshot-worker-task.mjs';
const script=code=>new URL('data:text/javascript,'+encodeURIComponent("import {parentPort,workerData} from 'node:worker_threads';"+code));
test('snapshot worker returns only a successful completed result',async()=>{
 assert.deepEqual(await snapshotWorkerTask(script('parentPort.postMessage({ready:true});'),{}),{ready:true});
 await assert.rejects(()=>snapshotWorkerTask(script('parentPort.postMessage({ready:true});throw Error("verification failed");'),{}),/verification failed/);
 await assert.rejects(()=>snapshotWorkerTask(script('process.exit(0);'),{}),/snapshot worker failed/);
});
test('snapshot worker timeout retains ownership until all worker writes stop',async()=>{
 const memory=new SharedArrayBuffer(4),counter=new Int32Array(memory);
 await assert.rejects(()=>snapshotWorkerTask(script('const n=new Int32Array(workerData);parentPort.postMessage({ready:true});while(true)Atomics.add(n,0,1);'),memory,{timeoutMs:500}),/timeout/);
 const stopped=Atomics.load(counter,0);assert(stopped>0);
 await new Promise(r=>setTimeout(r,50));assert.equal(Atomics.load(counter,0),stopped,'no writer remains after failed task returns');
});
