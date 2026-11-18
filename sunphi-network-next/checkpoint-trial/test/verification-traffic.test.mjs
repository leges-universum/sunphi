import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {verificationTraffic} from '../verification-traffic.mjs';
import {NetworkActivity} from '../consumer-view.mjs';
import {BOUNDED_HOME} from '../home-verification.mjs';

test('compact verifier measures only configured HTTP origins, in both directions',async()=>{
 const servers=[0,1].map(()=>createServer((req,res)=>res.end(Buffer.alloc(9000))));
 for(const server of servers){server.listen(0,'127.0.0.1');await once(server,'listening');}
 const [allowed,other]=servers.map(s=>'http://127.0.0.1:'+s.address().port);
 const meter=verificationTraffic([allowed]);
 try{
  await (await fetch(other)).arrayBuffer();assert.equal(meter.snapshot(),null);
  await (await fetch(allowed)).arrayBuffer();
  const first=meter.snapshot();assert(first.incoming>=9000&&first.outgoing>0);
  await (await fetch(other)).arrayBuffer();assert.deepEqual(meter.snapshot(),first);
  await (await fetch(allowed,{headers:{connection:'close'}})).arrayBuffer();
  await new Promise(r=>setTimeout(r,40));const last=meter.snapshot();
  assert(last.incoming>=first.incoming+9000&&last.outgoing>first.outgoing);
 }finally{meter.close();for(const server of servers){server.closeAllConnections();server.close();}}
});

test('block rate and traffic use elapsed time and retain true idle intervals',()=>{
 const a=new NetworkActivity(),start=Date.now();
 let t=start,height=200;
 const observe=()=>a.observe({progress:'running',network:'fixture',homeVerification:BOUNDED_HOME,
  verification:{network:'fixture',height,appHeight:height-1,time:t,root:'a'.repeat(64),blockHash:'b'.repeat(64)},
  trafficCounters:{incoming:(t-start)*1024/1000,outgoing:0}},t);
 observe();
 for(const [ms,blocks] of [[15000,3],[30000,1],[15000,0],[15000,1],[15000,1]]){
  t+=ms;height+=blocks;observe();
 }
 assert.deepEqual(a.points.map(p=>p.rate),[12,2,0,4,4]);assert.equal(a.points[4].average,4);
 assert(a.points.every(p=>p.incoming===1&&p.outgoing===0));
});
