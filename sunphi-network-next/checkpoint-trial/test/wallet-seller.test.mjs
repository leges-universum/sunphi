import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {hash,keys} from '../crypto.mjs';
import {seal} from '../vault.mjs';
import {WalletSeller} from '../wallet-seller.mjs';
import {HomeSellerRelay,relayRequest} from '../research/purchase-home-relay.mjs';
import {initializeSellerJournal,PERSONAL_SELLER_PROFILE} from '../research/purchase-seller-protected.mjs';
import {protectedSellerFixture} from './helpers/protected-seller-fixture.mjs';
function fixture(){const f=protectedSellerFixture(),dir=fs.mkdtempSync(join(tmpdir(),'wallet-seller-')),bundle=seal(f.seller,f.password),profile={...f.profile,domain:PERSONAL_SELLER_PROFILE,vaultKind:'personal-wallet',vaultHash:hash(bundle)};const journal=join(dir,'permits.sqlite');initializeSellerJournal(journal,profile);return {...f,dir,bundle,profile,journal};}
const transport={kind:'pinned-https-v1',url:'https://localhost/purchase/v1',spkiSha256:'0'.repeat(64),caPem:null};
test('Home permission, paused/closed state, durable reply and relay restart preserve one signature',async()=>{
 const f=fixture();let relay=new HomeSellerRelay(join(f.dir,'relay.sqlite'),f.profile),ready=true;
 const home=new WalletSeller({...f,config:f.c,key:f.seller,transport,ready:()=>ready,request:(_t,b)=>relay.handle(b)});
 try{
  assert.equal(home.status().enabled,false);assert.throws(()=>home.start(hash('wrong')));ready=false;assert.throws(()=>home.start(hash(f.profile)));ready=true;home.start(hash(f.profile));
  const result=relay.quote(f.request());await home.tick();const q=await result;assert.equal(q.offer.seller,f.seller.publicKey);
  const command=f.accepted(q),p=relay.prepare(command);await home.tick();const wire=await p;assert.equal(wire.body.author,f.seller.publicKey);
  home.stop();assert.deepEqual(await relay.prepare(command),wire);relay.close();relay=new HomeSellerRelay(join(f.dir,'relay.sqlite'),f.profile);assert.deepEqual(await relay.prepare(command),wire);
  home.start(hash(f.profile));ready=false;await home.tick();assert.equal(home.status().enabled,false);
  await assert.rejects(()=>relay.handle(relayRequest(f.profile,keys(),'poll',{})));
  home.close();assert.equal(home.key,null);
 }finally{home.close();relay.close();}
});
test('late poll response after lock cannot sign',async()=>{
 const f=fixture();let resolve;const home=new WalletSeller({...f,config:f.c,key:f.seller,transport,ready:()=>true,request:()=>new Promise(r=>resolve=r)});
 home.start(hash(f.profile));const pending=home.tick();home.close();const payload=f.request();resolve({job:{id:hash({profile:hash(f.profile),action:'quote',payload}),action:'quote',payload}});await pending;
 assert.equal(home.status().enabled,false);
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(f.journal);assert.equal(db.prepare('SELECT count(*) AS n FROM quotes').get().n,0);db.close();
});

test('malformed relay jobs and lost verification do not create signing authorizations',async()=>{
 const f=fixture();let ready=true,reply;
 const home=new WalletSeller({...f,config:f.c,key:f.seller,transport,ready:()=>ready,request:async()=>reply});
 try{
  home.start(hash(f.profile));
  for(const action of ['sign','unlock','exportKey']){
   const payload={};reply={job:{id:hash({profile:hash(f.profile),action,payload}),action,payload}};await home.tick();
  }
  const payload=f.request();reply={job:{id:'0'.repeat(64),action:'quote',payload}};await home.tick();
  home.request=async()=>{ready=false;return {job:{id:hash({profile:hash(f.profile),action:'quote',payload}),action:'quote',payload}};};await home.tick();await home.tick();
  assert.equal(home.status().enabled,false);
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(f.journal);assert.equal(db.prepare('SELECT count(*) AS n FROM quotes').get().n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM permits').get().n,0);db.close();
 }finally{home.close();}
});

test('relay rejects altered, expired and conflicting replies; identical completion is idempotent',async()=>{
 const f=fixture(),relay=new HomeSellerRelay(join(f.dir,'relay.sqlite'),f.profile);
 try{
  const changed=relayRequest(f.profile,f.seller,'poll',{});changed.body.nonce='f'.repeat(64);await assert.rejects(()=>relay.handle(changed));
  await assert.rejects(()=>relay.handle(relayRequest(f.profile,f.seller,'poll',{},Math.floor(Date.now()/1000)-120)));
  const pending=relay.quote(f.request()),job=(await relay.handle(relayRequest(f.profile,f.seller,'poll',{}))).job;
  const result={value:{synthetic:true}},complete=relayRequest(f.profile,f.seller,'complete',{id:job.id,result});
  assert.deepEqual(await relay.handle(complete),{accepted:true});assert.deepEqual(await pending,result.value);assert.deepEqual(await relay.handle(complete),{accepted:true});
  await assert.rejects(()=>relay.handle(relayRequest(f.profile,f.seller,'complete',{id:job.id,result:{error:'different'}})));
  await assert.rejects(()=>relay.handle(relayRequest(f.profile,f.seller,'complete',{id:'0'.repeat(64),result})));
 }finally{relay.close();}
});
test('wrong wallet, production config, changed profile and missing journal cannot enable local signing',()=>{
 const f=fixture(),options={...f,config:f.c,key:f.seller,transport,ready:()=>true};
 assert.throws(()=>new WalletSeller({...options,key:keys()}));assert.throws(()=>new WalletSeller({...options,config:{chainId:'live'}}));
 const home=new WalletSeller({...options,journal:f.journal+'.absent'});assert.throws(()=>home.start(hash(f.profile)));home.close();
 const changed={...f.profile,dailyLimitMicro:'30000000'},other=new WalletSeller({...options,profile:changed});assert.throws(()=>other.start(hash(changed)));other.close();
});
