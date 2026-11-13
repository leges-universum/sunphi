import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash,sign} from '../crypto.mjs';
import {seal} from '../vault.mjs';
import {acceptance} from '../research/purchase-contract.mjs';
import {PurchaseBroker,API_DOMAIN} from '../research/purchase-api.mjs';
import {serveSecurePurchaseBroker,securePurchaseRequest} from '../research/purchase-transport.mjs';
import {ProtectedSellerSigner,initializeSellerJournal,PERSONAL_SELLER_PROFILE} from '../research/purchase-seller-protected.mjs';
import {protectedSellerFixture} from './helpers/protected-seller-fixture.mjs';
import {purchaseTlsFixture} from './helpers/purchase-tls-fixture.mjs';
test('offline personal signer pauses fresh approval but retains quote and previously accepted order',async()=>{
 const now=Math.floor(Date.now()/1000),f=protectedSellerFixture(now),dir=fs.mkdtempSync(join(tmpdir(),'personal-offline-')),bundle=seal(f.seller,f.password);
 const profile={...f.profile,domain:PERSONAL_SELLER_PROFILE,vaultKind:'personal-wallet',vaultHash:hash(bundle)},journal=join(dir,'permits.sqlite');initializeSellerJournal(journal,profile);
 const options={profile,bundle,password:f.password,journal};let signer=new ProtectedSellerSigner(options),submitted=0,prepared=0;const orders=new Map();
 const broker=new PurchaseBroker({file:join(dir,'broker.sqlite'),config:f.c,clock:()=>now,
  quote:p=>signer.quote({...p,destination:f.request(p.route).destination},now),
  prepare:command=>{const wire=signer.prepare({command,inputs:[f.input]},now);prepared++;return Buffer.from(JSON.stringify(wire));},
  submit:async(wire,id)=>{submitted++;orders.set(id,{accepted:true,id});},proof:async id=>orders.get(id)});
 const tls=purchaseTlsFixture(join(dir,'tls')),server=await serveSecurePurchaseBroker(broker,tls),transport={kind:'pinned-https-v1',url:server.url,spkiSha256:server.spkiSha256,caPem:tls.caPem};
 let nonce=0;const request=(action,payload,change={},wrongKey=false)=>{const body={domain:API_DOMAIN,configHash:hash(f.c),buyer:f.buyer.publicKey,action,payload,nonce:hash(++nonce),at:now,...change};return securePurchaseRequest(transport,{body,signature:sign(body,wrongKey?f.seller.privateKey:f.buyer.privateKey)});};
 try{
  const payload={dubytMicro:'10000000',route:'BTC',refundDestination:f.request().refundDestination};
  await assert.rejects(()=>request('quote',payload,{},true));await assert.rejects(()=>request('quote',payload,{configHash:hash('wrong chain')}));await assert.rejects(()=>request('quote',payload,{at:now-61}));await assert.rejects(()=>request('exportKey',{}));
  const q=await request('quote',payload),id=hash(q.offer),accept={id,buyerSignature:sign(acceptance(f.policy,q.offer),f.buyer.privateKey)};
  signer.close();signer=null;await assert.rejects(()=>request('accept',accept));assert.equal(submitted,0);assert.equal(prepared,0);
  assert.equal(broker.db.prepare('SELECT count(*) AS n FROM quotes').get().n,1);
  signer=new ProtectedSellerSigner(options);assert.deepEqual(await request('accept',accept),{proof:{accepted:true,id}});assert.equal(prepared,1);assert.equal(submitted,1);
  signer.close();signer=null;assert.deepEqual(await request('order',{id}),{proof:{accepted:true,id}});
  assert.deepEqual(await request('accept',accept),{proof:{accepted:true,id}});assert.equal(prepared,1);assert.equal(submitted,2);assert.equal(orders.size,1);
 }finally{signer?.close();await server.close();broker.close();}
});
