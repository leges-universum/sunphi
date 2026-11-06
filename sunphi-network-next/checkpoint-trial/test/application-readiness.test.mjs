import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {waitForApplication} from '../application-readiness.mjs';
async function fixture(t,handler){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>{s.closeAllConnections();return new Promise(r=>s.close(r));});return s.address().port;}
test('waits for a slow local service and rejects HTTP success without valid application info',async t=>{
 const started=performance.now(),port=await fixture(t,(_q,r)=>{r.end(JSON.stringify(performance.now()-started<250?{wrong:'service'}:{height:0,hash:Buffer.alloc(32).toString('base64')}));});
 assert(await waitForApplication({port,alive:()=>true,stopping:()=>false,timeoutMs:2000,intervalMs:25}));assert(performance.now()-started>=250);
});
test('failed service has a bounded wait, and a stop or child exit cancels it promptly',async t=>{
 const port=await fixture(t,(_q,r)=>{r.writeHead(503);r.end();});
 let started=performance.now();assert.equal(await waitForApplication({port,alive:()=>true,stopping:()=>false,timeoutMs:180,intervalMs:20}),false);assert(performance.now()-started<1000);
 for(const reason of ['stop','exit']){started=performance.now();assert.equal(await waitForApplication({port,alive:()=>reason!=='exit'||performance.now()-started<100,stopping:()=>reason==='stop'&&performance.now()-started>=100,timeoutMs:5000,intervalMs:20}),false);assert(performance.now()-started<1000);}
});
