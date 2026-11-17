import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import {join} from 'node:path';import {randomBytes} from 'node:crypto';
import {hash} from '../crypto.mjs';import {resolutionFixture} from './helpers/exchange-resolution-fixture.mjs';import {ExchangeRecovery} from '../research/exchange-recovery.mjs';
import {externalPublicKey,sealExternalCustody,restoreExternalCustody,writeExternalCustody} from '../research/exchange-custody.mjs';
const password='isolated-custody-test-password-only';
function fixture(){const f=resolutionFixture(),o=f.order(),worker=new ExchangeRecovery(':memory:',{config:f.c,key:randomBytes(32)}),secrets={bitcoin:randomBytes(32),base:randomBytes(32)};
 const profile={domain:'DUEBYTE_EXCHANGE_EXTERNAL_CUSTODY_V1/PROFILE',configHash:hash(f.c),seller:f.provider.publicKey,bitcoinPublicKey:externalPublicKey(secrets.bitcoin),basePublicKey:externalPublicKey(secrets.base)};
 const packet={quote:o.q,providerSignature:o.lock.providerSignature,userSignature:o.lock.userSignature,arm:o.arm,recoveryKind:'REFUND'};worker.enqueue(packet);
 const dir=fs.mkdtempSync(join(os.tmpdir(),'duebyte-external-custody-'));return {f,o,worker,secrets,profile,packet,dir,options:(checkpoint,file='restored.sqlite')=>({config:f.c,profile,password,expectedCheckpoint:checkpoint,file:join(dir,file),journalKey:randomBytes(32)})};}
test('external keys and journal recover together without original machine or signing activation',async()=>{
 const s=fixture();let restored;try{const bundle=sealExternalCustody(s.worker,s.profile,s.secrets,password),file=join(s.dir,'backup.json');writeExternalCustody(file,bundle);const text=fs.readFileSync(file,'utf8');for(const key of Object.values(s.secrets))assert(!text.includes(key.toString('hex')));assert(!text.includes(s.f.provider.privateKey));assert.throws(()=>writeExternalCustody(file,bundle));s.worker.close();s.worker=null;
  restored=restoreExternalCustody(JSON.parse(text),s.options(bundle.checkpoint));assert.equal(restored.signingEnabled,false);assert.equal(restored.worker.restored,true);assert.equal(restored.worker.status()[0].status,'RECONCILIATION_REQUIRED');assert.equal(restored.publicKeys.bitcoin,s.profile.bitcoinPublicKey);
  let signs=0;await restored.worker.tick({native:async()=>({configHash:hash(s.f.c),now:2000,order:{quote:s.o.q,plan:s.o.plan,status:'LOCKED'}}),discover:async()=>null,prepare:async()=>{signs++;throw Error('must not sign');}});assert.equal(signs,0);assert.throws(()=>restoreExternalCustody(bundle,s.options(bundle.checkpoint)),/EEXIST/);
  restored.worker.close();restored=null;assert.throws(()=>new ExchangeRecovery(join(s.dir,'restored.sqlite'),{config:s.f.c,key:Buffer.alloc(32)}));
 }finally{s.worker?.close();restored?.worker.close();for(const k of Object.values(s.secrets))k.fill(0);}
});
test('wrong password, tampering, wrong seller, changed policy and stale inventory refuse before destination creation',()=>{
 const s=fixture();try{const bundle=sealExternalCustody(s.worker,s.profile,s.secrets,password);const cases=[{b:bundle,o:{password:'incorrect-password-test'}},{b:{...bundle,tag:'0'.repeat(32)},o:{}},{b:bundle,o:{expectedCheckpoint:hash('newer inventory')}},{b:bundle,o:{profile:{...s.profile,seller:s.f.user.publicKey}}},{b:bundle,o:{config:{...s.f.c,chainId:'another-chain'}}}];
  for(const [i,c] of cases.entries()){const options={...s.options(bundle.checkpoint,'fail'+i+'.sqlite'),...c.o};assert.throws(()=>restoreExternalCustody(c.b,options));assert(!fs.existsSync(options.file));}
 }finally{s.worker.close();for(const k of Object.values(s.secrets))k.fill(0);}
});
test('key substitution, key reuse and invalid scalar cannot be archived',()=>{const s=fixture();try{
 assert.throws(()=>sealExternalCustody(s.worker,s.profile,{...s.secrets,bitcoin:randomBytes(32)},password));assert.throws(()=>sealExternalCustody(s.worker,{...s.profile,basePublicKey:s.profile.bitcoinPublicKey},{bitcoin:s.secrets.bitcoin,base:s.secrets.bitcoin},password));assert.throws(()=>externalPublicKey(Buffer.alloc(32)));
}finally{s.worker.close();for(const k of Object.values(s.secrets))k.fill(0);}});

for(const direction of ['BUY_DUBYT','SELL_DUBYT'])for(const asset of ['BTC','USDC'])test(direction+' '+asset+' custody recovery reuses signed refund after lost broadcast reply',async()=>{
 const s=fixture();let recovered;try{
  const o=s.f.order(direction,asset),packet={quote:o.q,providerSignature:o.lock.providerSignature,userSignature:o.lock.userSignature,arm:o.arm,recoveryKind:'REFUND'};
  s.worker.close();s.worker=new ExchangeRecovery(':memory:',{config:s.f.c,key:randomBytes(32)});s.worker.enqueue(packet);
  let signatures=0,attempts=0,settled=false,observed=false;const receipt=o.resolve('REFUND').receipt,signed={raw:'aabb'.repeat(64),transaction:receipt.body.transaction};
  const adapter={native:async()=>({configHash:hash(s.f.c),now:2000,order:{quote:o.q,plan:o.plan,status:settled?'REFUNDED':'LOCKED',...(settled?{resolution:hash(receipt)}:{})}}),discover:async()=>observed?{kind:'REFUND',transaction:signed.transaction}:null,prepare:async()=>{signatures++;return signed;},inspect:async(p,wire)=>assert.deepEqual(wire,signed),broadcast:async()=>{attempts++;throw Error('lost reply');},attest:async()=>receipt,submit:async()=>{settled=true;}};
  await s.worker.tick(adapter);assert.equal(signatures,1);assert.equal(attempts,1);
  const bundle=sealExternalCustody(s.worker,s.profile,s.secrets,password);s.worker.close();s.worker=null;recovered=restoreExternalCustody(bundle,s.options(bundle.checkpoint));
  adapter.broadcast=async(p,wire)=>{attempts++;assert.deepEqual(wire,signed);observed=true;return wire.transaction;};adapter.prepare=async()=>{assert.fail('restored keys must not sign');};
  await recovered.worker.tick(adapter);await recovered.worker.tick(adapter);assert.equal(recovered.worker.status()[0].status,'COMPLETE');assert.equal(signatures,1);assert.equal(attempts,2);
 }finally{s.worker?.close();recovered?.worker.close();for(const k of Object.values(s.secrets))k.fill(0);}
});
