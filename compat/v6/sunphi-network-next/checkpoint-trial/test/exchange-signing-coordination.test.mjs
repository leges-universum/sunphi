import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {resolutionFixture} from './helpers/exchange-resolution-fixture.mjs';
import {coordinatorSession} from '../qa/helpers/exchange-coordinator-session.mjs';
import {connectSigningCoordinator} from '../research/exchange-signing-coordination.mjs';
test('daemon coordinator configuration is mandatory and credentials cannot override its policy',async()=>{
 const config=resolutionFixture().c;await assert.rejects(connectSigningCoordinator({config,backendConfig:{}},{backendSecrets:{}}),/required/);
 const c=await coordinatorSession(fs.mkdtempSync(path.join(os.tmpdir(),'daemon-coordination-')),config);
 try{
  const {key,cert,ca,...policy}=c.options,profile={config,backendConfig:{coordinator:policy}},secrets={backendSecrets:{coordinator:{key,cert,ca}}};
  assert.equal(typeof (await connectSigningCoordinator(profile,secrets)).reserve,'function');assert.equal((await c.status()).length,0);
  const foreign=structuredClone(profile);foreign.config.chainId+='-foreign';await assert.rejects(connectSigningCoordinator(foreign,secrets),/policy mismatch/);
  const changed=structuredClone(secrets);changed.backendSecrets.coordinator.url=policy.url;await assert.rejects(connectSigningCoordinator(profile,changed));
  const wrong=structuredClone(profile);wrong.backendConfig.coordinator.serverFingerprint=Array(32).fill('00').join(':');await assert.rejects(connectSigningCoordinator(wrong,secrets));
  const unsafe=structuredClone(profile);unsafe.backendConfig.coordinator.key=key;await assert.rejects(connectSigningCoordinator(unsafe,secrets));
  await c.stop();await assert.rejects(connectSigningCoordinator(profile,secrets));await c.start();await connectSigningCoordinator(profile,secrets);
 }finally{await c.close();}
});
