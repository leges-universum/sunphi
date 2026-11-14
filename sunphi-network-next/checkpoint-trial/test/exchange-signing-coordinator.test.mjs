import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import {join} from 'node:path';import {randomBytes} from 'node:crypto';
import {hash} from '../crypto.mjs';import {resolutionFixture} from './helpers/exchange-resolution-fixture.mjs';
import {SigningCoordinator,coordinatorChannel,coordinatedExternalSigning} from '../research/exchange-signing-coordinator.mjs';
import {ExchangeSigningAuthority} from '../research/exchange-signing-authority.mjs';
function fixture(){const f=resolutionFixture(),dir=fs.mkdtempSync(join(os.tmpdir(),'coordinator-')),file=join(dir,'independent.sqlite'),key=randomBytes(32);let c;const open=()=>{c=new SigningCoordinator(file,{config:f.c,key,create:!fs.existsSync(file)});return c;};open();let count=0;const intent={order:hash('order'),purpose:'FUNDING',attempt:0,request:hash('authorized')};const backend={authorize:async()=>{},plan:async()=>({resources:['evm:1:account:0']}),sign:async p=>{count++;return {raw:'abcd',transaction:hash(p)};},inspect:async(s,p)=>{assert.equal(s.raw,'abcd');assert.equal(s.transaction,hash(p));}};return {f,dir,file,key,intent,backend,count:()=>count,open,get c(){return c;},channel:()=>coordinatorChannel(c,c.activate())};}
test('concurrent clones obtain one signing permit; duplicate returns original bytes',async()=>{
 const x=fixture(),channel=x.channel();let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);const backend={...x.backend,sign:async p=>{entered();await gate;return x.backend.sign(p);}};
 const first=coordinatedExternalSigning(channel,x.intent,backend);await ready;await assert.rejects(coordinatedExternalSigning(channel,x.intent,backend),/uncertain/);assert(!('permit' in await channel.get(x.intent)));release();const a=await first;assert.deepEqual(await coordinatedExternalSigning(channel,x.intent,backend),a);assert.equal(x.count(),1);x.c.close();
});
test('all signing purposes share nonce and UTXO reservations; terminal actions conflict',async()=>{
 const x=fixture(),ch=x.channel();try{
  await coordinatedExternalSigning(ch,x.intent,x.backend);
  for(const purpose of ['PAYOUT','REFUND','CANCELLED'])await assert.rejects(coordinatedExternalSigning(ch,{...x.intent,order:hash(purpose),purpose},x.backend),/UNIQUE/);
  const b={...x.backend,plan:async()=>({resources:['btc:genesis:tx:0']})};await coordinatedExternalSigning(ch,{...x.intent,purpose:'PAYOUT'},b);
  await assert.rejects(coordinatedExternalSigning(ch,{...x.intent,purpose:'REFUND'},{...b,plan:async()=>({resources:['evm:1:account:1']})}),/conflicting terminal/);
  await assert.rejects(coordinatedExternalSigning(ch,{...x.intent,order:hash('other')},b),/UNIQUE/);assert.equal(x.count(),2);
 }finally{x.c.close();}
});
test('lost commit reply and stale signer copy recover signed bytes without signing again',async()=>{
 const x=fixture(),ch=x.channel();const lost={...ch,commit:async(...a)=>{await ch.commit(...a);throw Error('lost reply');}};
 await assert.rejects(coordinatedExternalSigning(lost,x.intent,x.backend));x.c.close();x.open();const recovered=await coordinatedExternalSigning(x.channel(),x.intent,x.backend);assert.equal(recovered.raw,'abcd');assert.equal(x.count(),1);x.c.close();
});
test('crash after signature before commit preserves uncertainty across restart and rotation',async()=>{
 const x=fixture(),ch=x.channel();await assert.rejects(coordinatedExternalSigning({...ch,commit:async()=>{throw Error('outage');}},x.intent,x.backend));x.c.close();x.open();const next=x.channel();
 try{await assert.rejects(coordinatedExternalSigning(next,x.intent,x.backend),/uncertain/);await assert.rejects(coordinatedExternalSigning(next,{...x.intent,order:hash('new')},x.backend),/uncertain/);assert.equal(x.count(),1);}finally{x.c.close();}
});
test('independent coordinator outage never falls back to local signing',async()=>{
 const x=fixture();try{await assert.rejects(coordinatedExternalSigning({get:async()=>{throw Error('offline');}},x.intent,x.backend));assert.equal(x.count(),0);}finally{x.c.close();}
});
test('wrong capability, changed intent, changed bytes and duplicate resources rejected',async()=>{
 const x=fixture(),s=x.c.activate(),ch=coordinatorChannel(x.c,s);try{
  assert.throws(()=>x.c.get({...s,token:'0'.repeat(64)},x.intent));const old=s;x.c.activate();assert.throws(()=>x.c.get(old,x.intent),/retired/);
  const current=x.channel();await assert.rejects(coordinatedExternalSigning(current,x.intent,{...x.backend,plan:async()=>({resources:['same','same']})}));
  await coordinatedExternalSigning(current,x.intent,x.backend);await assert.rejects(coordinatedExternalSigning(current,{...x.intent,request:hash('changed')},x.backend));
  assert.throws(()=>x.c.commit(x.c.activate(),x.intent,'0'.repeat(64),{raw:'ff',transaction:hash('bad')}));
 }finally{x.c.close();}
});
test('copied authority databases use independent journal instead of their stale local state',async()=>{
 const x=fixture(),o=x.f.order('BUY_DUBYT','BTC'),packet={quote:o.q,providerSignature:o.lock.providerSignature,userSignature:o.lock.userSignature,arm:o.arm,recoveryKind:'REFUND'},file=join(x.dir,'authority.sqlite'),key=randomBytes(32),ch=x.channel();
 const backend={authorize:()=>x.backend.authorize(),plan:()=>x.backend.plan(),sign:(_p,plan)=>x.backend.sign(plan),inspect:(_p,s,plan)=>x.backend.inspect(s,plan)};
 const options={config:x.f.c,key,backend,coordinator:ch};new ExchangeSigningAuthority(file,{...options,create:true}).close();const copy=join(x.dir,'copied.sqlite');fs.copyFileSync(file,copy);
 const a=new ExchangeSigningAuthority(file,options),b=new ExchangeSigningAuthority(copy,options);
 try{const first=await a.prepare(a.activate(),packet);assert.deepEqual(await b.prepare(b.activate(),packet),first);assert.equal(x.count(),1);}finally{a.close();b.close();x.c.close();}
});
test('missing, foreign, concurrent and wrong-key coordinator stores are rejected',()=>{
 const x=fixture();assert.throws(()=>new SigningCoordinator(x.file,{config:x.f.c,key:x.key}),/locked|busy/);x.c.close();assert.throws(()=>new SigningCoordinator(x.file,{config:x.f.c,key:randomBytes(32)}));assert.throws(()=>new SigningCoordinator(join(x.dir,'missing'),{config:x.f.c,key:x.key}));
});

test('enrolled authority cannot silently reopen without independent coordination',()=>{
 const x=fixture(),file=join(x.dir,'enrolled.sqlite'),key=randomBytes(32);
 const options={config:x.f.c,key,backend:x.backend};
 try{new ExchangeSigningAuthority(file,{...options,create:true,coordinator:x.channel()}).close();assert.throws(()=>new ExchangeSigningAuthority(file,options),/local fallback forbidden/);new ExchangeSigningAuthority(file,{...options,coordinator:x.channel()}).close();}finally{x.c.close();}
});

test('coordinated recovery requires the previous finalized revert for each fresh nonce',async()=>{
 const x=fixture(),o=x.f.order('BUY_DUBYT','USDC'),packet={quote:o.q,providerSignature:o.lock.providerSignature,userSignature:o.lock.userSignature,arm:o.arm,recoveryKind:'REFUND'};
 let nonce=0,reverted=false;
 const backend={authorize:async()=>{},plan:async()=>({resources:['evm:1:recovery:'+nonce]}),sign:(_p,plan)=>x.backend.sign(plan),inspect:(_p,s,plan)=>x.backend.inspect(s,plan),failed:async(_p,s)=>reverted?{transaction:s.transaction,block:hash('finalized-revert')}:null};
 const a=new ExchangeSigningAuthority(join(x.dir,'retry.sqlite'),{config:x.f.c,key:randomBytes(32),backend,coordinator:x.channel(),create:true}),session=a.activate();
 try{
  await assert.rejects(a.prepare(session,packet,{attempt:1}));await a.prepare(session,packet);
  nonce=1;await assert.rejects(a.prepare(session,packet,{attempt:1}),/finalized revert/);assert.equal(x.count(),1);
  reverted=true;await a.prepare(session,packet,{attempt:1});assert.equal(x.count(),2);
  await a.prepare(session,packet,{attempt:1});assert.equal(x.count(),2);await assert.rejects(a.prepare(session,packet,{attempt:3}));
 }finally{a.close();x.c.close();}
});
