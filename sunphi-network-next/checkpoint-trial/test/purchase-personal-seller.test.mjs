import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash,keys,verify} from '../crypto.mjs';
import {seal} from '../vault.mjs';
import {ProtectedSellerSigner,initializeSellerJournal,PERSONAL_SELLER_PROFILE} from '../research/purchase-seller-protected.mjs';
import {protectedSellerFixture} from './helpers/protected-seller-fixture.mjs';
function setup(){
 const f=protectedSellerFixture(),bundle=seal(f.seller,f.password),dir=fs.mkdtempSync(join(tmpdir(),'personal-seller-'));
 const profile={...f.profile,domain:PERSONAL_SELLER_PROFILE,vaultKind:'personal-wallet',vaultHash:hash(bundle)},journal=join(dir,'authorizations.sqlite');
 initializeSellerJournal(journal,profile);return {...f,profile,bundle,journal};
}
test('existing personal vault signs only pinned offers/reservations without rewriting the vault',()=>{
 const f=setup(),before=JSON.stringify(f.bundle),s=new ProtectedSellerSigner(f);
 try{
  const q=s.quote(f.request(),1000);assert.equal(q.offer.seller,f.seller.publicKey);assert(verify(q.offer,q.sellerSignature,f.seller.publicKey));
  assert(s.prepare(f.accepted(q),1001));assert.throws(()=>s.prepare({command:{type:'TRANSFER'},inputs:[f.input]},1001));
  assert.throws(()=>s.quote({...f.request('USDC'),dubytMicro:'20000001'},1001));
  assert.equal(JSON.stringify(f.bundle),before);
 }finally{s.close();}
 assert.throws(()=>s.quote(f.request('USDC'),1001));
});
test('personal seller restart preserves authorization, address ownership and daily ceiling',()=>{
 const f=setup();let s=new ProtectedSellerSigner(f);
 try{
  const p=f.accepted(s.quote(f.request(),1000)),wire=s.prepare(p,1001);s.close();s=new ProtectedSellerSigner(f);
  assert.deepEqual(s.prepare(p,1002),wire);s.prepare(f.accepted(s.quote(f.request('USDC'),1002)),1003);
  const p2=f.accepted(s.quote(f.request('BTC','1',1),1003));assert.throws(()=>s.prepare(p2,1004),/daily signing limit/);
  assert.throws(()=>s.quote({...f.request(),buyer:keys().publicKey},1004),/already assigned/);
 }finally{s.close();}
});
test('wrong personal wallet, password, vault kind and changed profile cannot authorize sales',()=>{
 const f=setup();assert.throws(()=>new ProtectedSellerSigner({...f,password:'wrong-personal-password'}));
 assert.throws(()=>new ProtectedSellerSigner({...f,profile:{...f.profile,vaultKind:'purchase-custody'}}));
 const other=seal(keys(),f.password),profile={...f.profile,vaultHash:hash(other)},journal=f.journal+'.other';initializeSellerJournal(journal,profile);
 assert.throws(()=>new ProtectedSellerSigner({...f,bundle:other,profile,journal}),/does not match pinned seller/);
 assert.throws(()=>new ProtectedSellerSigner({...f,profile:{...f.profile,dailyLimitMicro:'30000000'}}),/profile changed/);
 const s=new ProtectedSellerSigner(f);s.close();
});
