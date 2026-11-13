// Local EVM + native indexed interpreter rehearsal. Test observer signatures;
// no Ethereum mainnet/finality claim and no production admission.
import fs from 'node:fs';import assert from 'node:assert/strict';
import {hash,sign} from '../../crypto.mjs';import {origin} from '../../core.mjs';
import {resolutionFixture} from '../../test/helpers/exchange-resolution-fixture.mjs';
import {exchangeAcceptance} from '../../research/exchange-escrow.mjs';
import {EXCHANGE_V2} from '../../research/exchange-resolution.mjs';
import {inspectEthereumEscrowOutcome} from '../../research/ethereum-escrow.mjs';
import {BoundedNetworkInterpreter} from '../../research/bounded-network-interpreter.mjs';
export function nativeOrder({direction,time,amount,hashlock,payer,recipient,genesis}){
 const f=resolutionFixture(time);f.p.routes.USDC.genesis=genesis;f.p.routes.USDC.contract='0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
 const old=f.order(direction,'USDC',time),q={...old.q,policyHash:hash(f.p),externalAtomic:String(amount),hashlock,externalRefund:payer,externalRecipient:recipient,quoteUntil:time+30,dubytUntil:time+(direction==='BUY_DUBYT'?180:240),externalUntil:time+(direction==='BUY_DUBYT'?240:180)};
 const id=hash(q),lock={type:'LOCK',quote:q,providerSignature:sign(q,f.provider.privateKey),userSignature:sign(exchangeAcceptance(q),f.user.privateKey)};
 return {f,q,id,lock,payer:old.payer,input:old.input,blocks:[]};
}
function commit(n,cmd,time,inputs=[]){const block={height:n.blocks.length+1,time,blockHash:hash([time,cmd]),txs:[n.f.wire(cmd,inputs,n.payer)]};n.db.commitBlock(block,n.db.root);n.blocks.push(block);}
export function nativeArm(n,{escrow,codeHash,dir}){
 fs.mkdirSync(dir,{recursive:true});n.file=dir+'/state.sqlite';n.plan={domain:EXCHANGE_V2+'/PLAN',asset:'USDC',order:n.id,escrow,codeHash};
 n.db=BoundedNetworkInterpreter.create(n.file,origin(n.f.c),n.f.c,hash(origin(n.f.c)));
 commit(n,n.lock,n.q.createdAt,[n.input]);commit(n,n.f.arm(n.q,n.plan),n.q.createdAt);
}
export async function nativeResolve(n,rpc,expected){
 const root=n.db.root,now=Math.max(expected.now,n.q.dubytUntil+1,n.q.externalUntil+1);
 try{
  assert.throws(()=>n.db.commitBlock({height:n.blocks.length+1,time:now,blockHash:hash('timeout'),txs:[n.f.wire({type:'REFUND',id:n.id},[],n.payer)]},root));assert.equal(n.db.root,root);
  n.db.close();n.db=BoundedNetworkInterpreter.open(n.file,n.f.c,root);
  const proofs=await Promise.all([0,1].map(()=>inspectEthereumEscrowOutcome(rpc,expected)));assert.deepEqual(proofs[0],proofs[1]);const p=proofs[0];
  const body={domain:EXCHANGE_V2+'/RESOLUTION',policyHash:hash(n.f.p),order:n.id,planHash:hash(n.plan),asset:'USDC',...n.f.p.routes.USDC,escrow:n.plan.escrow+':'+n.id,status:p.kind,transaction:p.transaction,block:p.block,amountAtomic:p.amountAtomic,recipient:p.recipient,refundAddress:n.q.externalRefund,executedAt:p.executedAt,observedAt:now,expiresAt:now+120};delete body.decimals;
  const cmd={type:'RESOLVE',id:n.id,receipt:{body,signatures:n.f.observers.slice(0,2).map(k=>({observer:k.publicKey,signature:sign(body,k.privateKey)}))}};
  commit(n,cmd,now);const after=n.db.snapshotForAudit();assert.equal(after.exchangeBook.orders[n.id].status,p.kind==='PAYOUT'?'CLAIMED':'REFUNDED');assert.equal(after.money.fees,'1000');assert.equal(after.money.supply,'200000000');
  commit(n,cmd,now+1);assert.deepEqual(n.db.snapshotForAudit().money.outputs,after.money.outputs);
  const mirror=BoundedNetworkInterpreter.create(n.file+'.replay',origin(n.f.c),n.f.c,hash(origin(n.f.c)));
  try{for(const b of n.blocks)mirror.commitBlock(b,mirror.root);assert.equal(mirror.root,n.db.root);}finally{mirror.close();}
 }finally{n.db.close();}
}
