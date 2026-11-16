import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash} from '../crypto.mjs';
import {seal} from '../vault.mjs';
import {ProtectedSellerSigner,initializeSellerJournal,PERSONAL_SELLER_PROFILE} from '../research/purchase-seller-protected.mjs';
import {sellerJournalSnapshot,sealSellerRecovery,openSellerRecovery,restoreSellerRecovery} from '../research/purchase-seller-recovery.mjs';
import {protectedSellerFixture} from './helpers/protected-seller-fixture.mjs';
const password='isolated-journal-recovery-password';
function setup(){const f=protectedSellerFixture(),bundle=seal(f.seller,f.password),profile={...f.profile,domain:PERSONAL_SELLER_PROFILE,vaultKind:'personal-wallet',vaultHash:hash(bundle)},dir=fs.mkdtempSync(join(tmpdir(),'seller-recovery-')),journal=join(dir,'original.sqlite');initializeSellerJournal(journal,profile);return {...f,profile,bundle,dir,journal};}
test('personal seller recovery retains exact permits, deposit ownership, time and daily cap without a private key in backup',()=>{
 const f=setup(),s=new ProtectedSellerSigner(f),p=f.accepted(s.quote(f.request(),1000)),wire=s.prepare(p,1001);
 s.prepare(f.accepted(s.quote(f.request('USDC'),1002)),1003);s.close();
 const snapshot=sellerJournalSnapshot(f.journal,f.profile);assert(!JSON.stringify(snapshot).includes(f.seller.privateKey));assert(!JSON.stringify(snapshot).includes(f.password));
 const {bundle,checkpoint}=sealSellerRecovery(snapshot,f.profile,password),journal=join(f.dir,'restored.sqlite');
 const receipt=restoreSellerRecovery(journal,bundle,f.profile,password,checkpoint);assert(!receipt.salesEnabled&&receipt.requiresReconciliation);
 const r=new ProtectedSellerSigner({...f,journal});try{
  assert.deepEqual(r.prepare(p,1004),wire);assert.throws(()=>r.quote({...f.request(),dubytMicro:'1'},1004),/already assigned/);
  const next=f.accepted(r.quote(f.request('BTC','1',1),1004));assert.throws(()=>r.prepare(next,1005),/daily signing limit/);
  assert.throws(()=>r.quote(f.request('USDC','1',1),1003),/clock rollback/);
 }finally{r.close();}
 assert.equal(hash(sellerJournalSnapshot(f.journal,f.profile)),hash(snapshot));
});
test('wrong password, stale backup, changed profile and tampering cannot replace the latest recovery checkpoint',()=>{
 const f=setup(),old=sealSellerRecovery(sellerJournalSnapshot(f.journal,f.profile),f.profile,password),s=new ProtectedSellerSigner(f);
 s.prepare(f.accepted(s.quote(f.request(),1000)),1001);s.close();
 const fresh=sealSellerRecovery(sellerJournalSnapshot(f.journal,f.profile),f.profile,password);
 assert.throws(()=>openSellerRecovery(fresh.bundle,f.profile,'wrong-password-for-test',fresh.checkpoint));
 assert.throws(()=>openSellerRecovery(old.bundle,f.profile,password,fresh.checkpoint),/latest independent/);
 assert.throws(()=>openSellerRecovery(fresh.bundle,{...f.profile,dailyLimitMicro:'30000000'},password,fresh.checkpoint));
 assert.throws(()=>openSellerRecovery({...fresh.bundle,tag:'00'.repeat(16)},f.profile,password,fresh.checkpoint));
 const journal=join(f.dir,'must-not-exist.sqlite');assert.throws(()=>restoreSellerRecovery(journal,old.bundle,f.profile,password,fresh.checkpoint));assert(!fs.existsSync(journal));
 const before=fs.readFileSync(f.journal);assert.throws(()=>restoreSellerRecovery(f.journal,fresh.bundle,f.profile,password,fresh.checkpoint),/never overwrite/);assert.deepEqual(fs.readFileSync(f.journal),before);
});
test('snapshot validates both parties signatures and journal accounting, not just a self-declared hash',()=>{
 const f=setup(),s=new ProtectedSellerSigner(f);s.prepare(f.accepted(s.quote(f.request(),1000)),1001);s.close();
 const original=sellerJournalSnapshot(f.journal,f.profile);
 for(const mutate of [s=>s.quotes[0].request=hash('other'),s=>s.quotes[0].quote.sellerSignature='bad',s=>s.permits[0].wire.signature='bad',s=>s.permits[0].day++,s=>s.permits[0].amount='1',s=>s.quotes=[],s=>s.lastTime=999,s=>s.permits.push(s.permits[0])]){
  const bad=structuredClone(original);mutate(bad);assert.throws(()=>sealSellerRecovery(bad,f.profile,password));
 }
});
test('active signer snapshot refuses rather than racing authorizations; empty interrupted restore cannot sign',()=>{
 const f=setup(),s=new ProtectedSellerSigner(f);try{assert.throws(()=>sellerJournalSnapshot(f.journal,f.profile));}finally{s.close();}
 const empty=join(f.dir,'interrupted.sqlite');fs.writeFileSync(empty,'',{flag:'wx'});assert.throws(()=>new ProtectedSellerSigner({...f,journal:empty}));
});
