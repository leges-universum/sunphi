import test from 'node:test';import assert from 'node:assert/strict';
import {WalletSessionDrain} from '../wallet-session-drain.mjs';
test('switch reserves the session, waits for operation completion and closes exactly once',async()=>{
 const drain=new WalletSessionDrain();let busy=true,closed=0,release;
 const wait=drain.run({busy:()=>busy,valid:()=>true,close:()=>closed++,pause:()=>new Promise(r=>release=r)});
 assert(drain.pending);assert.equal(closed,0);
 await assert.rejects(drain.run({}),/already in progress/);
 busy=false;release();await wait;assert.equal(closed,1);assert(!drain.pending);
});
test('timeout retains the open wallet and permits a later successful switch',async()=>{
 const drain=new WalletSessionDrain();let time=0,closed=0;
 await assert.rejects(drain.run({busy:()=>true,valid:()=>true,close:()=>closed++,timeoutMs:100,now:()=>time,pause:async ms=>{time+=ms;}}),/remains open/);
 assert.equal(closed,0);assert(!drain.pending);
 await drain.run({busy:()=>false,valid:()=>true,close:()=>closed++});assert.equal(closed,1);
});
test('an old request cannot close a changed wallet session',async()=>{
 const drain=new WalletSessionDrain();let busy=true,epoch=0,closed=0;
 await assert.rejects(drain.run({busy:()=>busy,valid:()=>epoch===0,close:()=>closed++,pause:async()=>{epoch++;busy=false;}}),/session changed/);
 assert.equal(closed,0);assert(!drain.pending);
});
