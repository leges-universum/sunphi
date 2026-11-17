// Full Ethereum inspection -> signed isolated DueByte resolution. Never signs
// caller-supplied evidence or treats a bare RPC-quorum result as authorization.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer,sign,verify} from '../crypto.mjs';
import {checkExchangeQuote,exchangeAcceptance} from './exchange-escrow.mjs';
import {EXCHANGE_V2,checkExchangeArm} from './exchange-resolution.mjs';
import {verifyEthereumEscrowOutcome} from './ethereum-escrow.mjs';

export async function observeEthereumExchange({policy,pins,rpc,request,now}){
 const p=structuredClone(policy),r=structuredClone(request),trusted=structuredClone(pins);
 exact(r,['kind','quote','providerSignature','userSignature','arm','transaction']);
 exact(trusted,['escrows','codeHash']);hex(trusted.codeHash);
 assert(Array.isArray(trusted.escrows)&&trusted.escrows.length>0&&trusted.escrows.length<=128);
 assert(['PAYOUT','REFUND','CANCELLED'].includes(r.kind));assert.equal(p.domain,EXCHANGE_V2);
 const q=r.quote;checkExchangeQuote(p,q,q.createdAt);assert.equal(q.asset,'USDC');
 assert.equal(p.routes.USDC.network,'ethereum-mainnet');checkExchangeArm(q,r.arm);
 assert(verify(q,r.providerSignature,p.provider),'seller quote signature');
 assert(verify(exchangeAcceptance(q),r.userSignature,q.user),'buyer acceptance');
 const plan=r.arm.plan;assert(trusted.escrows.includes(plan.escrow),'reviewed escrow required');
 assert.equal(plan.codeHash,trusted.codeHash,'reviewed runtime required');hex(r.transaction);integer(now,q.createdAt);
 const receipt=await rpc('eth_getTransactionReceipt',['0x'+r.transaction]);
 assert(receipt&&/^0x[a-f0-9]{64}$/.test(receipt.blockHash),'receipt unavailable');
 const proof=await verifyEthereumEscrowOutcome(rpc,{order:hash(q),escrow:plan.escrow,codeHash:plan.codeHash,
  payer:q.externalRefund,recipient:q.externalRecipient,amountAtomic:q.externalAtomic,hashlock:q.hashlock,
  createdAt:q.createdAt,refundAt:q.externalUntil,kind:r.kind,transaction:r.transaction,block:receipt.blockHash.slice(2),now});
 return {domain:EXCHANGE_V2+'/RESOLUTION',policyHash:hash(p),order:hash(q),planHash:hash(plan),asset:q.asset,
  network:proof.network,genesis:proof.genesis,contract:proof.contract,escrow:plan.escrow+':'+hash(q),status:proof.kind,
  transaction:proof.transaction,block:proof.block,amountAtomic:proof.amountAtomic,recipient:proof.recipient,
  refundAddress:q.externalRefund,executedAt:proof.executedAt,observedAt:now,expiresAt:now+120};
}
export async function attestEthereumExchange(args,key){
 // Snapshot before the first await; caller mutation cannot change signed terms.
 const frozen={...args,policy:structuredClone(args.policy),pins:structuredClone(args.pins),request:structuredClone(args.request)};
 const publicKey=key.publicKey,privateKey=key.privateKey;assert(frozen.policy.observers.includes(publicKey));
 const body=await observeEthereumExchange(frozen);
 return {body,signature:{observer:publicKey,signature:sign(body,privateKey)}};
}
