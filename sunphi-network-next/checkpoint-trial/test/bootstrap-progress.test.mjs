import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BootstrapProgress,readBootstrapProgress} from '../bootstrap-progress.mjs';
import {consumerConnectionProgress,consumerDashboard} from '../consumer-view.mjs';
const now=Date.now(),state={network:'test',progress:'running',rpc:{chain:'test',height:'0',time:'1970-01-01T00:00:00Z',votingPower:'0',peers:2,catchingUp:true}};
test('actual accepted parts, duplicates, audit and restart produce truthful bounded display',()=>{
 const home=mkdtempSync(join(tmpdir(),'duebyte-progress-'));let clock=now;
 try{
  const progress=new BootstrapProgress(home,()=>clock);progress.start({height:35994,chunks:3});
  for(const index of [2,2,0]){clock+=500;progress.received(index);}
  let record=readBootstrapProgress(home);assert.equal(record.received,2);
  let view=consumerConnectionProgress({...state,bootstrap:record},clock);assert.equal(view.value,'2 / 3 (66%)');assert.equal(view.label,'Snapshot parts ');
  assert.equal(consumerDashboard({...state,bootstrap:record},clock).actionTitle,'Downloading network history');
  progress.phase('verifying');record=readBootstrapProgress(home);assert.equal(record.received,3);
  view=consumerConnectionProgress({...state,bootstrap:record},clock);assert.equal(view.title,'Checking snapshot integrity');assert.equal(view.value,'35,994');
  // Slow integrity work is still explicitly labelled, never simulated progress.
  assert.equal(consumerConnectionProgress({...state,bootstrap:record},clock+900000).phase,'verifying');
  progress.phase('complete');assert.equal(consumerConnectionProgress({...state,bootstrap:readBootstrapProgress(home)},clock).title,'Resuming block verification');
  const live={...state,bootstrap:record,rpc:{...state.rpc,height:'36035',time:new Date(clock).toISOString(),catchingUp:false}};
  assert.deepEqual(consumerConnectionProgress(live,clock),{label:'Verified generation ',value:'36,035',snapshot:false});
  new BootstrapProgress(home);assert.equal(readBootstrapProgress(home),null);
  writeFileSync(join(home,'bootstrap-progress.json'),'x'.repeat(5000));assert.equal(readBootstrapProgress(home),null);
 }finally{rmSync(home,{recursive:true,force:true});}
});
test('unavailable, stopped, wrong-network and malformed progress never claim advancement',()=>{
 const b={height:35994,total:3,received:2,phase:'downloading',updatedAt:now};
 for(const change of [{progress:'stopped'},{progress:'failed'},{progress:'reconnecting'},{statusUnavailable:true},{error:'offline'},{rpc:{...state.rpc,chain:'wrong'}},{rpc:{...state.rpc,votingPower:'1'}}])assert.equal(consumerConnectionProgress({...state,bootstrap:b,...change},now),null);
 for(const change of [{received:4},{total:0},{height:0},{received:NaN},{phase:'failed'},{phase:'verifying'},{updatedAt:now+60000}])assert.equal(consumerConnectionProgress({...state,bootstrap:{...b,...change}},now),null);
 // Display telemetry failure does not reject a valid state installation.
 const unavailable=new BootstrapProgress(join(tmpdir(),'missing-directory','child'));unavailable.start({height:1,chunks:1});unavailable.received(0);unavailable.phase('complete');
});
