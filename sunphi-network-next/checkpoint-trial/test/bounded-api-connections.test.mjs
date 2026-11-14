import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createBoundedApi} from '../research/bounded-api.mjs';

test('independent keep-alive readers cannot exhaust transport at the lease limit',async()=>{
 const root='1'.repeat(64),handler={root,store:{file:'missing-test-store',onCommit:()=>()=>{},readSnapshot:()=>({root,close(){}})}};
 const server=createBoundedApi(handler),agents=[],sockets=[];
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const request=(agent,path='/',method='GET')=>new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:server.address().port,path,method,agent},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});
  req.once('socket',socket=>{if(!sockets.includes(socket))sockets.push(socket);});req.once('error',reject);req.setTimeout(3000,()=>req.destroy(Error('request timeout')));req.end();
 });
 try{
  // Each process/pool may retain its own idle socket without owning a lease.
  for(let i=0;i<16;i++){const agent=new http.Agent({keepAlive:true,maxSockets:1,agentKeepAliveTimeoutBuffer:0});agents.push(agent);assert.equal(await request(agent),404);}
  assert.equal(await new Promise(resolve=>server.getConnections((_error,n)=>resolve(n))),16);
  for(let i=0;i<8;i++)assert.equal(await request(agents[i],'/v1/read-lease?root='+root,'POST'),200);
  assert.equal(await request(agents[8],'/v1/read-lease?root='+root,'POST'),400,'lease work budget remains eight');
  // Idle pools must release server capacity without relying on client shutdown.
  await Promise.race([Promise.all(sockets.map(s=>s.destroyed?null:once(s,'close'))),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('idle sockets retained')),4000);timer.unref();})]);
  assert.equal(await new Promise(resolve=>server.getConnections((_error,n)=>resolve(n))),0);
 }finally{for(const a of agents)a.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
