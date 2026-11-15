import test from 'node:test';
import assert from 'node:assert/strict';
import {permitted,publicServer} from '../public-rpc.mjs';
import {connect} from 'node:net';

test('Home enrollment facade exposes only requests, requires explicit route and retains independent payment capacity',async()=>{
 const calls=[],waiting=[],budget={active:0};
 const server=publicServer({kind:'rpc',target:22001,homeAdmissionTarget:22006},{budget,upstream:async(url,options)=>{
  calls.push({url,body:JSON.parse(options.body)});if(url.endsWith('/home-admission/request'))await new Promise(resolve=>waiting.push(resolve));return new Response('{}');
 }});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+server.address().port,send=(path,body={},headers={})=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 try{
  for(const path of ['/home-admission/offer','/home-admission/pending','/home-admission/request?target=9999'])assert.equal((await send(path)).status,403);
  assert.equal((await send('/home-admission/request',{}, {origin:'https://untrusted.invalid'})).status,403);assert.equal(calls.length,0);
  const held=[send('/home-admission/request',{request:1}),send('/home-admission/request',{request:2})];
  for(let n=0;waiting.length<2&&n<100;n++)await new Promise(r=>setTimeout(r,5));assert.equal(waiting.length,2);
  assert.equal((await send('/home-admission/request')).status,429);
  assert.equal((await send('/',{jsonrpc:'2.0',method:'broadcast_tx_sync',params:{tx:'signed'}})).status,200);
  assert(calls.slice(0,2).every(c=>c.url==='http://127.0.0.1:22006/home-admission/request'));assert.equal(calls[2].url,'http://127.0.0.1:22001/');
  waiting.splice(0).forEach(r=>r());assert((await Promise.all(held)).every(r=>r.status===200));
  assert.equal((await send('/home-admission/request',{data:'x'.repeat(65536)})).status,413);
 }finally{waiting.splice(0).forEach(r=>r());server.closeAllConnections();await new Promise(r=>server.close(r));}
 const disabled=publicServer({kind:'rpc',target:22001},{upstream:()=>{throw Error('must not forward');}});await new Promise(r=>disabled.listen(0,'127.0.0.1',r));
 try{assert.equal((await fetch('http://127.0.0.1:'+disabled.address().port+'/home-admission/request',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);}finally{disabled.closeAllConnections();await new Promise(r=>disabled.close(r));}
 assert.throws(()=>publicServer({kind:'archive',target:22004,homeAdmissionTarget:22006}),/policy/);
});
test('consumer RPC exposes signed data and payment submission, never local administration',async()=>{
 for(const path of ['/status','/snapshot','/work','/checkpoint'])assert(permitted('rpc','POST','/',{jsonrpc:'2.0',method:'abci_query',params:{path}}));
 for(const method of ['unsafe_flush_mempool','dial_peers','installCheckpoint','finalize','commit','init'])assert(!permitted('rpc','POST','/',{jsonrpc:'2.0',method:method==='commit'?'installCheckpoint':method}));
 for(const path of ['/installCheckpoint','/runtime','/init'])assert(!permitted('rpc','POST','/',{jsonrpc:'2.0',method:'abci_query',params:{path}}));
 let called=0;const server=publicServer({kind:'rpc',target:22001},{upstream:async()=>{called++;return new Response('{}');}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {const url='http://127.0.0.1:'+server.address().port;let r=await fetch(url,{method:'POST',body:JSON.stringify({method:'installCheckpoint'})});assert.equal(r.status,403);assert.equal(called,0);r=await fetch(url,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',method:'status',params:{}})});assert.equal(r.status,200);assert.equal(called,1);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('continuous partial bodies and silent connections cannot reserve a shared SSH identity against complete payments',async()=>{
 const budget={active:0},sockets=new Set();let forwarded=0;
 const server=publicServer({kind:'rpc',target:22001},{budget,upstream:async()=>{forwarded++;return new Response('{}');}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 const hold=partial=>new Promise(resolve=>{const s=connect(port,'127.0.0.1',()=>{if(partial)s.write('POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10000\r\n\r\n{');resolve();});sockets.add(s);s.on('error',()=>resolve());s.on('close',()=>sockets.delete(s));});
 try{
  for(const partial of [true,false])for(let round=0;round<4;round++){
   await Promise.all(Array.from({length:partial?12:70},()=>hold(partial)));
   const started=Date.now(),r=await fetch('http://127.0.0.1:'+port,{method:'POST',headers:{connection:'close'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'broadcast_tx_sync',params:{tx:'test'}}),signal:AbortSignal.timeout(2000)});
   assert.equal(r.status,200);await r.text();assert(Date.now()-started<2000,'must not wait for slow-body timeout');assert(budget.parsing<=32);assert(budget.sockets.size<=64);
  }
  const flood=setInterval(()=>{for(let i=0;i<8;i++)void hold(true);},25);
  try{for(let n=0;n<20;n++){
   await new Promise(r=>setTimeout(r,30));const r=await fetch('http://127.0.0.1:'+port,{method:'POST',headers:{connection:'close'},body:JSON.stringify({jsonrpc:'2.0',id:n,method:'broadcast_tx_sync',params:{tx:'test'}}),signal:AbortSignal.timeout(2000)});assert.equal(r.status,200);await r.text();assert(budget.sockets.size<=64);
  }}finally{clearInterval(flood);}
  assert.equal(forwarded,28);
 }finally{for(const s of sockets)s.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));}
 await new Promise(r=>setTimeout(r,30));assert.equal(budget.active,0);assert.equal(budget.parsing,0);assert.equal(budget.pending.size,0);assert.equal(budget.sockets.size,0);
});
