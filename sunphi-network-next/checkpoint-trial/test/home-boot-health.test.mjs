import test from 'node:test';import assert from 'node:assert/strict';
import {homeRuntimeHealthy} from '../home-boot-health.mjs';
const chain='test-chain',healthy={progress:'running',walletReady:true,error:null,rpc:{chain,height:'100',votingPower:'0',catchingUp:true}};
test('healthy retained history can continue catching up beyond installer deadline',()=>{
 assert(homeRuntimeHealthy(healthy,chain));
 assert(homeRuntimeHealthy({...healthy,rpc:{...healthy.rpc,catchingUp:false}},chain));
});
test('window readiness and stale partial events cannot acknowledge installation',()=>{
 for(const message of [undefined,{}, {walletReady:true},{progress:'running',walletReady:true},{progress:'reconnecting'}, {...healthy,rpc:null}])assert.equal(homeRuntimeHealthy(message,chain),false);
});
test('failed, stopping, wrong chain, voting and invalid history reports fail closed',()=>{
 for(const progress of ['failed','stopping','stopped','checking-history'])assert.equal(homeRuntimeHealthy({...healthy,progress},chain),false);
 assert.equal(homeRuntimeHealthy({...healthy,walletReady:false},chain),false);
 assert.equal(homeRuntimeHealthy({...healthy,error:'RPC failure'},chain),false);
 for(const change of [{chain:'other'},{votingPower:'1'},{height:'0'},{height:'NaN'},{height:100},{catchingUp:undefined}])assert.equal(homeRuntimeHealthy({...healthy,rpc:{...healthy.rpc,...change}},chain),false);
});
