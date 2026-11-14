import test from 'node:test';
import assert from 'node:assert/strict';
import {homeVerification,boundedHomeObservation,BOUNDED_HOME} from '../home-verification.mjs';
import {consumerDashboard,consumerHistory,consumerConnectionProgress,NetworkActivity} from '../consumer-view.mjs';
import {homeRuntimeHealthy} from '../home-boot-health.mjs';
const now=Math.floor(Date.now()/1000)*1000;
const view={certificate:{height:101,appHeight:100,blockHash:'a'.repeat(64),appHash:'b'.repeat(64)},state:{height:100,money:{time:now/1000}}};
const state=()=>({network:'test',homeVerification:BOUNDED_HOME,verification:homeVerification(view,'test'),walletReady:true,progress:'running',rpc:null});
test('bounded Home presents verified recent history without inventing peers or full archival storage',()=>{
 const s=state(),d=consumerDashboard(s,now);assert(d.connected);assert.match(d.message,/archives.*servers/);assert.match(d.workMessage,/only after network acceptance/);assert.deepEqual(consumerHistory(s),{height:101,time:now});assert.equal(consumerConnectionProgress(s,now).snapshot,false);assert(homeRuntimeHealthy(s,'test'));
 const activity=new NetworkActivity();activity.observe(s,now);activity.observe({...s,verification:{...s.verification,height:103,appHeight:102,time:now+20000}},now+20000);assert.equal(activity.points.length,1);assert.equal(activity.points[0].incoming,null);assert.equal(activity.points[0].outgoing,null);
});
test('bounded Home rejects stale, foreign, partial or inconsistent verification reports',()=>{
 for(const mutate of [s=>s.verification.network='other',s=>s.verification.appHeight=101,s=>s.verification.root='bad',s=>s.verification.height=0,s=>s.verification=null]){const s=state();mutate(s);assert.equal(boundedHomeObservation(s,now),null);assert(!consumerDashboard(s,now).connected);assert(!homeRuntimeHealthy(s,'test'));}
 const stale=state();stale.verification.time-=120000;assert(!consumerDashboard(stale,now).connected);assert(!homeRuntimeHealthy(stale,'test'));
 assert(!homeRuntimeHealthy({...state(),walletReady:false},'test'));assert(!homeRuntimeHealthy({...state(),error:'failed'},'test'));
 assert.throws(()=>homeVerification({...view,state:{...view.state,height:99}},'test'));
});
