import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {utcEconomicFixture} from './helpers/utc-economic-fixture.mjs';
import {hash,keys} from '../crypto.mjs';
import {WARMUP_EXECUTOR_V2} from '../century-warmup.mjs';
import {capacityProposal,CapacitySigner,CapacityCoordinator} from '../warmup-capacity-service.mjs';
import {localCapacityView,broadcastCapacityInterval} from '../warmup-capacity-runtime.mjs';
import {openCenturyWarmupInterval} from '../century-warmup.mjs';

function fixture(t){
 const x=utcEconomicFixture({warmup:true}),s=x.s,dir=fs.mkdtempSync(path.join(os.tmpdir(),'duebyte-capacity-'));
 s.centuryWarmup.version=WARMUP_EXECUTOR_V2;
 s.centuryFunds={zeroStage:{body:{startsAt:s.money.time-10,settings:{durationSeconds:3600}}}};
 const options={planHash:s.centuryWarmup.planHash},state=()=>({state:s,root:hash(s),time:s.money.time});
 const signers=[];t.after(()=>{for(const k of signers)k.close();fs.rmSync(dir,{recursive:true,force:true});});
 const signer=(n=0)=>{const k=new CapacitySigner({file:path.join(dir,'s'+n+'.sqlite'),view:async h=>{assert.equal(h,s.height);return state();},validatorKeys:x.validators.slice(n*3,n*3+3),options});signers.push(k);return k;};
 return{...x,dir,options,state,signer,resources:signers};
}
test('capacity refuses stale state, excess rate, subsidy, wrong plan and pilot end',t=>{
 const x=fixture(t),s=x.s,now=s.money.time;
 assert.equal(capacityProposal(s,x.options,now).to,now+60);
 assert.throws(()=>capacityProposal(s,x.options,now+51));
 assert.throws(()=>capacityProposal(s,{...x.options,rate:'1001'},now));
 assert.throws(()=>capacityProposal(s,{planHash:hash('wrong')},now));
 s.centurySubsidy={};assert.throws(()=>capacityProposal(s,x.options,now));delete s.centurySubsidy;
 s.centuryWarmup.pending={};assert.equal(capacityProposal(s,x.options,now),null);s.centuryWarmup.pending=null;
 s.centuryWarmup.controller.pending={};assert.equal(capacityProposal(s,x.options,now),null);s.centuryWarmup.controller.pending=null;
 s.centuryFunds.zeroStage.body.startsAt=now-3590;assert.equal(capacityProposal(s,x.options,now),null);
});
test('signer rejects wrong root and conflicting interval, permits only expired replacement',async t=>{
 const x=fixture(t),k=x.signer(),packet={height:x.s.height,root:hash(x.s),body:capacityProposal(x.s,x.options,x.s.money.time)};
 await assert.rejects(k.approve({...packet,root:hash('forged')}));
 const a=await k.approve(packet);assert.deepEqual(await k.approve(packet),a);
 x.s.money.time+=10;x.s.height++;
 const newer=()=>({height:x.s.height,root:hash(x.s),body:capacityProposal(x.s,x.options,x.s.money.time)});
 await assert.rejects(k.approve(newer()),/conflicting/);
 x.s.money.time+=50;x.s.height++;assert.equal((await k.approve(newer())).length,3);
 k.enabled=()=>false;await assert.rejects(k.approve(newer()),/paused/);
});
test('coordinator persists uncertain submission, resumes exactly once and respects pause',async t=>{
 const x=fixture(t),signers=[x.signer(0),x.signer(1),x.signer(2)],sent=[],file=path.join(x.dir,'c.sqlite');
 const args={file,view:async()=>x.state(),config:x.c,key:keys(),options:x.options,signers:signers.map(k=>p=>k.approve(p)),broadcast:async w=>{sent.push(w);if(sent.length===1)throw Error('lost reply');}};
 let c=new CapacityCoordinator(args);await assert.rejects(c.cycle(),/lost reply/);c.close();
 c=new CapacityCoordinator(args);x.resources.push(c);await c.cycle();assert.deepEqual(sent[0],sent[1]);
 x.s.centuryWarmup.controller.sequence++;assert.equal((await c.cycle()).reconciled,1);
 c.enabled=()=>false;assert.equal((await c.cycle()).paused,true);assert.equal(sent.length,2);
});
test('no quorum cannot submit and expired outbox is discarded without payment',async t=>{
 const x=fixture(t),k=x.signer(),sent=[];
 const c=new CapacityCoordinator({file:path.join(x.dir,'c.sqlite'),view:async()=>x.state(),config:x.c,key:keys(),options:x.options,signers:[p=>k.approve(p),()=>{throw Error('offline');}],broadcast:async w=>sent.push(w)});x.resources.push(c);
 await assert.rejects(c.cycle());assert.equal(sent.length,0);
 x.s.money.time+=61;x.s.height++;assert.equal((await c.cycle()).reconciled,1);assert.equal(sent.length,0);
});

test('cached broadcast retains exact outbox across restart until verified reconciliation',async t=>{
 const x=fixture(t),signers=[x.signer(0),x.signer(1),x.signer(2)],sent=[],file=path.join(x.dir,'cached.sqlite');
 const cached=async(_url,_method,params)=>{sent.push(params.tx);throw Error(JSON.stringify({code:-32603,message:'Internal error',data:'tx already exists in cache'}));};
 const args={file,view:async()=>x.state(),config:x.c,key:keys(),options:x.options,signers:signers.map(k=>p=>k.approve(p)),broadcast:w=>broadcastCapacityInterval('http://127.0.0.1:1',w,cached)};
 let c=new CapacityCoordinator(args);assert.equal((await c.cycle()).awaitingConfirmation,1);c.close();
 c=new CapacityCoordinator(args);x.resources.push(c);assert.equal((await c.cycle()).awaitingConfirmation,1);assert.equal(sent[0],sent[1]);
 assert(c.db.prepare('SELECT wire FROM outbox WHERE id=1').get());
 x.s.centuryWarmup.controller.sequence++;assert.equal((await c.cycle()).reconciled,1);
 assert.equal(c.db.prepare('SELECT wire FROM outbox WHERE id=1').get(),undefined);assert.equal(sent.length,2);
 for(const error of [Error('transport unavailable'),Error(JSON.stringify({code:-32603,data:'different failure'})),Error(JSON.stringify({code:1,data:'tx already exists in cache'}))])await assert.rejects(broadcastCapacityInterval('http://127.0.0.1:1',{},async()=>{throw error;}));
 await assert.rejects(broadcastCapacityInterval('http://127.0.0.1:1',{},async()=>({code:1})),/rejected/);
});

test('generated capacity is accepted by consensus once without changing balances or supply',async t=>{
 const x=fixture(t),signers=[x.signer(0),x.signer(1),x.signer(2)],sent=[];
 const c=new CapacityCoordinator({file:path.join(x.dir,'consensus.sqlite'),view:async()=>x.state(),config:x.c,key:keys(),options:x.options,signers:signers.map(k=>p=>k.approve(p)),broadcast:async w=>sent.push(w)});x.resources.push(c);
 await c.cycle();assert.equal(sent.length,1);
 // The fixture's pilot is a planner gate; the signed capacity is processed by
 // the same production consensus rule as every operational certificate.
 const before=hash(x.s.money),certificate=sent[0].body.action.certificate;
 const book=openCenturyWarmupInterval(x.s.centuryWarmup,x.s,certificate);
 assert.equal(hash(x.s.money),before);assert.equal(book.controller.sequence,1);
 assert(book.controller.pending);
 assert.throws(()=>openCenturyWarmupInterval(book,{...x.s,centuryWarmup:book},certificate));
});
test('local root adapter fails closed for disk, stale time, wrong chain and divergent roots',async t=>{
 const x=fixture(t),pub=x.validators[0].publicKey,clock=2000000;let variant='disk';
 const cfg={home:x.dir,api:'http://127.0.0.1:1',config:x.c,validators:[{key:pub,rpc:'http://127.0.0.1:2'},{key:pub,rpc:'http://127.0.0.1:3'}]};
 const view=localCapacityView(cfg,{clock:()=>clock,space:()=>({bavail:variant==='disk'?1:1e9,bsize:1}),query:{withLease:()=>{throw Error('unexpected proof read');}},read:async(url,method)=>method==='status'?{node_info:{network:variant==='chain'?'wrong':x.c.chainId},validator_info:{pub_key:{value:Buffer.from(pub,'base64url').toString('base64')}},sync_info:{catching_up:false,latest_block_height:'100',latest_block_time:new Date(variant==='stale'?0:clock).toISOString()}}:{block:{header:{height:'100',chain_id:x.c.chainId,app_hash:hash(variant==='root'?url:'same')}}}});
 for(const v of ['disk','stale','chain','root']){variant=v;await assert.rejects(view());}
});
