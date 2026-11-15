import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {hash,sign} from '../crypto.mjs';
import {acceptance} from '../research/purchase-contract.mjs';
import {sealPurchaseCustody,writePurchaseCustody} from '../research/purchase-custody.mjs';
import {RefundOutbox} from '../research/purchase-refund-worker.mjs';
import {startSellerSigner,FundedPurchaseSeller} from '../research/purchase-seller.mjs';
import {nativeFixture} from './helpers/purchase-native-fixture.mjs';

test('encrypted seller process bounds prices, buyer consent, funding and deposit pool across restart',async()=>{
 const dir=fs.mkdtempSync(join(tmpdir(),'purchase-seller-')),f=nativeFixture(Math.floor(Date.now()/1000)),password='synthetic-seller-password-only',vaultFile=join(dir,'seller.encrypted.json');
 const box=new RefundOutbox(':memory:'),outbox=box.snapshot(hash(f.c));box.close();
 writePurchaseCustody(vaultFile,sealPurchaseCustody({configHash:hash(f.c),policyHash:hash(f.policy),outbox,secrets:[{name:'seller',kind:'ed25519-private-key',data:Buffer.from(f.seller.privateKey).toString('base64')}]},password));
 const address='0x'+'11'.repeat(20),refund='0x'+'22'.repeat(20),settings={minOrderMicro:'1',maxOrderMicro:'20000000',quoteSeconds:60,paymentSeconds:600,rates:{BTC:{numerator:'1',denominator:'1000',feeAtomic:'0'},USDC:{numerator:'3',denominator:'2',feeAtomic:'0'}},usdcDestinations:[address]};
 const options={config:f.c,settings,password,vaultFile,btcDestinations:['bcrt1q'+'a'.repeat(38)]};await assert.rejects(()=>startSellerSigner({...options,password:'incorrect-seller-password'}));
 let signer=await startSellerSigner(options),s=structuredClone(f.s),used=[];
 const controller=()=>new FundedPurchaseSeller({config:f.c,signer,state:()=>s,usdcDestinations:[address],usedDestinations:()=>used,bitcoinRpc:async()=>({isvalid:false})});
 const p={buyer:f.buyer.publicKey,route:'USDC',dubytMicro:'3',refundDestination:refund};
 try{
  const q=await controller().quote(p);assert.equal(q.offer.payAtomic,'5');assert(!fs.readFileSync(vaultFile,'utf8').includes(f.seller.privateKey));
  const command={type:'RESERVE',...q,buyerSignature:sign(acceptance(f.policy,q.offer),f.buyer.privateKey)};
  const wire=await controller().prepare(command);assert.equal(JSON.parse(wire).body.action.command.offer.payAtomic,'5');
  await assert.rejects(()=>controller().prepare({...command,buyerSignature:sign(acceptance(f.policy,q.offer),f.seller.privateKey)}));
  await assert.rejects(()=>controller().quote({...p,dubytMicro:'20000001'}));
  await assert.rejects(()=>signer.quote({...p,destination:refund}));
  await assert.rejects(()=>signer.quote({...p,route:'BTC',refundDestination:'bcrt1q'+'d'.repeat(38),destination:'bcrt1q'+'e'.repeat(38)}));
  assert((await signer.quote({...p,route:'BTC',refundDestination:'bcrt1q'+'d'.repeat(38),destination:options.btcDestinations[0]})).sellerSignature);
  for(const patch of [{payAtomic:'1'},{destination:refund}]){const offer={...q.offer,...patch};await assert.rejects(()=>controller().prepare({type:'RESERVE',offer,sellerSignature:sign(offer,f.seller.privateKey),buyerSignature:sign(acceptance(f.policy,offer),f.buyer.privateKey)}));}
  await assert.rejects(()=>controller().quote({...p,route:'BTC',refundDestination:'bcrt1qinvalidchecksum'}));
  used.push(address);await assert.rejects(()=>controller().quote(p),/exhausted/);
  await signer.close();signer=await startSellerSigner(options);assert.deepEqual(await controller().prepare(command),wire);await assert.rejects(()=>controller().quote(p),/exhausted/);
  s.money.outputs={};await assert.rejects(()=>controller().prepare(command),/inventory/);
 }finally{await signer.close();}
});
