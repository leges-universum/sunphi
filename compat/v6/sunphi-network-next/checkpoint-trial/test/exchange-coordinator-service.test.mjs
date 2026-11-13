import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {hash} from '../crypto.mjs';import {resolutionFixture} from './helpers/exchange-resolution-fixture.mjs';
import {coordinatorSession} from '../qa/helpers/exchange-coordinator-session.mjs';
import {remoteCoordinator} from '../research/exchange-coordinator-service.mjs';
import {coordinatedExternalSigning} from '../research/exchange-signing-coordinator.mjs';
test('separate mTLS coordinator pins identity, fails closed and survives restart',async()=>{
 const out=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-service-')),config=resolutionFixture().c,c=await coordinatorSession(out,config);
 let calls=0;const intent={order:hash('transport-order'),purpose:'REFUND',attempt:0,request:hash('transport-request')};
 const backend={authorize:async()=>{},plan:async()=>({resources:['evm:1:account:0']}),sign:async()=>{calls++;return {raw:'abcd',transaction:hash('transaction')};},inspect:async s=>assert.equal(s.raw,'abcd')};
 try{
  const wrongPin=remoteCoordinator({...c.options,serverFingerprint:Array(32).fill('00').join(':')});await assert.rejects(wrongPin.get(intent));
  const absentClient=remoteCoordinator({...c.options,key:undefined,cert:undefined});await assert.rejects(absentClient.get(intent));
  await assert.rejects(c.channel.get({...intent,unexpected:true}));
  const first=await coordinatedExternalSigning(c.channel,intent,backend);await c.restart();
  const challenge=hash('fresh-online-check'),checkpoint=await c.channel.checkpoint(challenge);
  assert.equal(checkpoint.challenge,challenge);assert.equal(checkpoint.records,1);assert.equal(checkpoint.uncertain,0);
  assert.equal(checkpoint.scope,hash(config));assert.equal(checkpoint.permit,undefined);
  await assert.rejects(wrongPin.checkpoint(challenge));await assert.rejects(absentClient.checkpoint(challenge));
  assert.deepEqual(await coordinatedExternalSigning(c.channel,intent,backend),first);assert.equal(calls,1);
  await c.stop();await assert.rejects(coordinatedExternalSigning(c.channel,{...intent,order:hash('next')},backend));assert.equal(calls,1);
  await c.start();assert.deepEqual(await coordinatedExternalSigning(c.channel,intent,backend),first);assert.equal(calls,1);
 }finally{await c.close();}
});
