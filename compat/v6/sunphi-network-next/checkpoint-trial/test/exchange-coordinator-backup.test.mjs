import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';
import {hash} from '../crypto.mjs';import {resolutionFixture} from './helpers/exchange-resolution-fixture.mjs';
import {SigningCoordinator,coordinatorChannel,coordinatedExternalSigning} from '../research/exchange-signing-coordinator.mjs';
import {sealCoordinatorBackup,openCoordinatorRecovery,writeCoordinatorBackup,validateCoordinatorSnapshot} from '../research/exchange-coordinator-backup.mjs';
const password='disposable-fixture-password-only';
function fixture(t){
 const config=resolutionFixture().c,dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-backup-')),file=path.join(dir,'inventory.sqlite'),key=randomBytes(32);
 let coordinator=new SigningCoordinator(file,{config,key,create:true});
 t.after(()=>{coordinator?.close();key.fill(0);fs.rmSync(dir,{recursive:true,force:true});});
 return {config,dir,get coordinator(){return coordinator;},restart(){coordinator.close();coordinator=new SigningCoordinator(file,{config,key});},backup:()=>sealCoordinatorBackup(coordinator,password),open:(b,checkpoint=b.checkpoint)=>openCoordinatorRecovery(b.bundle,{password,config,checkpoint})};
}
const intent=(label,purpose='PAYOUT')=>({order:hash(label),purpose,attempt:0,request:hash(['request',label,purpose])});
function backend(resource,calls){return {authorize:async()=>{},plan:async()=>({resources:[resource]}),sign:async p=>{calls.n++;return {raw:'abcd',transaction:hash(p)};},inspect:async(s,p)=>assert.equal(s.transaction,hash(p))};}
test('portable recovery retains BTC/USDC BUY/SELL payouts/refunds/cancellations but no signing capabilities',async t=>{
 const x=fixture(t),calls={n:0},entries=[],ch=coordinatorChannel(x.coordinator,x.coordinator.activate());
 for(const asset of ['BTC','USDC'])for(const direction of ['BUY','SELL'])for(const purpose of ['FUNDING','PAYOUT','REFUND','CANCELLED']){
  const label=[asset,direction,purpose].join('-'),i=intent(label,purpose),b=backend(asset+':'+label,calls),s=await coordinatedExternalSigning(ch,i,b);entries.push({i,b,s});
 }
 const exported=x.backup(),destination=path.join(x.dir,'backup.encrypted.json');writeCoordinatorBackup(destination,exported.bundle);
 const receipt=JSON.parse(JSON.stringify(exported.checkpoint)),r=x.open({bundle:JSON.parse(fs.readFileSync(destination)),checkpoint:receipt});
 assert.equal(r.report.signed,16);assert.equal(r.report.resources,16);assert.equal(r.report.signingEnabled,false);assert.equal(r.report.freshnessProven,false);
 for(const name of ['reserve','commit','activate','restoreSnapshot'])assert.equal(r[name],undefined);
 for(const e of entries){const restored=r.get(e.i);assert.deepEqual(restored.signed,e.s);assert(!('permit' in restored));restored.signed.raw='ffff';assert.deepEqual(r.get(e.i).signed,e.s);}
 const changed={...entries[0].i,request:hash('different')};assert.throws(()=>r.get(changed),/immutable/);
 x.restart();const current=coordinatorChannel(x.coordinator,x.coordinator.activate());
 for(const e of entries)assert.deepEqual(await coordinatedExternalSigning(current,e.i,e.b),e.s);assert.equal(calls.n,16);
 await assert.rejects(coordinatedExternalSigning(r,intent('new'),entries[0].b));assert.equal(calls.n,16);
});
test('stale or altered backup cannot match independently retained newer checkpoint',async t=>{
 const x=fixture(t),ch=coordinatorChannel(x.coordinator,x.coordinator.activate()),calls={n:0},old=x.backup();
 await coordinatedExternalSigning(ch,intent('later'),backend('evm:1:account:7',calls));const latest=x.backup();
 assert.throws(()=>x.open(old,latest.checkpoint),/independent checkpoint/);
 // A jointly old receipt is detectable only operationally. It NEVER grants signing.
 const oldView=x.open(old);assert.equal(oldView.report.records,0);assert.equal(oldView.report.freshnessProven,false);assert.equal(oldView.report.signingEnabled,false);
 const changed=structuredClone(latest);changed.bundle.tag='0'.repeat(32);assert.throws(()=>x.open(changed));
 changed.checkpoint.bundleHash=hash(changed.bundle);assert.throws(()=>x.open(changed));
 assert.throws(()=>openCoordinatorRecovery(latest.bundle,{password:'incorrect-password-here',config:x.config,checkpoint:latest.checkpoint}));
 assert.throws(()=>openCoordinatorRecovery(latest.bundle,{password,config:{...x.config,chainId:'foreign'},checkpoint:latest.checkpoint}));
 assert.throws(()=>x.open(latest,{...latest.checkpoint,snapshotHash:hash('foreign')}),/snapshot checkpoint/);
});
test('crash between signing and commit remains uncertain in backups and across coordinator restart',async t=>{
 const x=fixture(t),calls={n:0},ch=coordinatorChannel(x.coordinator,x.coordinator.activate()),i=intent('uncertain','FUNDING'),b=backend('btc:genesis:input:0',calls);
 await assert.rejects(coordinatedExternalSigning({...ch,commit:async()=>{throw Error('lost coordinator');}},i,b));
 const view=x.open(x.backup());assert.equal(view.report.uncertain,1);assert.equal(view.get(i).status,'PREPARING');assert(!('permit' in view.get(i)));assert(!('signed' in view.get(i)));
 x.restart();await assert.rejects(coordinatedExternalSigning(coordinatorChannel(x.coordinator,x.coordinator.activate()),intent('other'),b),/uncertain/);assert.equal(calls.n,1);
});
test('resource and terminal indexes must exactly match authenticated records',async t=>{
 const x=fixture(t),ch=coordinatorChannel(x.coordinator,x.coordinator.activate()),calls={n:0};await coordinatedExternalSigning(ch,intent('terminal'),backend('evm:1:account:8',calls));
 const s=x.coordinator.recoverySnapshot();assert.equal(validateCoordinatorSnapshot(s,x.coordinator.scope).signed,1);
 for(const field of ['resources','terminals']){const bad=structuredClone(s);bad[field]=[];assert.throws(()=>validateCoordinatorSnapshot(bad,x.coordinator.scope),/index mismatch/);}
 const leaked=structuredClone(s);leaked.records[0].permit='0'.repeat(64);assert.throws(()=>validateCoordinatorSnapshot(leaked,x.coordinator.scope),/exact fields/);
 const bad=structuredClone(s);bad.records[0].signed.raw='invalid';assert.throws(()=>validateCoordinatorSnapshot(bad,x.coordinator.scope));
 const duplicate=structuredClone(s);duplicate.records.push(duplicate.records[0]);assert.throws(()=>validateCoordinatorSnapshot(duplicate,x.coordinator.scope),/duplicate/);
});
test('backup write never overwrites existing inventory or follows destination symlink',t=>{
 const x=fixture(t),b=x.backup(),file=path.join(x.dir,'kept');fs.writeFileSync(file,'retained');assert.throws(()=>writeCoordinatorBackup(file,b.bundle),/EEXIST/);assert.equal(fs.readFileSync(file,'utf8'),'retained');
 if(process.platform!=='win32'){const link=path.join(x.dir,'link');fs.symlinkSync(file,link);assert.throws(()=>writeCoordinatorBackup(link,b.bundle),/EEXIST/);assert.equal(fs.readFileSync(file,'utf8'),'retained');}
});
