import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash,sign} from '../crypto.mjs';
import {acceptance} from '../research/purchase-contract.mjs';
import {ProtectedSellerSigner,initializeSellerJournal} from '../research/purchase-seller-protected.mjs';
import {protectedSellerFixture} from './helpers/protected-seller-fixture.mjs';
function setup(){const f=protectedSellerFixture(),dir=fs.mkdtempSync(join(tmpdir(),'protected-seller-')),journal=join(dir,'authorizations.sqlite');initializeSellerJournal(journal,f.profile);return {...f,journal};}

test('protected seller rejects deposit substitution and never reassigns a quoted address',()=>{
 const f=setup(),s=new ProtectedSellerSigner(f);try{
  for(const route of ['BTC','USDC']){
   const p=f.request(route),q=s.quote(p,1001);assert.deepEqual(s.quote(p,1001),q);
   assert.throws(()=>s.quote({...p,destination:route==='BTC'?'bcrt1q'+'e'.repeat(38):'0x'+'44'.repeat(20)},1001),/unprovisioned/);
   assert.throws(()=>s.quote({...p,dubytMicro:'2'},1001),/already assigned/);
  }
  assert.throws(()=>s.quote(f.request(),1062),/expired/);
 }finally{s.close();}
});
test('durable permits survive lost reply and restart; daily cap and input binding cannot reset',()=>{
 const f=setup();let s=new ProtectedSellerSigner(f);
 try{
  const p=f.accepted(s.quote(f.request(),1000)),wire=s.prepare(p,1001);
  s.close();s=new ProtectedSellerSigner(f);assert.deepEqual(s.prepare(p,1100),wire);
  assert.throws(()=>s.prepare({...p,inputs:[hash('other input')]},1100),/different inputs/);
  const q=f.accepted(s.quote(f.request('USDC'),1100));s.prepare(q,1101);
  const third=f.accepted(s.quote(f.request('BTC','1',1),1101));assert.throws(()=>s.prepare(third,1102),/daily signing limit/);
  assert.throws(()=>s.quote(f.request('USDC','1',1),1099),/clock rollback/);
  // Next UTC day permits fresh spending; an old signed wire is still identical.
  const next=f.accepted(s.quote(f.request('USDC','1',1),86400));s.prepare(next,86400);assert.deepEqual(s.prepare(p,86400),wire);
 }finally{s.close();}
});
test('missing journal, concurrent signer, changed policy, wrong vault and password fail closed',()=>{
 const f=setup(),s=new ProtectedSellerSigner(f);
 try{assert.throws(()=>new ProtectedSellerSigner(f));}finally{s.close();}
 assert.throws(()=>new ProtectedSellerSigner({...f,journal:f.journal+'.missing'}));
 assert.throws(()=>initializeSellerJournal(f.journal,f.profile));
 assert.throws(()=>new ProtectedSellerSigner({...f,profile:{...f.profile,dailyLimitMicro:'30000000'}}),/profile changed/);
 assert.throws(()=>new ProtectedSellerSigner({...f,bundle:{...f.bundle,tag:'00'.repeat(16)}}),/vault pin/);
 assert.throws(()=>new ProtectedSellerSigner({...f,password:'incorrect-test-password'}));
 const recovered=new ProtectedSellerSigner(f);recovered.close();
});
test('even a valid external seller signature cannot inject a quote absent from the journal',()=>{
 const f=setup(),s=new ProtectedSellerSigner(f);try{
  const q=s.quote(f.request(),1000),offer={...q.offer,payAtomic:'1',nonce:hash('injected')};
  const command={type:'RESERVE',offer,sellerSignature:sign(offer,f.seller.privateKey),buyerSignature:sign(acceptance(f.policy,offer),f.buyer.privateKey)};
  assert.throws(()=>s.prepare({command,inputs:[f.input]},1001),/not issued/);
  const bad=f.accepted(q);bad.command.buyerSignature=sign(acceptance(f.policy,q.offer),f.seller.privateKey);
  assert.throws(()=>s.prepare(bad,1001),/buyer acceptance/);
  assert(s.prepare(f.accepted(q),1001));
 }finally{s.close();}
});
