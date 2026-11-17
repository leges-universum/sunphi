// Local EVM only. Chain ID 1 is intentional; its genesis MUST fail mainnet admission.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {digest,hash} from '../crypto.mjs';
import {ETHEREUM_USDC as USDC_TOKEN,ETHEREUM_USDT,ETHEREUM_GENESIS} from '../research/exchange-evm-networks.mjs';
import {nextEthereumTokenFundingStep} from '../research/ethereum-token-funding-plan.mjs';
import * as outcomes from '../research/ethereum-escrow.mjs';
const usdt=process.argv.includes('--usdt');
// Reuse every adversarial scenario for both candidates, not just happy paths.
const ETHEREUM_USDC=usdt?ETHEREUM_USDT:USDC_TOKEN;
const inspectEthereumEscrowOutcome=usdt?outcomes.inspectEthereumUSDTEscrowOutcome:outcomes.inspectEthereumEscrowOutcome;
const verifyEthereumEscrowOutcome=usdt?outcomes.verifyEthereumUSDTEscrowOutcome:outcomes.verifyEthereumEscrowOutcome;
const out=process.argv[2];assert(out&&!fs.existsSync(out));
const fundingChecks=process.argv.includes('--funding'),funding=await import('../research/ethereum-escrow-funding.mjs');
const fundingModule=usdt?{inspectEthereumEscrowFunding:funding.inspectEthereumUSDTEscrowFunding,verifyEthereumEscrowFunding:funding.verifyEthereumUSDTEscrowFunding}:funding;
const auditChecks=process.argv.includes('--audit');
const nativeChecks=process.argv.includes('--native'),nativeModule=nativeChecks?await import('./helpers/ethereum-native-rehearsal.mjs'):null;
assert(!usdt||!nativeChecks,'USDT is not admitted by the legacy native USDC policy');
const require=createRequire((process.env.DUEBYTE_EVM_TOOLS??'E:/DueByte-USB/purchase-evm-tools')+'/package.json');
const ganache=require('ganache'),E=require('ethers'),solc=require('solc');
const root=path.resolve(import.meta.dirname,'..');
const input={language:'Solidity',sources:{'Escrow.sol':{content:fs.readFileSync(root+'/contracts/EthereumUSDCExchange.sol','utf8')},'Token.sol':{content:fs.readFileSync(root+'/qa/contracts/TestUSDC.sol','utf8')+'\ncontract RehearsalToken is TestUSDC { constructor() TestUSDC(msg.sender,0) {} function mint(address who,uint256 value) external onlyAdmin {balanceOf[who]+=value;totalSupply+=value;} }'}},settings:{evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}};
if(usdt){
 input.sources['Escrow.sol'].content=fs.readFileSync(root+'/contracts/EthereumUSDTExchange.sol','utf8');
 input.sources['Token.sol'].content=fs.readFileSync(root+'/qa/contracts/TestUSDT.sol','utf8');
 input.sources['TestUSDC.sol']={content:fs.readFileSync(root+'/qa/contracts/TestUSDC.sol','utf8')};
 // Bundle exact pinned dependencies into the saved reproducible compiler input.
 const visit=code=>{for(const m of code.matchAll(/import\s+[^;]*?from\s+"([^"]+)"\s*;/g)){
  const key=m[1];if(!key.startsWith('@openzeppelin/'))continue;
  const add=p=>{if(input.sources[p])return;const content=fs.readFileSync(root+'/node_modules/'+p,'utf8');input.sources[p]={content};
   for(const child of content.matchAll(/import\s+[^;]*?from\s+"([^"]+)"\s*;/g))add(path.posix.normalize(path.posix.join(path.posix.dirname(p),child[1])));
  };add(key);
 }};visit(input.sources['Escrow.sol'].content);
}
const compiled=JSON.parse(solc.compile(JSON.stringify(input)));assert(!compiled.errors?.some(x=>x.severity==='error'),JSON.stringify(compiled.errors));
const c=compiled.contracts['Escrow.sol'][usdt?'EthereumUSDTExchange':'EthereumUSDCExchange'],t=compiled.contracts['Token.sol'][usdt?'TestUSDT':'RehearsalToken'],abi=new E.Interface(c.abi),token=new E.Interface(t.abi);
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
 const terms={asset:usdt?'USDT':'USDC',genesis:ETHEREUM_GENESIS,token:ETHEREUM_USDC,order:o.id.slice(2),escrow:o.escrow,codeHash:digest(Buffer.from((await rpc('eth_getCode',[o.escrow,'latest'])).slice(2),'hex')),payer:addresses[o.payer],recipient:addresses[o.recipient],amountAtomic:String(o.amount),hashlock:E.sha256(o.secret).slice(2),refundAt:o.until,minClaimWindowSeconds:30,maxGasCostWei:'10000000000000000'};
 let r;
 for(let i=0;i<3;i++){
  // Planner is exercised against actual local EVM balances/allowances/nonces.
  // This is deliberately NOT an authenticated mainnet observation/admission.
  const block=await rpc('eth_getBlockByNumber',['latest',false]),allowance=await rpc('eth_call',[{to:ETHEREUM_USDC,data:token.encodeFunctionData('allowance',[addresses[o.payer],o.escrow])},'latest']);
  const observation={termsHash:hash(terms),block:block.hash.slice(2),observedAt:time,status:'UNFUNDED',allowanceAtomic:String(BigInt(allowance)),balanceAtomic:String(await balance(addresses[o.payer])),gasBalanceWei:String(BigInt(await rpc('eth_getBalance',[addresses[o.payer],'latest']))),latestNonce:String(BigInt(await rpc('eth_getTransactionCount',[addresses[o.payer],'latest']))),pendingNonce:String(BigInt(await rpc('eth_getTransactionCount',[addresses[o.payer],'pending'])))};
  const plan=nextEthereumTokenFundingStep(terms,observation,time);
  assert.equal(plan.data,plan.step==='FUND'?abi.encodeFunctionData('lock',[o.id]):token.encodeFunctionData('approve',[o.escrow,plan.step==='RESET_ALLOWANCE'?0n:o.amount]));
  r=await send(o.payer,plan.to,plan.data);assert.equal(r.status,'0x1');if(plan.step==='FUND')break;r=null;
 }
 assert(r,'funding plan did not finish within three steps');
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
  for(const direction of ['BUY_DUBYT','SELL_DUBYT']){
   const o=await order(direction),payerBefore=await balance(addresses[o.payer]);
   const noAllowance=await action(o,'lock',[],o.payer);
   assert.equal(noAllowance.status,'0x0');assert.equal(noAllowance.logs.length,0);
   assert.equal(await status(o),4n);assert.equal(await balance(addresses[o.payer]),payerBefore);
   await fund(o);const recipientBefore=await balance(addresses[o.recipient]);
   for(const [name,on,off]of [['setPaused',[true],[false]],['setReturnFalse',[true],[false]],['setBlocked',[addresses[o.recipient],true],[addresses[o.recipient],false]],['setBlocked',[o.escrow,true],[o.escrow,false]]]){
    await control(name,on);const failed=await action(o,'claim',[o.secret],3);
    assert.equal(failed.status,'0x0');assert.equal(failed.logs.length,0);assert.equal(await status(o),1n);
    assert.equal(await balance(o.escrow),o.amount);assert.equal(await balance(addresses[o.recipient]),recipientBefore);await control(name,off);
   }
   time=o.until-1;const paid=await action(o,'claim',[o.secret],3);assert.equal(paid.status,'0x1');await inspect(o,paid,'PAYOUT');
   time=o.until;assert.equal((await action(o,'refund',[],3)).status,'0x0');assert.equal(await status(o),2n);
   const expired=await order(direction);await send(expired.payer,ETHEREUM_USDC,token.encodeFunctionData('approve',[expired.escrow,expired.amount]));
   time=expired.until;assert.equal((await action(expired,'lock',[],expired.payer)).status,'0x0');assert.equal(await status(expired),4n);
   assert.equal((await action(expired,'cancelUnfunded',[],3)).status,'0x1');assert.equal(await balance(expired.escrow),0n);
   checks.push(direction+': missing allowance and blocked payout preserve state; cutoff-minus-one claim wins; exact-cutoff funding refused');
  }
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
 if(usdt){
  const o=await order();await fund(o);await control('setMalformed',[true]);
  assert.equal((await action(o,'claim',[o.secret])).status,'0x0');assert.equal(await status(o),1n);
  time=o.until;assert.equal((await action(o,'refund')).status,'0x0');assert.equal(await status(o),1n);
  await control('setMalformed',[false]);assert.equal((await action(o,'refund')).status,'0x1');
  const f=await order();await send(f.payer,ETHEREUM_USDC,token.encodeFunctionData('approve',[f.escrow,f.amount]));
  assert.equal((await send(f.payer,ETHEREUM_USDC,token.encodeFunctionData('approve',[f.escrow,f.amount]))).status,'0x0');
  await control('setMalformed',[true]);assert.equal((await action(f,'lock',[],f.payer)).status,'0x0');assert.equal(await status(f),4n);
  await control('setMalformed',[false]);assert.equal((await action(f,'lock',[],f.payer)).status,'0x1');
  checks.push('USDT no-return transfers/approval accepted; zero-first approval respected; malformed returns revert funding, payout and refund');
 }
 fs.mkdirSync(out,{recursive:true});fs.writeFileSync(out+'/compiler-input.json',JSON.stringify(input));fs.writeFileSync(out+'/result.json',JSON.stringify({passed:true,asset:usdt?'USDT':'USDC',checks,isolated:true,realIssuerToken:false,mainnetDeployment:false,issuance:false,compiler:solc.version(),compilerInputHash:digest(Buffer.from(JSON.stringify(input))),creationBytecodeHash:digest(Buffer.from(c.evm.bytecode.object,'hex')),contractSourceHash:digest(Buffer.from(input.sources['Escrow.sol'].content))},null,2));console.log('PASS Ethereum contract '+checks.length+' scenario groups');
}finally{await p.disconnect();}
