import test from 'node:test';
import assert from 'node:assert/strict';
import {BootstrapRecovery} from '../bootstrap-recovery.mjs';
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
