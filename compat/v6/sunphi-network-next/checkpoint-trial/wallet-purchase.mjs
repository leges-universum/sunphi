// Non-binding receive request only. No external custody, order, signature,
// deposit instruction, exchange-rate promise, balance credit or mint operation.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {exact,hash,publicKey} from './crypto.mjs';
import {parseToken,formatToken} from './token-units.mjs';
import {stateHash} from './core.mjs';
import {isBoundedWalletView,assertBoundedWalletView} from './research/bounded-wallet-view.mjs';

export function purchaseRequest(config,owner,q,{now=Date.now,nonce=()=>randomBytes(16).toString('hex')}={}){
 exact(q,['route','amount','paymentKind','currency','paymentNetwork','assetReference','counterparty']);
 assert(['direct','exchange'].includes(q.route),'Choose direct purchase or exchange.');
 assert(['fiat','crypto'].includes(q.paymentKind),'Choose money or cryptocurrency.');
 const micro=parseToken(q.amount,'1000000');assert(BigInt(micro)>0n,'Enter a positive DUBYT amount.');publicKey(owner);
 assert(typeof q.currency==='string'&&/^[A-Z0-9]{2,12}$/.test(q.currency),'Enter a currency code.');
 const text=(v,max)=>typeof v==='string'&&v.length<=max&&v===v.trim()&&!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(v);
 assert(text(q.counterparty,120),'Invalid seller or exchange name.');
 assert(q.route!=='exchange'||q.counterparty.length>0,'Name the exchange; support still needs confirmation.');
 assert(text(q.paymentNetwork,100)&&text(q.assetReference,180),'Invalid external asset description.');
 if(q.paymentKind==='fiat')assert(/^[A-Z]{3}$/.test(q.currency)&&q.paymentNetwork===''&&q.assetReference==='','Money uses a three-letter currency code without a crypto network.');
 else assert(q.paymentNetwork.length>0&&q.assetReference.length>0,'Specify the cryptocurrency network and exact asset (native or contract identifier).');
 const createdAt=Math.floor(now()/1000);assert(Number.isSafeInteger(createdAt)&&createdAt>0);
 const requestNonce=nonce();assert(/^[a-f0-9]{32}$/.test(requestNonce));
 const body={domain:'DUEBYTE_PURCHASE_REQUEST_V1',network:config.chainId,configHash:hash(config),recipient:owner,
  amountMicro:micro,unitScale:'1000000',route:q.route,paymentKind:q.paymentKind,currency:q.currency,
  paymentNetwork:q.paymentNetwork,assetReference:q.assetReference,counterparty:q.counterparty,
  createdAt,expiresAt:createdAt+86400,nonce:requestNonce};
 return {body,requestId:hash(body),displayAmount:formatToken(micro,'1000000'),status:'DRAFT_RECEIVE_REQUEST',
  counterpartyVerified:false,quote:null,externalPaymentVerified:false,submitted:false,
  exchangeOrderPlaced:false,collateralAssigned:false,issuanceAuthorized:false,
  instructions:['Confirm the seller or exchange supports this exact DueByte network before payment.',
   'Agree price, fees, payment details, delivery deadline and refund terms separately.',
   'This unsigned request proves neither identity, token availability nor external payment.',
   'A bank receipt, crypto transfer or exchange order does not credit this wallet.',
   'Only verified spendable DUBYT received on this network can fund selected nodes.']};
}

export async function verifiedPurchaseRequest(wallet,q,options){
 const {state,certificate}=await wallet.view();
 if(isBoundedWalletView(state))assertBoundedWalletView(state,certificate,wallet.client.config,wallet.key.publicKey);
 else assert.equal(stateHash(state,wallet.client.config),certificate.appHash,'Unverified purchase request network.');
 assert.equal(state.height,certificate.appHeight);
 assert.equal(state.money.unitScale,'1000000','Six-decimal network required.');
 return {...purchaseRequest(wallet.client.config,wallet.key.publicKey,q,options),verifiedHeight:certificate.appHeight};
}
