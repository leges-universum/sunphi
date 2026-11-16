import test from 'node:test';import assert from 'node:assert/strict';
import {fetchHeaderProof} from '../header-transport.mjs';
const url='http://127.0.0.1:20001',digest='a'.repeat(64);
const answer=(m,p)=>m==='commit'?{signed_header:{header:{height:p.height,validators_hash:digest},commit:{}}}:{block_height:p.height,total:'4',count:'4',validators:[1,2,3,4]};
test('bounded parallel transport orders headers and reads each committed validator set once',async()=>{
 let active=0,peak=0,sets=0;
 const text=await fetchHeaderProof({url,start:10,end:41,read:async(_u,m,p)=>{active++;peak=Math.max(peak,active);if(m==='validators')sets++;await new Promise(r=>setTimeout(r,(Number(p.height)%4+1)*2));active--;return answer(m,p);}});
 const proof=JSON.parse(text);assert.equal(peak,4);assert.equal(active,0);assert.equal(sets,1);assert.equal(proof.version,'2');assert.deepEqual(proof.headers.map(h=>Number(h.header.height)),Array.from({length:32},(_,i)=>i+10));assert.deepEqual(proof.sets[digest],[1,2,3,4]);
});
test('transport fails closed on malformed heights, pagination and nonlocal endpoints',async()=>{
 for(const mutate of [(r,m)=>m==='commit'?(r.signed_header.header.height='99'):null,(r,m)=>m==='validators'?(r.total='257'):null,(r,m)=>m==='validators'?(r.count='3'):null])await assert.rejects(fetchHeaderProof({url,start:10,end:11,read:async(_u,m,p)=>{const r=answer(m,p);mutate(r,m);return r;}}));
 for(const bad of ['https://127.0.0.1:20001','http://example.org','http://user@127.0.0.1:20001'])await assert.rejects(fetchHeaderProof({url:bad,start:10,end:11}));
 await assert.rejects(fetchHeaderProof({url,start:1,end:513}),/bound/);
});
test('timeout cancels bounded readers and incomplete downloads never produce a proof',async()=>{
 let active=0,ended=0;const keepAlive=setTimeout(()=>{},1000);
 try{await assert.rejects(fetchHeaderProof({url,start:10,end:40,timeout:20,read:async(_u,_m,_p,signal)=>{active++;await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{ended++;reject(signal.reason);},{once:true}));}}),e=>e.code==='RECOVERY_TRANSPORT_TIMEOUT');assert.equal(active,4);assert.equal(ended,4);}finally{clearTimeout(keepAlive);}
});
test('large replies stop the entire window within the proof memory budget',async()=>{
 await assert.rejects(fetchHeaderProof({url,start:10,end:30,read:async(_u,m,p)=>{const r=answer(m,p);if(m==='commit')r.signed_header.padding='x'.repeat(1048576);return r;}}),e=>e.code==='RECOVERY_WINDOW_TOO_LARGE');
});
