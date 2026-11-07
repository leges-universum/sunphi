import test from 'node:test';
import assert from 'node:assert/strict';
import {consumerDashboard,NetworkActivity} from '../consumer-view.mjs';

const now=Date.parse('2026-11-04T12:00:00Z');
const running={network:'test-network',progress:'running',walletReady:true,rpc:{chain:'test-network',votingPower:'0',height:'41226',peers:2,catchingUp:false,time:new Date(now).toISOString()}};
const sample=(seconds,height=100+seconds,changes={})=>({...running,rpc:{...running.rpc,height:String(height),time:new Date(now+seconds*1000).toISOString(),...changes}});

test('peer connection and completed history verification are separate facts',()=>{
 for(const catchingUp of [true,false]){
  const s={...running,rpc:{...running.rpc,catchingUp,time:new Date(now-4*3600000).toISOString()}},v=consumerDashboard(s,now);
  assert.equal(v.networkConnected,true);assert.equal(v.connected,false);assert.equal(v.title,'Connected to the network');
  assert.equal(v.health,'Checking history');assert.equal(v.actionTitle,'Verifying network history');
  const a=new NetworkActivity();a.observe(s,now);assert.equal(a.visible,false);
 }
 for(const changes of [{progress:'reconnecting'},{progress:'stopped'},{statusUnavailable:true},{error:'RPC unavailable'},{rpc:{...running.rpc,peers:0}},{rpc:{...running.rpc,chain:'other'}}])assert.equal(consumerDashboard({...running,...changes},now).networkConnected,false);
 assert.equal(consumerDashboard(running,now).title,'Connected to the network');
 assert.equal(consumerDashboard(running,now).health,'Up to date');
});

test('charts measure synchronised history and local traffic without inventing missing values',()=>{
 const a=new NetworkActivity();a.observe(sample(0),now);
 assert.equal(a.visible,true);assert.equal(a.points.length,0);
 a.observe(sample(10),now+10000);assert.equal(a.points.length,0);
 a.observe(sample(15,115,{traffic:{incoming:4096,outgoing:2048}}),now+15000);
 assert.equal(a.points[0].rate,60);assert.equal(a.points[0].interval,1);
 assert.equal(a.points[0].incoming,4);assert.equal(a.points[0].outgoing,2);
 a.observe(sample(15,115),now+30000);
 assert.equal(a.points[1].rate,0);assert.equal(a.points[1].interval,null);
 assert.equal(a.points[1].incoming,null);assert.equal(a.points[1].outgoing,null);
 assert.deepEqual(Object.keys(a.points[0]).sort(),['at','rate','interval','incoming','outgoing','generations','seconds'].sort());
});

test('chart sessions exclude catch-up, disconnects, unavailable status and suspended observations',()=>{
 for(const state of [{...sample(30),progress:'stopped'},{...sample(30),statusUnavailable:true},sample(30,130,{catchingUp:true}),sample(30,130,{peers:0}),sample(30,130,{chain:'other'})]){
  const a=new NetworkActivity();a.observe(sample(0),now);a.observe(sample(15),now+15000);
  a.observe(state,now+30000);assert.equal(a.visible,false);assert.equal(a.points.length,0);
  a.observe(sample(45),now+45000);assert.equal(a.points.length,0);
 }
 for(const [seconds,height] of [[90,190],[30,99]]){
  const a=new NetworkActivity();a.observe(sample(0),now);a.observe(sample(15),now+15000);
  a.observe(sample(seconds,height),now+seconds*1000);assert.equal(a.points.length,0);
 }
 const a=new NetworkActivity();for(let i=0;i<=30;i++)a.observe(sample(i*15),now+i*15000);
 assert.equal(a.points.length,20);assert.equal(a.points.at(-1).at-a.points[0].at,285000);
 assert.equal(new NetworkActivity().points.length,0);
});

test('dashboard separates verified activity from earnings and user action',()=>{
 const d=consumerDashboard(running,now);
 assert.equal(d.connected,true);assert.equal(d.actionTitle,'Checking new generations');assert.equal(d.actionMessage,'');
 assert.equal(d.workTitle,'Checking new network history');assert.equal(d.waiting,false);
 assert.equal(consumerDashboard({...running,rpc:{...running.rpc,catchingUp:true}},now).waiting,true);
 for(const progress of ['connecting','checking-history']){
  const v=consumerDashboard({progress},now);assert.equal(v.waiting,true);assert.equal(v.connected,false);
 }
});

test('dashboard withdraws healthy status while retries keep the connection indicator stable',()=>{
 const cases=[{statusUnavailable:true},{error:'RPC unavailable'},{progress:'failed'},
  {progress:'stopping'},{progress:'stopped'},{progress:'reconnecting'},
  {rpc:{...running.rpc,peers:0}},
  {rpc:{...running.rpc,time:new Date(now-120000).toISOString()}},
  {rpc:{...running.rpc,time:'bad timestamp'}},
  {rpc:{...running.rpc,time:new Date(now+60000).toISOString()}},
  {rpc:{...running.rpc,chain:'another-network'}},
  {rpc:{...running.rpc,votingPower:'1'}}];
 for(const changes of cases){
  const v=consumerDashboard({...running,...changes},now);
  assert.equal(v.connected,false,JSON.stringify(changes));
  const retry=changes.statusUnavailable||changes.error||changes.progress==='reconnecting'||(changes.rpc&&changes.rpc.chain===running.network&&changes.rpc.votingPower==='0');
  assert.equal(v.waiting,!!retry,JSON.stringify(changes));
  assert.notEqual(v.actionTitle,'No action needed');
 }
 assert.equal(consumerDashboard({...running,rpc:{...running.rpc,chain:'other'}},now).actionTitle,'Disconnect this node');
 assert.equal(consumerDashboard({progress:'failed'},now).button,'Retry');
 assert.equal(consumerDashboard({progress:'idle',configured:false},now).actionTitle,'Check your installation');
});

test('startup and automatic reconnection never flash the intermediate Keep DueByte open panel',()=>{
 for(const changes of [{progress:'connecting',rpc:null},{progress:'reconnecting',rpc:null},{progress:'checking-history',error:'Waiting for a verified local node.',rpc:null},{progress:'running',rpc:null},{progress:'running',rpc:{...running.rpc,catchingUp:true}},{progress:'running',statusUnavailable:true}]){
  const v=consumerDashboard({...running,...changes},now);assert(v.waiting);assert(!v.connected);assert.notEqual(v.actionTitle,'Keep DueByte open');
 }
 assert(!consumerDashboard({...running,progress:'failed'},now).waiting);
 assert(!consumerDashboard({...running,rpc:{...running.rpc,chain:'wrong'}},now).waiting);
});
