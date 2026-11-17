// Local EVM only. Chain ID 1 is intentional; its genesis MUST fail mainnet admission.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {digest} from '../crypto.mjs';
import {ETHEREUM_USDC} from '../research/exchange-evm-networks.mjs';
import {inspectEthereumEscrowOutcome,verifyEthereumEscrowOutcome} from '../research/ethereum-escrow.mjs';
const out=process.argv[2];assert(out&&!fs.existsSync(out));
const fundingChecks=process.argv.includes('--funding'),fundingModule=fundingChecks?await import('../research/ethereum-escrow-funding.mjs'):null;
const auditChecks=process.argv.includes('--audit');
const nativeChecks=process.argv.includes('--native'),nativeModule=nativeChecks?await import('./helpers/ethereum-native-rehearsal.mjs'):null;
const require=createRequire((process.env.DUEBYTE_EVM_TOOLS??'E:/DueByte-USB/purchase-evm-tools')+'/package.json');
const ganache=require('ganache'),E=require('ethers'),solc=require('solc');
const root=path.resolve(import.meta.dirname,'..');
const input={language:'Solidity',sources:{'Escrow.sol':{content:fs.readFileSync(root+'/contracts/EthereumUSDCExchange.sol','utf8')},'Token.sol':{content:fs.readFileSync(root+'/qa/contracts/TestUSDC.sol','utf8')+'\ncontract RehearsalToken is TestUSDC { constructor() TestUSDC(msg.sender,0) {} function mint(address who,uint256 value) external onlyAdmin {balanceOf[who]+=value;totalSupply+=value;} }'}},settings:{evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}};
const compiled=JSON.parse(solc.compile(JSON.stringify(input)));assert(!compiled.errors?.some(x=>x.severity==='error'),JSON.stringify(compiled.errors));
const c=compiled.contracts['Escrow.sol'].EthereumUSDCExchange,t=compiled.contracts['Token.sol'].RehearsalToken,abi=new E.Interface(c.abi),token=new E.Interface(t.abi);
const p=ganache.provider({chain:{chainId:1,hardfork:'shanghai'},wallet:{totalAccounts:4},logging:{quiet:true}}),rpc=(method,params=[])=>p.request({method,params});
const checks=[];let serial=0,time=Math.floor(Date.now()/1000);const addresses=(await rpc('eth_accounts')).map(a=>a.toLowerCase());
async function send(w,to,data){await rpc('evm_setTime',[time*1000]);const h=await rpc('eth_sendTransaction',[{from:addresses[w],...(to?{to}:{}),data,gas:'0x5b8d80'}]);return rpc('eth_getTransactionReceipt',[h]);}
const control=(name,args)=>send(0,ETHEREUM_USDC,token.encodeFunctionData(name,args));
const balance=async who=>BigInt(await rpc('eth_call',[{to:ETHEREUM_USDC,data:token.encodeFunctionData('balanceOf',[who])},'latest']));
const action=(o,name,args=[],who=0)=>send(who,o.escrow,abi.encodeFunctionData(name,[o.id,...args]));
const status=async o=>abi.decodeFunctionResult('locks',await rpc('eth_call',[{to:o.escrow,data:abi.encodeFunctionData('locks',[o.id])},'latest']))[5];
async function order(direction='BUY_DUBYT'){
 let id=E.id('ethereum rehearsal '+serial++),until=time+120;const secret=E.id('secret '+serial),payer=direction==='BUY_DUBYT'?0:1,recipient=1-payer,amount=1234567n;
 const native=nativeChecks?nativeModule.nativeOrder({direction,time,amount,hashlock:E.sha256(secret).slice(2),payer:addresses[payer],recipient:addresses[recipient],genesis:(await rpc('eth_getBlockByNumber',['0x0',false])).hash.slice(2)}):null;
 if(native){id='0x'+native.id;until=native.q.externalUntil;}
 const r=await send(0,null,'0x'+c.evm.bytecode.object+abi.encodeDeploy([id,addresses[payer],addresses[recipient],amount,E.sha256(secret),until]).slice(2));assert.equal(r.status,'0x1');
 if(native)nativeModule.nativeArm(native,{escrow:r.contractAddress,codeHash:digest(Buffer.from((await rpc('eth_getCode',[r.contractAddress,'latest'])).slice(2),'hex')),dir:out+'/native-'+serial});
 return {id,secret,payer,recipient,until,amount,escrow:r.contractAddress,createdAt:time,native};
}
async function fund(o){
 assert.equal((await send(o.payer,ETHEREUM_USDC,token.encodeFunctionData('approve',[o.escrow,o.amount]))).status,'0x1');
 const r=await action(o,'lock',[],o.payer);assert.equal(r.status,'0x1');
 if(fundingChecks){
  o.funding={order:o.id.slice(2),escrow:o.escrow,codeHash:digest(Buffer.from((await rpc('eth_getCode',[o.escrow,'latest'])).slice(2),'hex')),payer:addresses[o.payer],recipient:addresses[o.recipient],amountAtomic:o.amount.toString(),hashlock:E.sha256(o.secret).slice(2),createdAt:o.createdAt,refundAt:o.until,transaction:r.transactionHash.slice(2),block:r.blockHash.slice(2),now:time+2,minClaimWindowSeconds:30};
  const p=await fundingModule.inspectEthereumEscrowFunding(rpc,o.funding,await rpc('eth_getBlockByNumber',['latest',false]));assert.equal(p.fundingAuthorized,false);
  await assert.rejects(()=>fundingModule.verifyEthereumEscrowFunding(rpc,o.funding));
 }
}
async function inspect(o,r,kind){const expected={order:o.id.slice(2),escrow:o.escrow,codeHash:digest(Buffer.from((await rpc('eth_getCode',[o.escrow,'latest'])).slice(2),'hex')),payer:addresses[o.payer],recipient:addresses[o.recipient],amountAtomic:o.amount.toString(),hashlock:E.sha256(o.secret).slice(2),createdAt:o.createdAt,refundAt:o.until,kind,transaction:r.transactionHash.slice(2),block:r.blockHash.slice(2),now:time+2};
 await inspectEthereumEscrowOutcome(rpc,expected);
 if(fundingChecks&&o.funding)await assert.rejects(async()=>fundingModule.inspectEthereumEscrowFunding(rpc,{...o.funding,now:time+2,minClaimWindowSeconds:1},await rpc('eth_getBlockByNumber',['latest',false])));
 await assert.rejects(()=>verifyEthereumEscrowOutcome(rpc,expected));
 for(const bad of [{codeHash:'a'.repeat(64)},{recipient:addresses[3]},{amountAtomic:'1'},{block:'b'.repeat(64)},{hashlock:'c'.repeat(64)}])await assert.rejects(()=>inspectEthereumEscrowOutcome(rpc,{...expected,...bad}));
 if(o.native)await nativeModule.nativeResolve(o.native,rpc,expected);
}
try{
 const deployment=await send(0,null,'0x'+t.evm.bytecode.object);assert.equal(deployment.status,'0x1');await rpc('evm_setAccountCode',[ETHEREUM_USDC,await rpc('eth_getCode',[deployment.contractAddress,'latest'])]);
 for(const a of addresses)assert.equal((await control('mint',[a,1000000000n])).status,'0x1');
 for(const direction of ['BUY_DUBYT','SELL_DUBYT']){
  const o=await order(direction),before=await balance(addresses[o.recipient]);await fund(o);
  assert.equal((await action(o,'claim',[E.id('wrong')],3)).status,'0x0');assert.equal((await action(o,'refund',[],3)).status,'0x0');assert.equal((await action(o,'cancelUnfunded',[],o.payer)).status,'0x0');
  const paid=await action(o,'claim',[o.secret],3);assert.equal(paid.status,'0x1');await inspect(o,paid,'PAYOUT');assert.equal(await balance(addresses[o.recipient]),before+o.amount);assert.equal(await balance(o.escrow),0n);
  assert.equal((await action(o,'claim',[o.secret],3)).status,'0x0');time=o.until;assert.equal((await action(o,'refund',[],3)).status,'0x0');checks.push(direction+': exact payout; wrong preimage, early refund and double payment refused');
  const r=await order(direction);await fund(r);const beforeRefund=await balance(addresses[r.payer]);time=r.until;
  assert.equal((await action(r,'claim',[r.secret],3)).status,'0x0');
  for(const [name,on,off]of [['setPaused',[true],[false]],['setReturnFalse',[true],[false]],['setBlocked',[addresses[r.payer],true],[addresses[r.payer],false]]]){
   await control(name,on);const failed=await action(r,'refund',[],3);assert.equal(failed.status,'0x0');assert.equal(failed.logs.length,0);assert.equal(await status(r),1n);assert.equal(await balance(r.escrow),r.amount);await control(name,off);
  }
  const returned=await action(r,'refund',[],3);assert.equal(returned.status,'0x1');await inspect(r,returned,'REFUND');assert.equal(await balance(addresses[r.payer]),beforeRefund+r.amount);assert.equal((await action(r,'refund',[],3)).status,'0x0');checks.push(direction+': exact-cutoff refund survives issuer pause/block/false return; exactly once');
 }
 const a=await order();assert.equal((await action(a,'cancelUnfunded',[],3)).status,'0x0');const cancelled=await action(a,'cancelUnfunded');assert.equal(cancelled.status,'0x1');await inspect(a,cancelled,'CANCELLED');assert.equal((await action(a,'lock')).status,'0x0');checks.push('payer cancellation prevents future funding');
 const b=await order();time=b.until;const expired=await action(b,'cancelUnfunded',[],3);assert.equal(expired.status,'0x1');await inspect(b,expired,'CANCELLED');checks.push('expired unfunded order cancelled without privileged executor');
 if(auditChecks){
  const zero=E.ZeroAddress,flag=async()=>BigInt(await rpc('eth_call',[{to:ETHEREUM_USDC,data:token.encodeFunctionData('reentrySucceeded')},'latest']));
  for(const direction of ['BUY_DUBYT','SELL_DUBYT']){
   const o=await order(direction),payerBefore=await balance(addresses[o.payer]);
   await send(o.payer,ETHEREUM_USDC,token.encodeFunctionData('approve',[o.escrow,o.amount]));
   assert.equal((await action(o,'lock',[],3)).status,'0x0');
   await control('setShortTransfer',[true]);
   assert.equal((await action(o,'lock',[],o.payer)).status,'0x0');assert.equal(await status(o),4n);assert.equal(await balance(o.escrow),0n);assert.equal(await balance(addresses[o.payer]),payerBefore);
   await control('setShortTransfer',[false]);
   await control('setReentry',[o.escrow,abi.encodeFunctionData('claim',[o.id,o.secret])]);await fund(o);assert.equal(await flag(),0n);assert.equal(await status(o),1n);
   await control('setReentry',[zero,'0x']);await control('setShortTransfer',[true]);
   const before=await balance(addresses[o.recipient]);assert.equal((await action(o,'claim',[o.secret],3)).status,'0x0');assert.equal(await status(o),1n);assert.equal(await balance(addresses[o.recipient]),before);assert.equal(await balance(o.escrow),o.amount);
   await control('setShortTransfer',[false]);await control('setReentry',[o.escrow,abi.encodeFunctionData('claim',[o.id,o.secret])]);
   const paid=await action(o,'claim',[o.secret],3);assert.equal(paid.status,'0x1');assert.equal(await flag(),0n);await inspect(o,paid,'PAYOUT');await control('setReentry',[zero,'0x']);
   const r=await order(direction);await fund(r);time=r.until;const refundBefore=await balance(addresses[r.payer]);await control('setShortTransfer',[true]);
   assert.equal((await action(r,'refund',[],3)).status,'0x0');assert.equal(await status(r),1n);assert.equal(await balance(addresses[r.payer]),refundBefore);assert.equal(await balance(r.escrow),r.amount);
   await control('setShortTransfer',[false]);await control('setReentry',[r.escrow,abi.encodeFunctionData('refund',[r.id])]);
   const returned=await action(r,'refund',[],3);assert.equal(returned.status,'0x1');assert.equal(await flag(),0n);await inspect(r,returned,'REFUND');await control('setReentry',[zero,'0x']);
   checks.push(direction+': short funding/payout/refund atomically revert; reentrancy at funding/payout/refund refused');
  }
  const o=await order(),donation=17n;await send(3,ETHEREUM_USDC,token.encodeFunctionData('transfer',[o.escrow,donation]));await fund(o);
  assert.equal((await action(o,'claim',[o.secret],3)).status,'0x1');assert.equal(await balance(o.escrow),donation);
  assert.equal((await action(o,'lock')).status,'0x0');checks.push('unsolicited tokens cannot inflate payment; surplus is unrecoverable by design');
  const args=[E.id('invalid'),addresses[0],addresses[1],1n,E.id('hash'),time+120];
  for(const [index,value]of [[0,E.ZeroHash],[1,zero],[2,addresses[0]],[3,0n],[4,E.ZeroHash],[5,time],[5,time+604801]]){
   const bad=[...args];bad[index]=value;assert.equal((await send(0,null,'0x'+c.evm.bytecode.object+abi.encodeDeploy(bad).slice(2))).status,'0x0');
  }
  checks.push('invalid parties, zero terms and deadlines at/past cutoff or beyond seven days refused');
 }
 checks.push('historical receipt, runtime hash, token, immutable terms, logs and exact transfer verified; altered evidence rejected');
 checks.push('local chain ID 1 cannot pass Ethereum genesis/finality admission');
 if(fundingChecks)checks.push('exact funding receipt and locked balance verified in both directions; spent funding cannot be reused');
 if(nativeChecks)checks.push('actual candidate contract outcomes settle indexed native state; observer outage holds, restart/replay preserves supply and prevents duplicate settlement; local finality only');
 fs.mkdirSync(out,{recursive:true});fs.writeFileSync(out+'/compiler-input.json',JSON.stringify(input));fs.writeFileSync(out+'/result.json',JSON.stringify({passed:true,checks,isolated:true,realCircleUSDC:false,mainnetDeployment:false,issuance:false,compiler:solc.version(),compilerInputHash:digest(Buffer.from(JSON.stringify(input))),creationBytecodeHash:digest(Buffer.from(c.evm.bytecode.object,'hex')),contractSourceHash:digest(Buffer.from(input.sources['Escrow.sol'].content))},null,2));console.log('PASS Ethereum contract '+checks.length+' scenario groups');
}finally{await p.disconnect();}
