import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import {join} from 'node:path';import {randomBytes} from 'node:crypto';
import {ExchangeRecovery} from '../research/exchange-recovery.mjs';import {resolutionFixture} from './helpers/exchange-resolution-fixture.mjs';import {hash} from '../crypto.mjs';
import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
// A short hex fragment can occur by chance inside encrypted storage.
const TEST_RAW='abcd'.repeat(64);
test('one recovery journal has exactly one signing executor owner',()=>{
 const f=resolutionFixture(),key=randomBytes(32),file=join(fs.mkdtempSync(join(os.tmpdir(),'duebyte-recovery-owner-')),'journal.sqlite');let first,second;
 try{first=new ExchangeRecovery(file,{config:f.c,key});assert.throws(()=>{second=new ExchangeRecovery(file,{config:f.c,key});},/locked|busy/);assert.deepEqual(first.status(),[]);first.close();first=null;second=new ExchangeRecovery(file,{config:f.c,key});assert.deepEqual(second.status(),[]);}finally{second?.close();first?.close();}
});
test('another process cannot open a live recovery journal',()=>{
 const f=resolutionFixture(),key=randomBytes(32),file=join(fs.mkdtempSync(join(os.tmpdir(),'duebyte-recovery-process-owner-')),'journal.sqlite'),w=new ExchangeRecovery(file,{config:f.c,key});
 try{const code=`import fs from 'node:fs';import {ExchangeRecovery} from './research/exchange-recovery.mjs';const x=JSON.parse(fs.readFileSync(0,'utf8'));try{const w=new ExchangeRecovery(x.file,{config:x.config,key:Buffer.from(x.key,'hex')});w.close();process.exit(71);}catch(e){process.exit(/locked|busy/.test(e.message)?0:72);}`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:fileURLToPath(new URL('..',import.meta.url)),input:JSON.stringify({file,config:f.c,key:key.toString('hex')}),encoding:'utf8',timeout:10000});assert.equal(r.status,0);assert.deepEqual(w.status(),[]);
 }finally{w.close();}
});
function setup(direction='BUY_DUBYT',asset='BTC',kind='CANCELLED'){
 const f=resolutionFixture(),o=f.order(direction,asset),key=randomBytes(32),file=join(fs.mkdtempSync(join(os.tmpdir(),'duebyte-exchange-recovery-')),'journal.sqlite');
 const packet={quote:o.q,providerSignature:o.lock.providerSignature,userSignature:o.lock.userSignature,arm:o.arm,recoveryKind:kind==='PAYOUT'?'OBSERVE':kind},outcome=o.resolve(kind),order={quote:o.q,plan:o.plan,status:'LOCKED'};
 let external=kind==='PAYOUT'?{kind,transaction:outcome.receipt.body.transaction}:null,prepared=0,broadcasts=0,submits=0,offline=false,ambiguous=false;
 const adapter={native:async()=>({configHash:hash(f.c),now:2000,order}),discover:async()=>external,prepare:async()=>{prepared++;return {raw:TEST_RAW,transaction:outcome.receipt.body.transaction};},inspect:async(p,s)=>{assert.deepEqual(p,packet);assert.equal(s.raw,TEST_RAW);},broadcast:async(p,s)=>{broadcasts++;external={kind,transaction:s.transaction};if(ambiguous)throw Error('lost response');return s.transaction;},attest:async()=>{if(offline)throw Error('offline');return outcome.receipt;},submit:async()=>{submits++;order.status=kind==='PAYOUT'?'CLAIMED':'REFUNDED';order.resolution=hash('event');}};
 return {f,o,key,file,packet,adapter,order,counts:()=>({prepared,broadcasts,submits}),offline:v=>offline=v,ambiguous:v=>ambiguous=v,clearExternal:()=>external=null,open:()=>new ExchangeRecovery(file,{config:f.c,key})};
}
for(const direction of ['BUY_DUBYT','SELL_DUBYT'])for(const asset of ['BTC','USDC'])for(const kind of ['PAYOUT','REFUND','CANCELLED'])test(direction+' '+asset+' durable '+kind+' after outage',async()=>{
 const s=setup(direction,asset,kind);let w=s.open();w.enqueue(s.packet);s.offline(true);s.ambiguous(true);await w.tick(s.adapter);w.close();
 const bytes=fs.readFileSync(s.file);assert(!bytes.includes(Buffer.from(s.o.q.externalRefund)));assert(!bytes.includes(Buffer.from(TEST_RAW)));
 w=s.open();s.offline(false);await w.tick(s.adapter);await w.tick(s.adapter);assert.equal(w.status()[0].status,'COMPLETE');assert.equal(s.counts().submits,1);assert.equal(s.counts().prepared,kind==='PAYOUT'?0:1);w.close();
});
test('ambiguous broadcast persists exact bytes across restart and absent RPC evidence',async()=>{const s=setup();let w=s.open();w.enqueue(s.packet);s.ambiguous(true);await w.tick(s.adapter);w.close();s.clearExternal();s.ambiguous(false);w=s.open();await w.tick(s.adapter);assert.deepEqual(s.counts(),{prepared:1,broadcasts:2,submits:1});w.close();});

test('mempool acceptance stays pending until a verified terminal state arrives',async()=>{
 const s=setup(),w=s.open();let queued=0;s.adapter.submit=async()=>{queued++;return {accepted:true};};w.enqueue(s.packet);
 await w.tick(s.adapter);assert.equal(w.status()[0].status,'RESOLUTION_PENDING');assert.equal(s.order.status,'LOCKED');assert.equal(queued,1);
 s.adapter.submit=async()=>{throw Error('already queued');};await w.tick(s.adapter);assert.notEqual(w.status()[0].status,'COMPLETE');
 s.order.status='REFUNDED';s.order.resolution=hash('confirmed event');await w.tick(s.adapter);assert.equal(w.status()[0].status,'COMPLETE');assert.equal(s.counts().broadcasts,1);w.close();
});
test('wrong key, network, changed packet and corrupted journal fail closed',async()=>{const s=setup(),w=s.open();w.enqueue(s.packet);assert.throws(()=>w.enqueue({...s.packet,recoveryKind:'REFUND'}));w.close();assert.throws(()=>new ExchangeRecovery(s.file,{config:s.f.c,key:randomBytes(32)}));const c=structuredClone(s.f.c);c.exchangeLab.feeMicro='1001';assert.throws(()=>new ExchangeRecovery(s.file,{config:c,key:s.key}));const next=s.open();next.db.prepare('UPDATE exchange_recovery_jobs SET packet=?').run('{}');assert.equal((await next.tick(s.adapter))[0].status,'RETRY');assert.equal(s.counts().submits,0);next.close();});

test('pending resolution throttles retries, survives lost replies and reconciles after restart',async()=>{
 const s=setup();let clock=0,attempts=0,lost=true;
 s.adapter.submit=async()=>{attempts++;if(lost)throw Error('response lost');};
 let w=new ExchangeRecovery(s.file,{config:s.f.c,key:s.key,retryClock:()=>clock});w.enqueue(s.packet);
 await w.tick(s.adapter);assert.equal(attempts,1);assert.equal(w.status()[0].status,'RETRY');
 for(let i=0;i<20;i++){clock+=1000;await w.tick(s.adapter);}assert.equal(attempts,1);assert.equal(w.status()[0].status,'RESOLUTION_PENDING');
 clock=30000;lost=false;await w.tick(s.adapter);assert.equal(attempts,2);assert.equal(s.order.status,'LOCKED');
 w.close();w=new ExchangeRecovery(s.file,{config:s.f.c,key:s.key,retryClock:()=>clock});
 await w.tick(s.adapter);assert.equal(attempts,3);await w.tick(s.adapter);assert.equal(attempts,3);
 s.order.status='REFUNDED';s.order.resolution=hash('confirmed after restart');await w.tick(s.adapter);
 assert.equal(w.status()[0].status,'COMPLETE');assert.equal(attempts,3);assert.equal(s.counts().prepared,1);w.close();
});

test('fresh evidence bypasses pending cooldown but expired evidence cannot be resent',async()=>{
 const s=setup();let now=2000,attempts=0,clock=0,offline=false;
 s.adapter.native=async()=>({configHash:hash(s.f.c),now,order:s.order});
 s.adapter.attest=async()=>{assert(!offline);return s.o.resolve('CANCELLED',now).receipt;};
 s.adapter.submit=async()=>{attempts++;};
 const w=new ExchangeRecovery(s.file,{config:s.f.c,key:s.key,retryClock:()=>clock});w.enqueue(s.packet);
 await w.tick(s.adapter);assert.equal(attempts,1);
 now=2200;clock=1000;offline=true;await w.tick(s.adapter);assert.equal(attempts,1);
 offline=false;await w.tick(s.adapter);assert.equal(attempts,2);w.close();
});
test('no external recovery before deadline or without confirmed native ARM',async()=>{const s=setup(),w=s.open();w.enqueue(s.packet);s.adapter.native=async()=>({configHash:hash(s.f.c),now:1001,order:s.order});await w.tick(s.adapter);assert.equal(s.counts().prepared,0);s.order.plan=null;await w.tick(s.adapter);assert.equal(s.counts().broadcasts,0);w.close();});
test('quorum forgery and RPC outage cannot settle or infer cancellation',async()=>{const s=setup(),w=s.open();w.enqueue(s.packet);s.adapter.discover=async()=>{throw Error('RPC down');};await w.tick(s.adapter);assert.deepEqual(s.counts(),{prepared:0,broadcasts:0,submits:0});s.adapter.discover=async()=>({kind:'CANCELLED'});s.adapter.attest=async()=>({...s.o.resolve('CANCELLED').receipt,signatures:[]});await w.tick(s.adapter);assert.equal(s.counts().submits,0);w.close();});
test('periodic worker stops cleanly and a completed journal still reconciles native state',async()=>{const s=setup(),w=s.open();w.enqueue(s.packet);const controller=new AbortController();let cycles=0;await w.run(s.adapter,{signal:controller.signal,intervalMs:100,onCycle:()=>{if(++cycles===2)controller.abort();}});assert.equal(w.status()[0].status,'COMPLETE');s.order.status='LOCKED';await w.tick(s.adapter);assert.equal(s.counts().submits,2);assert.equal(s.counts().broadcasts,1);w.close();});
test('process exit during broadcast recovers the committed outbox without signing again',async()=>{
 const s=setup(),code=`import fs from 'node:fs';import {ExchangeRecovery} from './research/exchange-recovery.mjs';import {hash} from './crypto.mjs';const x=JSON.parse(fs.readFileSync(0,'utf8'));const w=new ExchangeRecovery(x.file,{config:x.config,key:Buffer.from(x.key,'hex')});w.enqueue(x.packet);await w.tick({native:async()=>({configHash:hash(x.config),now:2000,order:x.order}),discover:async()=>null,prepare:async()=>x.signed,inspect:async()=>{},broadcast:async()=>process.exit(73)});process.exit(74);`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:fileURLToPath(new URL('..',import.meta.url)),input:JSON.stringify({file:s.file,config:s.f.c,key:s.key.toString('hex'),packet:s.packet,order:s.order,signed:{raw:TEST_RAW,transaction:s.o.resolve('CANCELLED').receipt.body.transaction}}),encoding:'utf8',timeout:15000});assert.equal(r.status,73,r.stderr);
 s.adapter.prepare=async()=>{throw Error('must reuse persisted transaction');};const w=s.open();await w.tick(s.adapter);await w.tick(s.adapter);assert.deepEqual(s.counts(),{prepared:0,broadcasts:1,submits:1});assert.equal(w.status()[0].status,'COMPLETE');w.close();
});
test('future observation survives restart and settles when consensus catches up',async()=>{
 const s=setup();let now=1990,attestations=0;const attest=s.adapter.attest;s.adapter.attest=async(...args)=>{attestations++;return attest(...args);};s.adapter.native=async()=>({configHash:hash(s.f.c),now,order:s.order});
 let w=s.open();w.enqueue(s.packet);await w.tick(s.adapter);assert.equal(w.status()[0].status,'AWAITING_CONSENSUS');assert.equal(s.counts().submits,0);w.close();s.offline(true);now=2001;w=s.open();await w.tick(s.adapter);await w.tick(s.adapter);assert.equal(w.status()[0].status,'COMPLETE');assert.equal(attestations,1);assert.equal(s.counts().submits,1);w.close();
});
test('expired cached evidence is refreshed instead of accepted after a long pause',async()=>{
 const s=setup();let now=1990;s.adapter.native=async()=>({configHash:hash(s.f.c),now,order:s.order});const w=s.open();w.enqueue(s.packet);await w.tick(s.adapter);now=2500;s.offline(true);await w.tick(s.adapter);assert.equal(s.counts().submits,0);s.offline(false);s.adapter.attest=async()=>s.o.resolve('CANCELLED',2500).receipt;await w.tick(s.adapter);assert.equal(s.counts().submits,1);w.close();
});
test('confirmed EVM revert permits a fresh signed recovery attempt after durable retirement',async()=>{
 const s=setup('BUY_DUBYT','USDC','REFUND');let prepares=0,sent,external=null;
 s.adapter.prepare=async()=>({raw:'ab'+(++prepares).toString(16).padStart(2,'0'),transaction:hash(['attempt',prepares])});s.adapter.inspect=async()=>{};
 s.adapter.discover=async()=>external;s.adapter.broadcast=async(p,tx)=>{sent=tx;if(prepares===1)throw Error('confirmed revert');external={kind:'REFUND',transaction:tx.transaction};return tx.transaction;};
 s.adapter.failed=async(p,tx)=>tx.transaction===hash(['attempt',1])?{transaction:tx.transaction,block:hash('failed block')}:null;
 s.adapter.attest=async()=>s.f.signReceipt({...s.o.resolve('REFUND').receipt.body,transaction:sent.transaction});
 let w=s.open();w.enqueue(s.packet);await w.tick(s.adapter);await w.tick(s.adapter);assert.equal(prepares,1);assert.equal(w.db.prepare('SELECT count(*) AS n FROM exchange_recovery_retired').get().n,1);w.close();
 w=s.open();await w.tick(s.adapter);await w.tick(s.adapter);assert.equal(prepares,2);assert.equal(s.counts().submits,1);assert.equal(w.status()[0].status,'COMPLETE');w.close();
});
test('revert retries are bounded and an unrelated failure cannot retire an outbox',async()=>{
 const s=setup('BUY_DUBYT','USDC','REFUND');let prepares=0,bad=true;
 s.adapter.prepare=async()=>({raw:'ab'+(++prepares).toString(16).padStart(2,'0'),transaction:hash(['attempt',prepares])});s.adapter.inspect=async()=>{};s.adapter.discover=async()=>null;s.adapter.broadcast=async()=>{throw Error('revert');};s.adapter.failed=async(p,tx)=>({transaction:bad?hash('other'):tx.transaction,block:hash('block')});
 const w=s.open();w.enqueue(s.packet);await w.tick(s.adapter);await w.tick(s.adapter);assert.equal(w.db.prepare('SELECT count(*) AS n FROM exchange_recovery_retired').get().n,0);bad=false;for(let i=0;i<12;i++)await w.tick(s.adapter);assert.equal(prepares,4);assert.equal(w.status()[0].status,'REVIEW_REQUIRED');assert.equal(s.counts().submits,0);w.close();
});
