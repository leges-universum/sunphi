import test from 'node:test';
import assert from 'node:assert/strict';
import {CatchupRecovery,corroboratesCatchup} from '../catchup-recovery.mjs';
const epoch=Date.UTC(2026,10,7),status=(now=0,lag=14400000,extra={})=>({height:1000+Math.floor(now/500),time:new Date(epoch+now-lag).toISOString(),catchingUp:false,votingPower:'0',peers:2,...extra});
const observe=(r,now,lag,extra)=>r.observe(status(now,lag,extra),now,epoch+now);
test('an independently advancing same-chain tip is required, not a clock error or chain halt',()=>{
 const local={...status(),chain:'trial'},remote={node_info:{network:'trial'},sync_info:{latest_block_height:'11000',latest_block_time:new Date(epoch-1000).toISOString(),catching_up:false}};
 assert(corroboratesCatchup(local,remote,epoch));
 for(const r of [null,{...remote,node_info:{network:'other'}},...[
  {latest_block_height:'1000'},{latest_block_height:'bogus'},{latest_block_time:local.time},
  {latest_block_time:new Date(epoch+1).toISOString()},{catching_up:true}
 ].map(x=>({...remote,sync_info:{...remote.sync_info,...x}}))])assert(!corroboratesCatchup(local,r,epoch));
 assert(!corroboratesCatchup(local,remote,epoch+86400000));
});
test('long-lag consensus replay restarts only after two continuous minutes',()=>{
 const r=new CatchupRecovery();assert.equal(observe(r,0),'continue');
 assert.equal(observe(r,119999),'continue');assert.equal(observe(r,120000),'restart');
 assert.equal(r.retries,1);
});
test('recovery is bounded and spaced; it never orders a data reset or stop',()=>{
 const r=new CatchupRecovery();observe(r,0);assert.equal(observe(r,120000),'restart');
 for(let n=121000;n<1920000;n+=1000)assert.equal(observe(r,n),'continue');
 assert.equal(observe(r,1920000),'continue');assert.equal(observe(r,2040000),'restart');
 for(let n=2041000;n<10000000;n+=10000)assert.equal(observe(r,n),'continue');
 assert.equal(r.retries,2);
});
test('no restart during block sync, initial sync, peer loss or voting',()=>{
 for(const extra of [{catchingUp:true},{height:0},{peers:0},{peers:NaN},{votingPower:'1'},{time:'invalid'},{height:'bogus'}]){
  const r=new CatchupRecovery();for(let n=0;n<=600000;n+=1500)assert.equal(observe(r,n,14400000,extra),'continue');assert.equal(r.retries,0);
 }
});
test('fresh history and short interruptions do not trigger recovery',()=>{
 for(const lag of [0,1500,30000,599999]){const r=new CatchupRecovery();for(let n=0;n<1200000;n+=1500)assert.equal(observe(r,n,lag),'continue');}
});
test('rapid replay approaching the tip is allowed to finish',()=>{
 const r=new CatchupRecovery();observe(r,0,2400000);
 assert.equal(observe(r,120000,900000),'continue');assert.equal(r.retries,0);
});
test('missing observations and clock changes require a new observation window',()=>{
 const r=new CatchupRecovery();observe(r,0);r.interrupted();assert.equal(observe(r,120000),'continue');assert.equal(observe(r,240000),'restart');
 const a=new CatchupRecovery();observe(a,0);assert.equal(observe(a,900000),'continue');assert.equal(a.retries,0);
 const b=new CatchupRecovery();observe(b,0);assert.equal(b.observe(status(120000),120000,epoch+180000),'continue');assert.equal(b.retries,0);
});
test('five minutes of fresh history renews the allowance; a brief fresh sample does not',()=>{
 const r=new CatchupRecovery();r.retries=2;r.lastRestart=0;
 observe(r,4000000,1000);observe(r,4001000,14400000);assert.equal(r.retries,2);
 for(let n=5000000;n<=5300000;n+=1500)observe(r,n,1000);assert.equal(r.retries,0);
 observe(r,6000000);assert.equal(observe(r,6120000),'restart');
});
test('future timestamps, regressing height and regressing monotonic time cannot trigger immediate restart',()=>{
 const r=new CatchupRecovery();observe(r,0);assert.equal(observe(r,120000,-1),'continue');assert.equal(r.retries,0);
 observe(r,200000);assert.equal(observe(r,320000,14400000,{height:1}),'continue');assert.equal(r.retries,0);
 assert.equal(observe(r,100000),'continue');assert.equal(r.retries,0);
});
