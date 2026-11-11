// Local EVM only. Chain ID 1 is intentional; its genesis MUST fail mainnet admission.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {digest} from '../crypto.mjs';
import {ETHEREUM_USDC} from '../research/exchange-evm-networks.mjs';
import {inspectEthereumEscrowOutcome,verifyEthereumEscrowOutcome} from '../research/ethereum-escrow.mjs';
const out=process.argv[2];assert(out&&!fs.existsSync(out));
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
 const id=E.id('ethereum rehearsal '+serial++),secret=E.id('secret '+serial),payer=direction==='BUY_DUBYT'?0:1,recipient=1-payer,until=time+120,amount=1234567n;
 const r=await send(0,null,'0x'+c.evm.bytecode.object+abi.encodeDeploy([id,addresses[payer],addresses[recipient],amount,E.sha256(secret),until]).slice(2));assert.equal(r.status,'0x1');
 return {id,secret,payer,recipient,until,amount,escrow:r.contractAddress,createdAt:time};
}
async function fund(o){assert.equal((await send(o.payer,ETHEREUM_USDC,token.encodeFunctionData('approve',[o.escrow,o.amount]))).status,'0x1');assert.equal((await action(o,'lock',[],o.payer)).status,'0x1');}
async function inspect(o,r,kind){const expected={order:o.id.slice(2),escrow:o.escrow,codeHash:digest(Buffer.from((await rpc('eth_getCode',[o.escrow,'latest'])).slice(2),'hex')),payer:addresses[o.payer],recipient:addresses[o.recipient],amountAtomic:o.amount.toString(),hashlock:E.sha256(o.secret).slice(2),createdAt:o.createdAt,refundAt:o.until,kind,transaction:r.transactionHash.slice(2),block:r.blockHash.slice(2),now:time+2};
 await inspectEthereumEscrowOutcome(rpc,expected);
 await assert.rejects(()=>verifyEthereumEscrowOutcome(rpc,expected));
 for(const bad of [{codeHash:'a'.repeat(64)},{recipient:addresses[3]},{amountAtomic:'1'},{block:'b'.repeat(64)},{hashlock:'c'.repeat(64)}])await assert.rejects(()=>inspectEthereumEscrowOutcome(rpc,{...expected,...bad}));
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
 checks.push('historical receipt, runtime hash, token, immutable terms, logs and exact transfer verified; altered evidence rejected');
 checks.push('local chain ID 1 cannot pass Ethereum genesis/finality admission');
 fs.mkdirSync(out,{recursive:true});fs.writeFileSync(out+'/result.json',JSON.stringify({passed:true,checks,isolated:true,realCircleUSDC:false,mainnetDeployment:false,issuance:false,contractSourceHash:digest(Buffer.from(input.sources['Escrow.sol'].content))},null,2));console.log('PASS Ethereum contract '+checks.length+' scenario groups');
}finally{await p.disconnect();}
