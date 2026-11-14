// Candidate funding evidence for the next release. No consensus admission,
// signing or broadcast. Funding alone NEVER releases a DueByte reservation.
import assert from 'node:assert/strict';
import {digest,hex,integer,hash} from '../crypto.mjs';
import {ethereumFinality} from './exchange-finality.mjs';
import {ETHEREUM_USDC,ETHEREUM_GENESIS} from './exchange-evm-networks.mjs';
const locked='0x3223c64d0518f39e3854050c1ea77cb9f25539e39168510c5a0cc7aad992b306';
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const words=s=>{assert(typeof s==='string'&&/^0x(?:[a-f0-9]{64})+$/.test(s));return s.slice(2).match(/.{64}/g);};
const quantity=s=>{assert(typeof s==='string'&&/^0x(?:0|[1-9a-f][a-f0-9]*)$/.test(s));return BigInt(s);};
const padded=a=>a.slice(2).padStart(64,'0');

// The caller must authenticate anchor/finality separately. Exposed for an actual
// local-contract rehearsal; this lower-level result is explicitly non-authorizing.
export async function inspectEthereumEscrowFunding(rpc,e,anchor){
 const {order,escrow,codeHash,payer,recipient,amountAtomic,hashlock,createdAt,refundAt,transaction,block,now,minClaimWindowSeconds}=e;
 for(const x of [order,codeHash,hashlock,transaction,block])hex(x);
 for(const x of [escrow,payer,recipient])assert(/^0x[a-f0-9]{40}$/.test(x)&&!/^0x0{40}$/.test(x));
 assert(payer!==recipient&&escrow!==payer&&escrow!==recipient);assert(/^[1-9][0-9]{0,23}$/.test(amountAtomic));
 integer(createdAt,1);integer(now,createdAt);integer(refundAt,createdAt+1);integer(minClaimWindowSeconds,1);
 assert(minClaimWindowSeconds<=7*86400&&refundAt-now>=minClaimWindowSeconds,'Insufficient claim window');
 assert(anchor&&/^0x[a-f0-9]{64}$/.test(anchor.hash));quantity(anchor.number);
 const tx='0x'+transaction,r=await rpc('eth_getTransactionReceipt',[tx]);
 assert(r&&r.status==='0x1'&&r.transactionHash===tx&&r.blockHash==='0x'+block&&r.to===escrow&&r.from===payer);
 assert(quantity(r.blockNumber)<=quantity(anchor.number));
 const inspectState=async at=>{
  const code=await rpc('eth_getCode',[escrow,at]);assert(typeof code==='string'&&/^0x(?:[a-f0-9]{2})+$/.test(code));
  assert.equal(digest(Buffer.from(code.slice(2),'hex')),codeHash);
  assert.deepEqual(words(await rpc('eth_call',[{to:escrow,data:'0xfc0c546a'},at])),[padded(ETHEREUM_USDC)]);
  const terms=words(await rpc('eth_call',[{to:escrow,data:'0xed5e8437'+order},at]));
  assert.deepEqual(terms.slice(0,4),[padded(payer),padded(recipient),BigInt(amountAtomic).toString(16).padStart(64,'0'),hashlock]);
  assert.equal(terms.length,6);assert.equal(BigInt('0x'+terms[4]),BigInt(refundAt));assert.equal(BigInt('0x'+terms[5]),1n,'Escrow is not funded and locked');
  const balance=words(await rpc('eth_call',[{to:ETHEREUM_USDC,data:'0x70a08231'+padded(escrow)},at]));
  assert.equal(balance.length,1);assert(BigInt('0x'+balance[0])>=BigInt(amountAtomic),'Escrow balance insufficient');
 };
 await inspectState(r.blockNumber);await inspectState(anchor.number);
 const header=await rpc('eth_getBlockByNumber',[r.blockNumber,false]);assert.equal(header.hash,r.blockHash);assert.equal(header.number,r.blockNumber);
 const fundedAt=Number(quantity(header.timestamp));integer(fundedAt,createdAt);assert(fundedAt<=now&&fundedAt<refundAt);
 assert(Array.isArray(r.logs)&&r.logs.length<=128);const indices=new Set();
 for(const l of r.logs){assert.equal(l.removed,false);assert.equal(l.transactionHash,tx);assert.equal(l.blockHash,r.blockHash);assert.equal(l.blockNumber,r.blockNumber);quantity(l.logIndex);assert(!indices.has(l.logIndex));indices.add(l.logIndex);}
 const events=r.logs.filter(l=>l.address===escrow&&l.topics?.[0]===locked);assert.equal(events.length,1);assert.deepEqual(events[0].topics,[locked,'0x'+order]);assert.equal(events[0].data,'0x');
 const payments=r.logs.filter(l=>l.address===ETHEREUM_USDC&&l.topics?.[0]===transfer&&l.topics?.[2]==='0x'+padded(escrow));
 assert.equal(payments.length,1);assert.deepEqual(payments[0].topics,[transfer,'0x'+padded(payer),'0x'+padded(escrow)]);
 assert.equal(words(payments[0].data).length,1);assert.equal(BigInt(payments[0].data).toString(),amountAtomic);
 assert(quantity(payments[0].logIndex)<quantity(events[0].logIndex),'Funding event order');
 assert.equal((await rpc('eth_getBlockByNumber',[r.blockNumber,false])).hash,r.blockHash);
 assert.equal((await rpc('eth_getBlockByNumber',[anchor.number,false])).hash,anchor.hash);
 return {order,escrow,transaction,block,payer,recipient,amountAtomic,hashlock,refundAt,fundedAt,observedAt:now,stateAnchor:{number:anchor.number,hash:anchor.hash},fundingAuthorized:false,settlementAuthorized:false};
}

export async function verifyEthereumEscrowFunding(rpc,e){
 const proof=await ethereumFinality(rpc,{transaction:e.transaction,now:e.now});assert.equal(proof.block,e.block);
 const number='0x'+BigInt(proof.finalized).toString(16),header=await rpc('eth_getBlockByNumber',[number,false]);assert.equal(header.number,number);
 const anchor={number:header.number,hash:header.hash};
 const result=await inspectEthereumEscrowFunding(rpc,e,anchor);
 const repeated=await ethereumFinality(rpc,{transaction:e.transaction,now:e.now});
 for(const k of ['transaction','block','height','finalized'])assert.equal(repeated[k],proof[k],'Funding anchor changed; retry');
 assert.equal((await rpc('eth_getBlockByNumber',[number,false])).hash,anchor.hash);
 return {...result,network:'ethereum-mainnet',genesis:ETHEREUM_GENESIS,contract:ETHEREUM_USDC};
}

export async function readEthereumFundingQuorum(readers,e,{timeoutMs=20000}={}){
 assert(Array.isArray(readers)&&readers.length===3);integer(timeoutMs,10);assert(timeoutMs<=30000);
 for(const key of ['id','operator'])assert(readers.every(r=>typeof r[key]==='string'&&/^[a-z0-9-]{1,64}$/.test(r[key]))&&new Set(readers.map(r=>r[key])).size===3);
 return new Promise((resolve,reject)=>{
  let done=false,remaining=3;const abort=new AbortController(),groups=new Map();
  const finish=value=>{if(done)return;done=true;clearTimeout(timer);abort.abort();value?resolve(value):reject(Error('Ethereum funding evidence quorum unavailable'));};
  const timer=setTimeout(()=>finish(),timeoutMs);
  for(const reader of readers)Promise.resolve().then(async()=>{
   const proof=await verifyEthereumEscrowFunding((m,p)=>reader.rpc(m,p,{signal:abort.signal}),e);if(done)return;
   const {stateAnchor,...identity}=proof,key=hash(identity),group=groups.get(key)??[];
   group.push({source:reader.id,operator:reader.operator,proof});groups.set(key,group);
   if(group.length>=2)finish({kind:'ETHEREUM_FUNDING_EVIDENCE_AGREEMENT',...identity,sources:group,fundingAuthorized:false,settlementAuthorized:false});
  }).catch(()=>{}).finally(()=>{if(--remaining===0&&!done)finish();});
 });
}
