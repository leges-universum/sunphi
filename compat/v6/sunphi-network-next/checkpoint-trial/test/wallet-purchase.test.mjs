import test from 'node:test';import assert from 'node:assert/strict';
import {purchaseRequest,verifiedPurchaseRequest} from '../wallet-purchase.mjs';
import {keys,hash} from '../crypto.mjs';import {stateHash} from '../core.mjs';
import {issuanceFixture} from './century-issuance.test.mjs';
const owner=keys().publicKey,config={chainId:'synthetic-purchase-only'},opts={now:()=>2000000000000,nonce:()=>'a'.repeat(32)};
const q={route:'direct',amount:'0.000001',paymentKind:'fiat',currency:'USD',paymentNetwork:'',assetReference:'',counterparty:''};
test('purchase request supports direct fiat, exact crypto and named exchange without issuing or authorizing funds',()=>{
 for(const patch of [{},{paymentKind:'crypto',currency:'BTC',paymentNetwork:'Bitcoin mainnet',assetReference:'native'},{route:'exchange',counterparty:'Illustrative exchange'},{route:'exchange',counterparty:'Illustrative exchange',paymentKind:'crypto',currency:'USDC',paymentNetwork:'Example network',assetReference:'example-contract-id'}]){
  const r=purchaseRequest(config,owner,{...q,...patch},opts);assert.equal(r.body.amountMicro,'1');assert.equal(r.body.configHash,hash(config));assert.equal(r.body.recipient,owner);assert.equal(r.body.expiresAt-r.body.createdAt,86400);
  for(const key of ['submitted','exchangeOrderPlaced','externalPaymentVerified','counterpartyVerified','collateralAssigned','issuanceAuthorized'])assert.equal(r[key],false);
  assert.equal(r.quote,null);assert.equal(r.status,'DRAFT_RECEIVE_REQUEST');assert.equal(r.requestId,hash(r.body));
 }
 assert.notEqual(purchaseRequest(config,owner,q,opts).requestId,purchaseRequest({...config,chainId:'another-chain'},owner,q,opts).requestId);
 assert.notEqual(purchaseRequest(config,owner,q,opts).requestId,purchaseRequest(config,keys().publicKey,q,opts).requestId);
});
test('unquoted receipt fields, ambiguous assets, precision loss and hidden text are rejected',()=>{
 for(const patch of [{amount:'0'},{amount:'0.0000001'},{amount:'1e3'},{amount:'-1'},{amount:'1,5'},{amount:'18446744073709551616'},
  {paid:true},{recipient:keys().publicKey},{route:'bridge'},{route:'exchange'},{paymentKind:'crypto'},
  {paymentNetwork:'Bitcoin'},{assetReference:'native'},{currency:'US\nD'},{counterparty:'x\u202ey'},
  {counterparty:'a'.repeat(121)},{paymentKind:'crypto',paymentNetwork:'Example',assetReference:''}]){
  assert.throws(()=>purchaseRequest(config,owner,{...q,...patch},opts));
 }
});
test('request binds verified network and wallet; forged snapshot or wrong precision cannot prepare',async()=>{
 const x=issuanceFixture({utc:true}),s=x.s,before=hash(s),wallet={key:x.f.alice,client:{config:x.c},view:async()=>({state:s,certificate:{appHeight:s.height,appHash:stateHash(s,x.c)}})};
 const r=await verifiedPurchaseRequest(wallet,q,opts);assert.equal(r.verifiedHeight,s.height);assert.equal(r.body.recipient,x.f.alice.publicKey);assert.equal(hash(s),before);
 wallet.view=async()=>({state:s,certificate:{appHeight:s.height,appHash:hash('forged')}});await assert.rejects(verifiedPurchaseRequest(wallet,q,opts));
 s.money.unitScale='1';wallet.view=async()=>({state:s,certificate:{appHeight:s.height,appHash:stateHash(s,x.c)}});await assert.rejects(verifiedPurchaseRequest(wallet,q,opts));
});
