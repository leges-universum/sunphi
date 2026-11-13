import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {hash} from '../crypto.mjs';
import {ExchangeSigningAuthority,fencedPreparation} from '../research/exchange-signing-authority.mjs';
import {ExchangeRecovery} from '../research/exchange-recovery.mjs';
import {resolutionFixture} from './helpers/exchange-resolution-fixture.mjs';

const raw='ab45'.repeat(64);
function fixture(asset='BTC'){
 const f=resolutionFixture(),o=f.order('BUY_DUBYT',asset),dir=fs.mkdtempSync(join(os.tmpdir(),'duebyte-signing-')),file=join(dir,'authority.sqlite'),key=randomBytes(32);
 const packet={quote:o.q,providerSignature:o.lock.providerSignature,userSignature:o.lock.userSignature,arm:o.arm,recoveryKind:'REFUND'};
 let signatures=0,nonce=0,allow=true,reverted=false;
 const backend={authorize:async()=>assert(allow,'not authorized'),plan:async()=>({resources:['nonce:'+nonce],nonce}),sign:async(p,plan)=>{signatures++;return {raw,transaction:hash(plan)};},inspect:async(p,s,plan)=>{assert.equal(s.raw,raw);assert.equal(s.transaction,hash(plan));},failed:async(p,s)=>reverted?{transaction:s.transaction,block:hash('canonical revert')}:null};
 return {f,o,dir,file,key,packet,backend,signatures:()=>signatures,nonce:v=>nonce=v,allow:v=>allow=v,reverted:v=>reverted=v,open:()=>new ExchangeSigningAuthority(file,{config:f.c,key,backend,create:!fs.existsSync(file)})};
}
test('copied active worker journals receive one identical signature from a separate authority',async()=>{
 const s=fixture(),key=randomBytes(32),file=join(s.dir,'worker.sqlite');let w=new ExchangeRecovery(file,{config:s.f.c,key});w.enqueue(s.packet);w.close();fs.copyFileSync(file,join(s.dir,'copy.sqlite'));
 const a=s.open(),prepare=fencedPreparation(a,a.activate()),signed=[];
 const adapter={native:async()=>({configHash:hash(s.f.c),now:2000,order:{quote:s.o.q,plan:s.o.plan,status:'LOCKED'}}),discover:async()=>null,prepare,inspect:async()=>{},broadcast:async(p,tx)=>{signed.push(tx);throw Error('outage after signature');}};
 try{for(const path of [file,join(s.dir,'copy.sqlite')]){w=new ExchangeRecovery(path,{config:s.f.c,key});await w.tick(adapter);assert.equal(w.status()[0].status,'RETRY');w.close();}assert.equal(s.signatures(),1);assert.equal(signed.length,2);assert.deepEqual(signed[0],signed[1]);assert(!fs.readFileSync(s.file).includes(Buffer.from(raw)));}finally{a.close();}
});
test('rotation and restart retire old worker capabilities while preserving exact signed bytes',async()=>{
 const s=fixture();let a=s.open(),session=a.activate();const signed=await a.prepare(session,s.packet),next=a.activate();await assert.rejects(a.prepare(session,s.packet),/retired/);assert.deepEqual(await a.prepare(next,s.packet),signed);a.close();a=s.open();try{await assert.rejects(a.prepare(next,s.packet),/retired/);assert.deepEqual(await a.prepare(a.activate(),s.packet),signed);assert.equal(s.signatures(),1);}finally{a.close();}
});
test('authorization failures and forged sessions cannot invoke signing',async()=>{
 const s=fixture(),a=s.open(),session=a.activate();try{await assert.rejects(a.prepare({...session,token:'00'.repeat(32)},s.packet));s.allow(false);await assert.rejects(a.prepare(session,s.packet),/not authorized/);assert.equal(s.signatures(),0);assert.deepEqual(a.status(),[]);}finally{a.close();}
});
test('one nonce or UTXO cannot be assigned to two different orders',async()=>{
 const s=fixture(),a=s.open(),session=a.activate(),o=s.f.order('SELL_DUBYT','BTC'),other={quote:o.q,providerSignature:o.lock.providerSignature,userSignature:o.lock.userSignature,arm:o.arm,recoveryKind:'REFUND'};
 try{await a.prepare(session,s.packet);await assert.rejects(a.prepare(session,other),/UNIQUE/);assert.equal(s.signatures(),1);assert.equal(a.status().length,1);}finally{a.close();}
});
test('concurrent calls cannot cross an active signing operation and caller mutation is isolated',async()=>{
 const s=fixture();let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);s.backend.authorize=async()=>{entered();await gate;};const a=s.open(),session=a.activate(),packet=structuredClone(s.packet),first=a.prepare(session,packet);
 await ready;await assert.rejects(a.prepare(session,s.packet),/busy/);assert.throws(()=>a.activate(),/busy/);packet.quote.externalRefund='changed';release();try{await first;assert.deepEqual(await a.prepare(session,s.packet),await first);assert.equal(s.signatures(),1);}finally{a.close();}
});
test('unknown signature result remains blocked across restart and does not sign another intent',async()=>{
 const s=fixture();s.backend.sign=async()=>{throw Error('signer response lost');};let a=s.open();await assert.rejects(a.prepare(a.activate(),s.packet),/lost/);a.close();a=s.open();const session=a.activate();try{await assert.rejects(a.prepare(session,s.packet),/uncertain/);const o=s.f.order('SELL_DUBYT'),p={quote:o.q,providerSignature:o.lock.providerSignature,userSignature:o.lock.userSignature,arm:o.arm,recoveryKind:'REFUND'};await assert.rejects(a.prepare(session,p),/uncertain/);assert.equal(a.status()[0].status,'PREPARING');}finally{a.close();}
});
test('actual process death inside signing preserves the fail-closed intent',async()=>{
 const s=fixture(),code=`import fs from 'node:fs';import {ExchangeSigningAuthority} from './research/exchange-signing-authority.mjs';const x=JSON.parse(fs.readFileSync(0,'utf8'));const a=new ExchangeSigningAuthority(x.file,{config:x.config,key:Buffer.from(x.key,'hex'),create:true,backend:{authorize:async()=>{},plan:async()=>({resources:['utxo:1']}),inspect:async()=>{},sign:async()=>process.exit(73)}});await a.prepare(a.activate(),x.packet);process.exit(74);`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:fileURLToPath(new URL('..',import.meta.url)),input:JSON.stringify({file:s.file,key:s.key.toString('hex'),config:s.f.c,packet:s.packet}),encoding:'utf8',timeout:15000});assert.equal(r.status,73,r.stderr);const a=s.open();try{await assert.rejects(a.prepare(a.activate(),s.packet),/uncertain/);assert.equal(s.signatures(),0);}finally{a.close();}
});
test('only ordered finalized EVM reverts permit a bounded fresh nonce',async()=>{
 const s=fixture('USDC'),a=s.open(),session=a.activate();try{await a.prepare(session,s.packet);s.nonce(1);await assert.rejects(a.prepare(session,s.packet,{attempt:1}),/finalized revert/);s.reverted(true);for(let n=1;n<=3;n++){s.nonce(n);await a.prepare(session,s.packet,{attempt:n});}await assert.rejects(a.prepare(session,s.packet,{attempt:4}));assert.equal(s.signatures(),4);}finally{a.close();}
});
test('invalid resource plans and altered signed bytes cannot escape',async()=>{
 const s=fixture(),a=s.open(),session=a.activate();s.backend.plan=async()=>({resources:['same','same']});await assert.rejects(a.prepare(session,s.packet));assert.equal(s.signatures(),0);s.backend.plan=async()=>({resources:['nonce:1']});s.backend.inspect=async()=>{throw Error('invalid signature');};try{await assert.rejects(a.prepare(session,s.packet),/invalid signature/);assert.equal(a.status()[0].status,'PREPARING');}finally{a.close();}
});
test('authority database rejects wrong keys and concurrent owners',()=>{
 const s=fixture(),a=s.open();assert.throws(()=>s.open(),/locked|busy/);a.close();assert.throws(()=>new ExchangeSigningAuthority(s.file,{config:s.f.c,key:randomBytes(32),backend:s.backend}));
});
test('missing or substituted worker inventory cannot silently initialize a signer',()=>{
 const s=fixture(),options={config:s.f.c,key:s.key,backend:s.backend};assert.throws(()=>new ExchangeSigningAuthority(s.file,options),/inventory missing/);assert(!fs.existsSync(s.file));
 const w=new ExchangeRecovery(s.file,options);w.enqueue(s.packet);w.close();assert.throws(()=>new ExchangeSigningAuthority(s.file,options),/worker journal/);assert.throws(()=>new ExchangeSigningAuthority(s.file,{...options,create:true}),/new file/);
 const source=new ExchangeRecovery(join(s.dir,'source.sqlite'),options),snapshot=source.snapshot();source.close();const restored=join(s.dir,'restored.sqlite'),r=new ExchangeRecovery(restored,options);r.restoreSnapshot(snapshot);r.close();assert.throws(()=>new ExchangeSigningAuthority(restored,options),/restored worker/);
});
