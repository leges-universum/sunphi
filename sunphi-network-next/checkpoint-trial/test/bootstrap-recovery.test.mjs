import test from 'node:test';
import assert from 'node:assert/strict';
import {BootstrapRecovery} from '../bootstrap-recovery.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {bootstrapFailed,nodeLogOffsets} from '../consumer-errors.mjs';

test('explicit failed state sync retries early but remains bounded and never restarts verified history',()=>{
 const zero={height:'0',catchingUp:true},r=new BootstrapRecovery();r.observe(zero,0);
 assert.equal(r.observe(zero,14999,true),'continue');assert.equal(r.observe(zero,15000,true),'restart');
 assert.equal(r.observe(zero,30000,true),'restart');assert.equal(r.observe(zero,45000,true),'stop');
 const done=new BootstrapRecovery();done.observe({height:'1'},0);assert.equal(done.observe(zero,600000,true),'continue');
});
test('bootstrap failure detection ignores previous attempts and nonterminal peer errors',()=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'duebyte-bootstrap-log-'));fs.mkdirSync(state+'/node');const file=state+'/node/consensus.log',fatal='E[2026-11-07|16:15:54.809] State sync failed module=statesync err="no witnesses connected"\n';fs.writeFileSync(file,fatal);
 const offsets=nodeLogOffsets(state);assert.equal(bootstrapFailed(state,offsets),false);
 fs.appendFileSync(file,'E[time] Stopping peer for error module=p2p err="State sync failed module=statesync"\n');assert.equal(bootstrapFailed(state,offsets),false);
 fs.appendFileSync(file,fatal);assert.equal(bootstrapFailed(state,offsets),true);assert.equal(bootstrapFailed(state,nodeLogOffsets(state)),false);
 fs.unlinkSync(file);assert.equal(bootstrapFailed(state,offsets),false);
});
test('slow initial download gets ten minutes after the first local status',()=>{
 const zero={height:'0',catchingUp:true},r=new BootstrapRecovery();
 assert.equal(r.observe(zero,120000),'continue');
 for(const elapsed of [45000,90000,180000,599999])assert.equal(r.observe(zero,120000+elapsed),'continue');
 assert.equal(r.observe(zero,720000),'restart');assert.equal(r.observe(zero,1320000),'restart');assert.equal(r.observe(zero,1920000),'stop');
});
test('verified history permanently disables bootstrap restarts, including later loss of peers',()=>{
 for(const catchingUp of [true,false]){const r=new BootstrapRecovery();assert.equal(r.observe({height:'1',catchingUp},0),'continue');assert.equal(r.observe({height:'0',catchingUp:true},3600000),'continue');}
});
test('a pre-sync zero-height status cannot disable bounded recovery',()=>{
 const r=new BootstrapRecovery();assert.equal(r.observe({height:'0',catchingUp:false},0),'continue');assert.equal(r.observe({height:'0',catchingUp:true},600000),'restart');
});
