// Local EVM qualification only. Signer and transaction codec are injected.
import assert from 'node:assert/strict';
export function usdcRefundAdapter({rpc,signer,codec,pins,codeHash,maxGas=100000n,maxFeePerGas=100000000000n,maxTotalFee=10000000000000000n}){
 const {Transaction,Interface,keccak256}=codec,abi=new Interface(['function transfer(address to,uint256 value) returns (bool)']);
 assert.equal(pins.chainId,'0x7a69','local EVM only');assert(/^0x[0-9a-f]{64}$/.test(pins.genesis));assert(/^0x[0-9a-f]{40}$/.test(pins.contract));assert(/^0x[0-9a-f]{64}$/.test(codeHash));
 const sender=signer.address.toLowerCase();assert(/^0x[0-9a-f]{40}$/.test(sender));let scope=null;
 const check=async()=>{
  assert.equal(await rpc('eth_chainId'),pins.chainId,'EVM chain pin');assert.equal((await rpc('eth_getBlockByNumber',['0x0',false])).hash,pins.genesis,'EVM genesis pin');
  assert.equal(keccak256(await rpc('eth_getCode',[pins.contract,'latest'])),codeHash,'token implementation changed');
 };
 const quantity=x=>'0x'+BigInt(x).toString(16);
 function decode(raw){
  assert(scope,'bind committed refund scope first');const tx=Transaction.from('0x'+raw),i=scope.intent;
  assert(tx.isSigned()&&tx.from.toLowerCase()===sender,'refund signer');assert.equal(tx.chainId,BigInt(pins.chainId));assert.equal(tx.type,2,'bounded EIP1559 transaction required');
  assert.equal(tx.to.toLowerCase(),pins.contract);assert.equal(tx.value,0n,'refund must not send native currency');assert.equal(tx.accessList.length,0);
  const amount=BigInt(i.amountAtomic);assert(amount>0n&&amount<2n**256n);assert(/^0x[0-9a-f]{40}$/.test(i.destination)&&i.destination!==sender);
  assert.equal(tx.data,abi.encodeFunctionData('transfer',[i.destination,amount]),'exact refund recipient and amount');
  assert(tx.gasLimit>=21000n&&tx.gasLimit<=maxGas&&tx.maxFeePerGas>0n&&tx.maxFeePerGas<=maxFeePerGas&&tx.maxPriorityFeePerGas>=0n&&tx.maxPriorityFeePerGas<=tx.maxFeePerGas&&tx.gasLimit*tx.maxFeePerGas<=maxTotalFee,'refund gas/fee cap');
  return tx;
 }
 return {
  bind(value){scope=value;return this;},
  async prepare(value){this.bind(value);await check();const i=scope.intent,data=abi.encodeFunctionData('transfer',[i.destination,BigInt(i.amountAtomic)]),call={from:sender,to:pins.contract,value:'0x0',data};
   assert.equal(await rpc('eth_call',[call,'latest']),'0x'+'0'.repeat(63)+'1','token transfer must succeed');
   const estimated=BigInt(await rpc('eth_estimateGas',[call])),gasLimit=(estimated*120n+99n)/100n;assert(gasLimit<=maxGas,'refund gas cap');
   const tip=await rpc('eth_getBlockByNumber',['latest',false]),base=BigInt(tip.baseFeePerGas),priority=1000000000n,fee=base*2n+priority;
   assert(fee<=maxFeePerGas&&gasLimit*fee<=maxTotalFee,'refund fee cap');assert(BigInt(await rpc('eth_getBalance',[sender,'pending']))>=gasLimit*fee,'refund gas balance unavailable');
   const nonce=BigInt(await rpc('eth_getTransactionCount',[sender,'pending']));assert(nonce<=BigInt(Number.MAX_SAFE_INTEGER));
   const raw=(await signer.signTransaction({type:2,chainId:BigInt(pins.chainId),nonce:Number(nonce),to:pins.contract,value:0n,data,gasLimit,maxFeePerGas:fee,maxPriorityFeePerGas:priority,accessList:[]})).slice(2);
   return {raw,txid:decode(raw).hash.slice(2)};
  },
  async inspect(raw){await check();const tx=decode(raw);return {txid:tx.hash.slice(2),source:sender,destination:scope.intent.destination,amountAtomic:scope.intent.amountAtomic,network:'ethereum-local',asset:'test-usdc'};},
  async known(txid){await check();const receipt=await rpc('eth_getTransactionReceipt',['0x'+txid]);if(receipt){assert.equal(receipt.status,'0x1','refund execution failed; reconciliation required');assert.equal(receipt.transactionHash,'0x'+txid);return true;}return (await rpc('eth_getTransactionByHash',['0x'+txid]))!==null;},
  async broadcast(raw){await this.inspect(raw);const tx=decode(raw),pending=BigInt(await rpc('eth_getTransactionCount',[sender,'pending']));
   assert(pending<=BigInt(tx.nonce),'refund nonce consumed by another transaction');
   const call={from:sender,to:pins.contract,data:tx.data,value:'0x0',gas:quantity(tx.gasLimit)};
   assert.equal(await rpc('eth_call',[call,'latest']),'0x'+'0'.repeat(63)+'1','token transfer no longer succeeds');
   const sent=await rpc('eth_sendRawTransaction',['0x'+raw]);assert.equal(sent,tx.hash);return sent.slice(2);
  }
 };
}
