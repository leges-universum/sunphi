// Exact Ethereum USDC terminal inspection. No signing, broadcast or admission.
import assert from 'node:assert/strict';
import {digest,hex,integer,hash} from '../crypto.mjs';
import {ethereumFinality} from './exchange-finality.mjs';
import {ETHEREUM_USDC,ETHEREUM_GENESIS} from './exchange-evm-networks.mjs';
const events={PAYOUT:'0x38d6042dbdae8e73a7f6afbabd3fbe0873f9f5ed3cd71294591c3908c2e65fee',REFUND:'0xfe509803c09416b28ff3d8f690c8b0c61462a892c46d5430c8fb20abe472daf0',CANCELLED:'0xbaa1eb22f2a492ba1a5fea61b8df4d27c6c8b5f3971e63bb58fa14ff72eedb70'};
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const words=s=>{assert(typeof s==='string'&&/^0x(?:[a-f0-9]{64})+$/.test(s));return s.slice(2).match(/.{64}/g);};
const address=w=>{assert(/^0{24}[a-f0-9]{40}$/.test(w));return '0x'+w.slice(24);};
const quantity=s=>{assert(typeof s==='string'&&/^0x(?:0|[1-9a-f][a-f0-9]*)$/.test(s));return BigInt(s);};

// Reusable inspection at a caller-proved block. This function alone is NOT
// finality evidence; only verifyEthereumEscrowOutcome adds the mainnet check.
export async function inspectEthereumEscrowOutcome(rpc,{order,escrow,codeHash,payer,recipient,amountAtomic,hashlock,createdAt,refundAt,kind,transaction,block,now}){
 for(const x of [order,codeHash,hashlock,transaction,block])hex(x);
 for(const x of [escrow,payer,recipient])assert(/^0x[a-f0-9]{40}$/.test(x)&&!/^0x0{40}$/.test(x));
 assert(payer!==recipient&&escrow!==payer&&escrow!==recipient);assert(/^[1-9][0-9]{0,23}$/.test(amountAtomic));
 integer(now);integer(createdAt,1);integer(refundAt,createdAt+1);assert(Object.hasOwn(events,kind));
 const tx='0x'+transaction,r=await rpc('eth_getTransactionReceipt',[tx]);assert(r&&r.status==='0x1'&&r.transactionHash===tx&&r.blockHash==='0x'+block&&r.to===escrow);quantity(r.blockNumber);
 const at=r.blockNumber,code=await rpc('eth_getCode',[escrow,at]);assert(typeof code==='string'&&/^0x(?:[a-f0-9]{2})+$/.test(code));assert.equal(digest(Buffer.from(code.slice(2),'hex')),codeHash);
 assert.equal(address(words(await rpc('eth_call',[{to:escrow,data:'0xfc0c546a'},at]))[0]),ETHEREUM_USDC);
 const terms=words(await rpc('eth_call',[{to:escrow,data:'0xed5e8437'+order},at]));assert.equal(terms.length,6);
 assert.equal(address(terms[0]),payer);assert.equal(address(terms[1]),recipient);assert.equal(BigInt('0x'+terms[2]).toString(),amountAtomic);assert.equal(terms[3],hashlock);assert.equal(BigInt('0x'+terms[4]),BigInt(refundAt));assert.equal(BigInt('0x'+terms[5]),{PAYOUT:2n,REFUND:3n,CANCELLED:5n}[kind]);
 const header=await rpc('eth_getBlockByNumber',[at,false]);assert.equal(header.hash,r.blockHash);const executedAt=Number(quantity(header.timestamp));integer(executedAt,createdAt);assert(executedAt<=now);if(kind==='REFUND')assert(executedAt>=refundAt);if(kind==='PAYOUT')assert(executedAt<refundAt);
 assert(Array.isArray(r.logs)&&r.logs.length<=128);for(const l of r.logs){assert.equal(l.removed,false);assert.equal(l.transactionHash,tx);assert.equal(l.blockHash,r.blockHash);}
 const terminal=r.logs.filter(l=>l.address===escrow&&l.topics?.length===2&&Object.values(events).includes(l.topics[0])&&l.topics[1]==='0x'+order);assert.equal(terminal.length,1);assert.equal(terminal[0].topics[0],events[kind]);
 if(kind==='PAYOUT'){const secret=words(terminal[0].data);assert.equal(secret.length,1);assert.equal(digest(Buffer.from(secret[0],'hex')),hashlock);}else assert.equal(terminal[0].data,'0x');
 const destination=kind==='PAYOUT'?recipient:payer,from='0x'+escrow.slice(2).padStart(64,'0'),to='0x'+destination.slice(2).padStart(64,'0');
 const payments=r.logs.filter(l=>l.address===ETHEREUM_USDC&&l.topics?.length===3&&l.topics[0]===transfer&&l.topics[1]===from);
 assert.equal(payments.length,kind==='CANCELLED'?0:1);if(payments.length){assert.equal(payments[0].topics[2],to);assert.equal(words(payments[0].data).length,1);assert.equal(BigInt(payments[0].data).toString(),amountAtomic);}
 assert.equal((await rpc('eth_getBlockByNumber',[at,false])).hash,r.blockHash);
 return {order,escrow,transaction,block,kind,recipient:destination,amountAtomic,executedAt};
}
export async function verifyEthereumEscrowOutcome(rpc,expected){
 const proof=await ethereumFinality(rpc,{transaction:expected.transaction,now:expected.now});
 assert.equal(proof.block,expected.block);
 const result=await inspectEthereumEscrowOutcome(rpc,expected);
 // Recheck after historical calls. A successful earlier query cannot mask reorg.
 const repeated=await ethereumFinality(rpc,{transaction:expected.transaction,now:expected.now});
 for(const k of ['transaction','block','height'])assert.equal(repeated[k],proof[k]);
 assert(BigInt(repeated.finalized)>=BigInt(proof.finalized),'finality regressed');
 return {...result,network:'ethereum-mainnet',genesis:ETHEREUM_GENESIS,contract:ETHEREUM_USDC,finalized:repeated.finalized,settlementAuthorized:false};
}

// This agreement is input to signed DueByte observations, not permission to pay.
// Each source independently checks the COMPLETE outcome; finality-only votes
// cannot be combined with a different source's unchecked transfer interpretation.
export async function readEthereumEscrowQuorum(readers,expected,{timeoutMs=20000}={}){
 assert(Array.isArray(readers)&&readers.length===3);integer(timeoutMs,10);assert(timeoutMs<=30000);
 for(const key of ['id','operator'])assert(readers.every(r=>typeof r[key]==='string'&&/^[a-z0-9-]{1,64}$/.test(r[key]))&&new Set(readers.map(r=>r[key])).size===3);
 return new Promise((resolve,reject)=>{
  let done=false,remaining=3;const abort=new AbortController(),groups=new Map();
  const finish=value=>{if(done)return;done=true;clearTimeout(timer);abort.abort();value?resolve(value):reject(Error('Ethereum escrow evidence quorum unavailable'));};
  const timer=setTimeout(()=>finish(),timeoutMs);
  for(const r of readers)Promise.resolve().then(async()=>{
   const proof=await verifyEthereumEscrowOutcome((m,p)=>r.rpc(m,p,{signal:abort.signal}),expected);if(done)return;
   const {finalized,...identity}=proof,key=hash(identity),group=groups.get(key)??[];group.push({source:r.id,operator:r.operator,proof});groups.set(key,group);
   if(group.length>=2)finish({kind:'ETHEREUM_ESCROW_EVIDENCE_AGREEMENT',...identity,sources:group,settlementAuthorized:false});
  }).catch(()=>{}).finally(()=>{if(--remaining===0&&!done)finish();});
 });
}
