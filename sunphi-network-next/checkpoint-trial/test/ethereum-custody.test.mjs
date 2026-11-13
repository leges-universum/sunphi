import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import {join} from 'node:path';import {randomBytes,createECDH} from 'node:crypto';
import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {hash,digest} from '../crypto.mjs';import {ethereumConsensusFixture} from './helpers/ethereum-consensus-fixture.mjs';
import {ExchangeRecovery} from '../research/exchange-recovery.mjs';
import {externalPublicKey,sealExternalCustody,restoreExternalCustody,prepareEthereumCustody} from '../research/exchange-custody.mjs';
function fixture(){
 const f=ethereumConsensusFixture(),worker=new ExchangeRecovery(':memory:',{config:f.c,key:randomBytes(32)}),secrets={bitcoin:randomBytes(32),ethereum:randomBytes(32)};
 const profile={domain:'DUEBYTE_EXCHANGE_EXTERNAL_CUSTODY_V2/PROFILE',configHash:hash(f.c),seller:f.provider.publicKey,bitcoinPublicKey:externalPublicKey(secrets.bitcoin),ethereumPublicKey:externalPublicKey(secrets.ethereum),network:f.p.routes.USDC.network,genesis:f.p.routes.USDC.genesis,contract:f.p.routes.USDC.contract};
 worker.enqueue({quote:f.o.q,providerSignature:f.o.lock.providerSignature,userSignature:f.o.lock.userSignature,arm:f.o.arm,recoveryKind:'REFUND'});
 const dir=fs.mkdtempSync(join(os.tmpdir(),'ethereum-custody-')),password=randomBytes(32).toString('hex');
 return {f,worker,secrets,profile,password,options:checkpoint=>({config:f.c,profile,password,expectedCheckpoint:checkpoint,file:join(dir,'restore.sqlite'),journalKey:randomBytes(32)}),close(){worker.close();Object.values(secrets).forEach(k=>k.fill(0));}};
}

test('initial Ethereum key ceremony returns only encrypted keys bound to the seller and restores disabled',t=>{
 let scalar=0;
 t.mock.method(Object.getPrototypeOf(createECDH('secp256k1')),'generateKeys',function(){this.setPrivateKey(Buffer.from([++scalar]));return this.getPublicKey();});
 const f=ethereumConsensusFixture(),worker=new ExchangeRecovery(':memory:',{config:f.c,key:randomBytes(32)}),password=randomBytes(32).toString('hex'),dir=fs.mkdtempSync(join(os.tmpdir(),'ethereum-ceremony-'));let restored;
 try{
  const result=prepareEthereumCustody(worker,password);assert.deepEqual(Object.keys(result).sort(),['bundle','personalKeyIncluded','profile','signingEnabled']);assert.equal(result.signingEnabled,false);assert.equal(result.personalKeyIncluded,false);
  assert.equal(result.profile.seller,f.provider.publicKey);assert.notEqual(result.profile.bitcoinPublicKey,result.profile.ethereumPublicKey);
  assert(!JSON.stringify(result).includes(f.provider.privateKey));
  const file=join(dir,'encrypted-kit.json'),bytes=Buffer.from(JSON.stringify({config:f.c,profile:result.profile,bundle:result.bundle}));fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600});
  const child=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('../qa/verify-ethereum-custody.mjs',import.meta.url)),file,digest(bytes),result.bundle.checkpoint,join(dir,'offline.sqlite')],{input:password,encoding:'utf8',windowsHide:true,stdio:['pipe','pipe','pipe']}));
  assert.equal(child.verified,true);assert.equal(child.signingEnabled,false);assert.equal(child.seller,f.provider.publicKey);assert.equal(child.publicKeys.ethereum,result.profile.ethereumPublicKey);
  const opts={profile:result.profile,config:f.c,password,expectedCheckpoint:result.bundle.checkpoint,file:join(dir,'recovered.sqlite'),journalKey:randomBytes(32)};
  assert.throws(()=>restoreExternalCustody(result.bundle,{...opts,password:password+'wrong'}));assert(!fs.existsSync(opts.file));
  restored=restoreExternalCustody(result.bundle,opts);assert.equal(restored.signingEnabled,false);assert.equal(restored.worker.restored,true);assert.throws(()=>prepareEthereumCustody(restored.worker,password));
  assert.throws(()=>prepareEthereumCustody(worker,'short'));
 }finally{restored?.worker.close();worker.close();}
});

test('initial ceremony refuses a journal with existing obligations and a non-Ethereum route',()=>{
 const s=fixture();try{assert.throws(()=>prepareEthereumCustody(s.worker,s.password));s.worker.config.exchangeLab.policy.routes.USDC.network='base-mainnet';assert.throws(()=>prepareEthereumCustody(s.worker,s.password));}finally{s.close();}
});
test('Ethereum custody restores correct seller keys and journal without enabling signing',()=>{
 const s=fixture();let restored;try{const b=sealExternalCustody(s.worker,s.profile,s.secrets,s.password),text=JSON.stringify(b);
  for(const k of Object.values(s.secrets))assert(!text.includes(k.toString('hex')));assert(!text.includes(s.f.provider.privateKey));
  restored=restoreExternalCustody(b,s.options(b.checkpoint));assert.equal(restored.signingEnabled,false);assert.equal(restored.publicKeys.ethereum,s.profile.ethereumPublicKey);assert(!Object.hasOwn(restored.publicKeys,'base'));assert.equal(restored.worker.status()[0].status,'RECONCILIATION_REQUIRED');
 }finally{restored?.worker.close();s.close();}
});
test('Ethereum backup cannot be relabeled Base, moved to another seller or restored with stale checkpoint',()=>{
 const s=fixture();try{const b=sealExternalCustody(s.worker,s.profile,s.secrets,s.password);
  for(const patch of [{network:'base-mainnet'},{seller:s.f.user.publicKey},{genesis:hash('wrong')},{domain:'DUEBYTE_EXCHANGE_EXTERNAL_CUSTODY_V1/PROFILE'},{contract:'0x'+'9'.repeat(40)}]){
   const o={...s.options(b.checkpoint),profile:{...s.profile,...patch}};assert.throws(()=>restoreExternalCustody(b,o));assert(!fs.existsSync(o.file));
  }
  for(const patch of [{expectedCheckpoint:hash('newer')},{password:randomBytes(32).toString('hex')}]){const o={...s.options(b.checkpoint),...patch};assert.throws(()=>restoreExternalCustody(b,o));assert(!fs.existsSync(o.file));}
 }finally{s.close();}
});
test('explicit separate Ethereum key required; silently using old Base field is rejected',()=>{
 const s=fixture();try{
  assert.throws(()=>sealExternalCustody(s.worker,s.profile,{bitcoin:s.secrets.bitcoin,base:s.secrets.ethereum},s.password));
  assert.throws(()=>sealExternalCustody(s.worker,{...s.profile,ethereumPublicKey:s.profile.bitcoinPublicKey},{bitcoin:s.secrets.bitcoin,ethereum:s.secrets.bitcoin},s.password));
  assert.throws(()=>sealExternalCustody(s.worker,s.profile,{...s.secrets,ethereum:Buffer.alloc(32)},s.password));
 }finally{s.close();}
});
