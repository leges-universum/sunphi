// Isolated rehearsal ONLY. Production must use Ethereum finalized checkpoints.
import assert from 'node:assert/strict';
import {hash,sign,verify,exact} from '../../crypto.mjs';
import {checkExchangeQuote,exchangeAcceptance} from '../../research/exchange-escrow.mjs';
import {EXCHANGE_V2,checkExchangeArm} from '../../research/exchange-resolution.mjs';
import {inspectEthereumEscrowOutcome,verifyEthereumEscrowOutcome} from '../../research/ethereum-escrow.mjs';
import {ETHEREUM_USDC,ETHEREUM_GENESIS} from '../../research/exchange-evm-networks.mjs';
export async function attestCandidate({policy,pins,rpc,request,now},key){
 const p=structuredClone(policy),r=structuredClone(request),trusted=structuredClone(pins);
 assert(p.isolated&&p.domain===EXCHANGE_V2&&p.chain.startsWith('duebyte-exchange-lab-'));
 exact(r,['kind','quote','providerSignature','userSignature','arm','transaction']);
 const q=r.quote,id=hash(q),route=p.routes.USDC,plan=r.arm.plan;
 assert.equal(q.asset,'USDC');assert.equal(route.network,'ethereum-local');
 assert.equal(route.contract,ETHEREUM_USDC);assert.notEqual(route.genesis,ETHEREUM_GENESIS);
 assert.equal(await rpc('eth_chainId',[]),'0x1');
 assert.equal((await rpc('eth_getBlockByNumber',['0x0',false])).hash,'0x'+route.genesis);
 checkExchangeQuote(p,q,q.createdAt);checkExchangeArm(q,r.arm);
 assert(verify(q,r.providerSignature,p.provider));assert(verify(exchangeAcceptance(q),r.userSignature,q.user));
 assert(p.observers.includes(key.publicKey));assert(trusted.ethereumCandidate===true);
 assert(trusted.escrows.includes(plan.escrow));assert.equal(plan.codeHash,trusted.codeHash);
 assert(Number.isSafeInteger(trusted.confirmations)&&trusted.confirmations>=2);
 const receipt=await rpc('eth_getTransactionReceipt',['0x'+r.transaction]);assert(receipt);
 const tip=await rpc('eth_getBlockByNumber',['latest',false]);
 assert(BigInt(tip.number)-BigInt(receipt.blockNumber)+1n>=BigInt(trusted.confirmations));
 const expected={order:id,escrow:plan.escrow,codeHash:plan.codeHash,payer:q.externalRefund,
  recipient:q.externalRecipient,amountAtomic:q.externalAtomic,hashlock:q.hashlock,
  createdAt:q.createdAt,refundAt:q.externalUntil,kind:r.kind,transaction:r.transaction,
  block:receipt.blockHash.slice(2),now};
 const proof=await inspectEthereumEscrowOutcome(rpc,expected);
 // Local chain ID 1 and matching token address cannot masquerade as mainnet.
 await assert.rejects(()=>verifyEthereumEscrowOutcome(rpc,expected));
 const body={domain:EXCHANGE_V2+'/RESOLUTION',policyHash:hash(p),order:id,planHash:hash(plan),
  asset:q.asset,network:route.network,genesis:route.genesis,contract:route.contract,
  escrow:plan.escrow+':'+id,status:r.kind,transaction:proof.transaction,block:proof.block,
  amountAtomic:proof.amountAtomic,recipient:proof.recipient,refundAddress:q.externalRefund,
  executedAt:proof.executedAt,observedAt:now,expiresAt:now+120};
 return {body,signature:{observer:key.publicKey,signature:sign(body,key.privateKey)}};
}
