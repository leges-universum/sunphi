// Isolated Bitcoin/EVM chains, CometBFT and verified wallet engines.
// Single-host qualification only. All keys are disposable.
import fs from 'node:fs';import assert from 'node:assert/strict';import {join,resolve} from 'node:path';import {createRequire} from 'node:module';import {createHash,randomBytes} from 'node:crypto';
import {bitcoinLab,evmLab} from './helpers/purchase-external-networks.mjs';
import {EXCHANGE,exchangeAcceptance} from '../research/exchange-escrow.mjs';
import {bitcoinExchangeScript} from '../research/exchange-bitcoin-script.mjs';
import {keys,hash,digest,sign} from '../crypto.mjs';import {observeAsset,observePortfolio,checkAssetProfile} from '../wallet-assets.mjs';
import {exchangeFixture} from '../test/helpers/exchange-native-fixture.mjs';
import {exchangeCometWallets} from './helpers/exchange-comet-wallets.mjs';
import {bitcoinReaders,exchangeObservers} from './helpers/exchange-observers.mjs';
import {bitcoinDescriptor} from '../research/exchange-observer.mjs';
import {until} from './helpers/purchase-comet-network.mjs';
const windows=process.platform==='win32',out=resolve(process.argv[2]??'');assert(windows?out.startsWith('F:\\DueByteWork\\exchange-'):/^\/tmp\/duebyte-exchange54-[a-z0-9-]+$/.test(out));assert(!fs.existsSync(out));fs.mkdirSync(out,{recursive:true});
const tools=windows?'E:/DueByte-USB/purchase-evm-tools':'/tmp/duebyte-exchange54-tools',bitcoin=windows?'E:/DueByte-USB/purchase-native-lab-20261109/bitcoin-bin/bitcoin-32.1/bin/bitcoind.exe':tools+'/bitcoin-32.1/bin/bitcoind',require=createRequire(join(tools,'package.json')),solc=require('solc');
let btc,evm,joint,readers,watchers;const results=[],fixture=exchangeFixture(Math.floor(Date.now()/1000)-2),{provider,user,observers}=fixture;
const record=(name)=>{results.push(name);console.log('PASS '+name);};
const dsha=b=>createHash('sha256').update(createHash('sha256').update(b).digest()).digest();
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;},u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
const vector=b=>{assert(b.length<253);return Buffer.concat([Buffer.from([b.length]),b]);};
function spend({txid,index,amount,output,script,key,secret,refundAt=0}){
 const prev=Buffer.concat([Buffer.from(txid,'hex').reverse(),u32(index)]),seq=u32(0xfffffffe),dest=Buffer.concat([u64(BigInt(amount)-1000n),vector(Buffer.from(output,'hex'))]),wscript=Buffer.from(script,'hex');
 const preimage=Buffer.concat([u32(2),dsha(prev),dsha(seq),prev,vector(wscript),u64(amount),seq,dsha(dest),u32(refundAt),u32(1)]);
 const sig=new evm.ethers.SigningKey(key).sign('0x'+dsha(preimage).toString('hex'));
 const derInt=h=>{let b=Buffer.from(h.slice(2),'hex');while(b.length>1&&b[0]===0)b=b.subarray(1);if(b[0]&128)b=Buffer.concat([Buffer.from([0]),b]);return Buffer.concat([Buffer.from([2,b.length]),b]);};
 const pair=Buffer.concat([derInt(sig.r),derInt(sig.s)]),signature=Buffer.concat([Buffer.from([0x30,pair.length]),pair,Buffer.from([1])]);
 const witness=secret?[signature,Buffer.from(secret,'hex'),Buffer.from([1]),wscript]:[signature,Buffer.alloc(0),wscript];
 return Buffer.concat([u32(2),Buffer.from('000101','hex'),prev,Buffer.from([0]),seq,Buffer.from([1]),dest,Buffer.from([witness.length]),...witness.map(vector),u32(refundAt)]).toString('hex');
}
try{
 btc=await bitcoinLab(join(out,'btc'),bitcoin);
 evm=await evmLab(join(out,'evm'),tools,{replicas:2});const E=evm.ethers,token=new E.Interface(['function approve(address,uint256) returns(bool)','function setPaused(bool)','function setReturnFalse(bool)']);
 const source=fs.readFileSync(new URL('./contracts/ConditionalUSDC.sol',import.meta.url),'utf8'),compiled=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'ConditionalUSDC.sol':{content:source}},settings:{evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}})));
 assert(!compiled.errors?.some(e=>e.severity==='error'),JSON.stringify(compiled.errors));const artifact=compiled.contracts['ConditionalUSDC.sol'].ConditionalUSDC,abi=new E.Interface(artifact.abi);
 async function send(w,to,data){await evm.rpc('evm_setTime',[Date.now()]);const block=await evm.rpc('eth_getBlockByNumber',['latest',false]);const raw=await w.signTransaction({type:2,chainId:31337,nonce:Number(BigInt(await evm.rpc('eth_getTransactionCount',[w.address,'pending']))),to,data,value:0n,gasLimit:3000000n,maxFeePerGas:BigInt(block.baseFeePerGas)*2n+1000000000n,maxPriorityFeePerGas:1000000000n});return evm.receipt(await evm.rpc('eth_sendRawTransaction',[raw]));}
 const deployed=await send(evm.wallets[0],null,'0x'+artifact.evm.bytecode.object+abi.encodeDeploy([evm.pins.contract]).slice(2));assert.equal(deployed.status,'0x1');const escrow=deployed.contractAddress;
 const p=fixture.p;p.routes.BTC.genesis=btc.genesis;p.routes.USDC.genesis=evm.pins.genesis.slice(2);p.routes.USDC.contract=evm.pins.contract;
 joint=await exchangeCometWallets(join(out,'comet'),fixture);
 readers=await bitcoinReaders(join(out,'bitcoin-readers'),btc,bitcoin);
 watchers=await exchangeObservers({out:join(out,'observers'),policy:p,keys:observers,btcReaders:readers,evm,pins:{escrow,codeHash:digest(Buffer.from((await evm.rpc('eth_getCode',[escrow,'latest'])).slice(2),'hex')),confirmations:2}});
 record('ten CometBFT validators, verified Home wallet engines and three separate observers with distinct external databases');
 async function evidence(f,transaction,descriptor=null){
  await readers.sync();await evm.mine(2);await evm.assertReplicas();
  const request={kind:f.q.direction==='BUY_DUBYT'?'FUNDING':'SETTLEMENT',quote:f.q,providerSignature:sign(f.q,provider.privateKey),userSignature:sign(exchangeAcceptance(f.q),user.privateKey),transaction,descriptor};
  const bad={...request,transaction:'ff'.repeat(32)};for(const client of watchers.clients)await assert.rejects(()=>client(bad));
  const receipt=await watchers.receipt(request);assert.equal(receipt.signatures.length,f.q.asset==='BTC'&&f.q.direction==='SELL_DUBYT'?2:3);
  const command={type:'CLAIM',id:f.id,secret:f.secret,[request.kind==='FUNDING'?'funding':'settlement']:receipt};
  await until(async()=>assert(joint.net.state().money.time>=receipt.body.observedAt));
  const missing=await joint.net.rpc(0,'broadcast_tx_sync',{tx:fixture.wire({...command,[request.kind==='FUNDING'?'funding':'settlement']:{...receipt,signatures:receipt.signatures.slice(0,1)}}).toString('base64')});assert.notEqual(missing.code,0);
  return command;
 }
 function quote(direction,asset,recipient,refund){const now=joint.net.state().money.time,secret=randomBytes(32).toString('hex'),q={domain:EXCHANGE+'/QUOTE',policyHash:hash(p),chain:p.chain,nonce:randomBytes(32).toString('hex'),user:user.publicKey,provider:provider.publicKey,direction,asset,dubytAtomic:'10000001',externalAtomic:asset==='BTC'?'123456':'1234567',hashlock:digest(Buffer.from(secret,'hex')),createdAt:now,quoteUntil:now+120,dubytUntil:now+(direction==='BUY_DUBYT'?900:1800),externalUntil:now+(direction==='BUY_DUBYT'?1800:900),externalRecipient:recipient,externalRefund:refund};return {q,secret,id:hash(q),now};}
 async function lock(f){await joint.lock(f.q);}
 const externalProfile={asset:'USDC',network:'ethereum-local',address:evm.addresses[1],rpc:evm.urls[0],genesis:evm.pins.genesis.slice(2),contract:evm.pins.contract,confirmations:1};
 assert.equal((await observeAsset(externalProfile,evm.rpc)).availableAtomic,'0');record('external provider USDC starts at verified zero');
 for(const direction of ['BUY_DUBYT','SELL_DUBYT']){
  const payer=direction==='BUY_DUBYT'?0:1,recipient=1-payer,f=quote(direction,'USDC',evm.addresses[recipient],evm.addresses[payer]);
  const before=await evm.balance(evm.addresses[recipient]);if(direction==='SELL_DUBYT')await lock(f);
  assert.equal((await send(evm.wallets[payer],evm.pins.contract,token.encodeFunctionData('approve',[escrow,BigInt(f.q.externalAtomic)]))).status,'0x1');
  const funding=await send(evm.wallets[payer],escrow,abi.encodeFunctionData('lock',['0x'+f.id,f.q.externalRecipient,BigInt(f.q.externalAtomic),'0x'+f.q.hashlock,f.q.externalUntil]));assert.equal(funding.status,'0x1');
  const terms=abi.decodeFunctionResult('locks',await evm.rpc('eth_call',[{to:escrow,data:abi.encodeFunctionData('locks',['0x'+f.id])},'latest']));assert.equal(terms[0].toLowerCase(),f.q.externalRefund);assert.equal(terms[1].toLowerCase(),f.q.externalRecipient);assert.equal(terms[2],BigInt(f.q.externalAtomic));assert.equal(terms[3],'0x'+f.q.hashlock);
  if(direction==='BUY_DUBYT')await lock(f);
  assert.equal((await send(evm.wallets[3],escrow,abi.encodeFunctionData('claim',['0x'+f.id,'0x'+'ff'.repeat(32)]))).status,'0x0');
  assert.equal((await send(evm.wallets[3],escrow,abi.encodeFunctionData('refund',['0x'+f.id]))).status,'0x0');
  if(direction==='BUY_DUBYT'){

   assert.equal(terms[4],BigInt(f.q.externalUntil));assert.equal(terms[5],1n);const canonical=await evm.rpc('eth_getBlockByNumber',[funding.blockNumber,false]);assert.equal(canonical.hash,funding.blockHash);
   await joint.apply(await evidence(f,funding.transactionHash.slice(2)));
  }
  joint.reopen();await joint.net.restart(9);await evm.restart();
  const claimed=await send(evm.wallets[3],escrow,abi.encodeFunctionData('claim',['0x'+f.id,'0x'+f.secret]));assert.equal(claimed.status,'0x1');
  assert.equal(await evm.balance(evm.addresses[recipient]),before+BigInt(f.q.externalAtomic));
  if(direction==='SELL_DUBYT')await joint.apply(await evidence(f,claimed.transactionHash.slice(2)));
  assert.equal((await send(evm.wallets[3],escrow,abi.encodeFunctionData('claim',['0x'+f.id,'0x'+f.secret]))).status,'0x0');record(direction+' real EVM funding, fixed recipient, restart, claim and replay rejection');
 }
 for(const direction of ['BUY_DUBYT','SELL_DUBYT']){
  const payer=direction==='BUY_DUBYT'?btc.buyer:btc.seller,receiver=direction==='BUY_DUBYT'?btc.seller:btc.buyer,recipient=await receiver('getnewaddress'),refund=await payer('getnewaddress'),f=quote(direction,'BTC',recipient,refund),claim=E.Wallet.createRandom(),back=E.Wallet.createRandom();
  const profile={version:1,isolated:true,owner:provider.publicKey,chain:p.chain,accounts:[{asset:'BTC',network:'bitcoin-regtest',address:recipient,rpc:btc.connection.url+'/wallet/'+(direction==='BUY_DUBYT'?'seller':'buyer'),rpcCookieFile:btc.connection.cookieFile,genesis:btc.genesis,contract:'native',confirmations:2}]};checkAssetProfile(profile,provider.publicKey,p.chain);assert.equal((await observePortfolio(profile))[0].availableAtomic,'0');
  const template=bitcoinExchangeScript({network:'bitcoin-regtest',hashlock:f.q.hashlock,claimKey:E.SigningKey.computePublicKey(claim.privateKey,true).slice(2),refundKey:E.SigningKey.computePublicKey(back.privateKey,true).slice(2),refundAt:f.q.externalUntil});
  const address=(await btc.rpc('decodescript',[template.witnessScript])).segwit.address;assert(address.startsWith('bcrt1'));
  if(direction==='SELL_DUBYT')await lock(f);
  const amount=String(BigInt(f.q.externalAtomic)+1000n),txid=await payer('sendtoaddress',[address,Number(amount)/1e8]);await btc.mine(2);const index=await btc.index(txid,address),output=(await btc.rpc('validateaddress',[recipient])).scriptPubKey;
  if(direction==='BUY_DUBYT')await lock(f);
  const args={txid,index,amount,output,script:template.witnessScript,key:claim.privateKey,secret:f.secret};
  const body=bitcoinDescriptor(f.q,E.SigningKey.computePublicKey(claim.privateKey,true).slice(2),E.SigningKey.computePublicKey(back.privateKey,true).slice(2)),descriptor={body,providerSignature:sign(body,provider.privateKey),userSignature:sign(body,user.privateKey),fundingTransaction:txid,index};
  assert.equal((await btc.rpc('testmempoolaccept',[[spend({...args,secret:'ff'.repeat(32)})]]))[0].allowed,false);
  assert.equal((await btc.rpc('testmempoolaccept',[[spend({...args,key:back.privateKey,secret:null,refundAt:f.q.externalUntil})]]))[0].allowed,false);
  if(direction==='BUY_DUBYT'){

   const funded=await btc.rpc('gettxout',[txid,index,true]),transaction=await btc.rpc('getrawtransaction',[txid,true]);assert(funded&&funded.confirmations>=2);assert.equal(funded.value,Number(amount)/1e8);assert.equal(funded.scriptPubKey.hex,template.scriptPubKey);assert.equal((await btc.rpc('getblockhash',[(await btc.rpc('getblockheader',[transaction.blockhash])).height])),transaction.blockhash);
   await joint.apply(await evidence(f,txid,descriptor));
  }
  const raw=spend(args);const paid=await btc.rpc('sendrawtransaction',[raw]);await btc.mine(2);const transaction=await btc.rpc('getrawtransaction',[paid,true]);assert.equal(transaction.vout[0].value,Number(f.q.externalAtomic)/1e8);
  assert.equal((await observePortfolio(profile))[0].availableAtomic,f.q.externalAtomic);if(direction==='BUY_DUBYT'){profile.accounts.push(externalProfile);fs.writeFileSync(join(out,'external-accounts.test.json'),JSON.stringify(profile,null,2));}
  if(direction==='SELL_DUBYT'){
   const observer=watchers.children[2],exited=new Promise(r=>observer.once('exit',r));observer.kill();await exited;
   await joint.apply(await evidence(f,paid,descriptor));record('two observers settle with third offline; one signature rejected');
  }
  assert.equal((await btc.rpc('testmempoolaccept',[[raw]]))[0].allowed,false);record(direction+' real Bitcoin P2WSH, wrong secret/early refund rejected and exact net output');
 }
 // Concurrent timeout cases use real Comet UTC, not synthetic block-time jumps.
 const refunds=[];
 for(const direction of ['BUY_DUBYT','SELL_DUBYT'])for(const asset of ['USDC','BTC']){
  const qtime=joint.net.state().money.time;
  const f=quote(direction,asset,asset==='USDC'?evm.addresses[1]:await btc.seller('getnewaddress'),asset==='USDC'?evm.addresses[0]:await btc.buyer('getnewaddress'));
  f.q.quoteUntil=qtime+60;f.q.dubytUntil=qtime+(direction==='BUY_DUBYT'?240:300);f.q.externalUntil=qtime+(direction==='BUY_DUBYT'?300:240);f.id=hash(f.q);
  const payer=direction==='BUY_DUBYT'?provider:user,available=Object.entries(joint.net.state().money.outputs).filter(([,o])=>o.owner===payer.publicKey&&o.unlock<=qtime&&BigInt(o.value)>=BigInt(f.q.dubytAtomic)+1000n);
  assert(available.length);await joint.net.submit(fixture.wire({type:'LOCK',quote:f.q,providerSignature:sign(f.q,provider.privateKey),userSignature:sign(exchangeAcceptance(f.q),user.privateKey)},[available[0][0]],payer));
  if(asset==='USDC'){
   await send(evm.wallets[0],evm.pins.contract,token.encodeFunctionData('approve',[escrow,BigInt(f.q.externalAtomic)]));
   assert.equal((await send(evm.wallets[0],escrow,abi.encodeFunctionData('lock',['0x'+f.id,f.q.externalRecipient,BigInt(f.q.externalAtomic),'0x'+f.q.hashlock,f.q.externalUntil]))).status,'0x1');
   assert.equal((await send(evm.wallets[3],escrow,abi.encodeFunctionData('refund',['0x'+f.id]))).status,'0x0');
  }else{
   const claim=E.Wallet.createRandom(),back=E.Wallet.createRandom(),template=bitcoinExchangeScript({network:'bitcoin-regtest',hashlock:f.q.hashlock,claimKey:E.SigningKey.computePublicKey(claim.privateKey,true).slice(2),refundKey:E.SigningKey.computePublicKey(back.privateKey,true).slice(2),refundAt:f.q.externalUntil});
   const addr=(await btc.rpc('decodescript',[template.witnessScript])).segwit.address,amount=String(BigInt(f.q.externalAtomic)+1000n),txid=await btc.pay(addr,amount);await btc.mine(2);
   f.raw=spend({txid,index:await btc.index(txid,addr),amount,output:(await btc.rpc('validateaddress',[f.q.externalRefund])).scriptPubKey,script:template.witnessScript,key:back.privateKey,refundAt:f.q.externalUntil});
   assert.equal((await btc.rpc('testmempoolaccept',[[f.raw]]))[0].allowed,false);
  }
  const early=await joint.net.rpc(0,'broadcast_tx_sync',{tx:fixture.wire({type:'REFUND',id:f.id}).toString('base64')});assert.notEqual(early.code,0);refunds.push(f);
 }
 record('four funded timeout cases; early refunds rejected by external chains and CometBFT');
 await joint.net.stop(9);await watchers.close();
 assert(watchers.children.every(child=>!child.connected));
 record('one validator and all three observers disconnected; refunds must not depend on observers');
 const untilTime=Math.max(...refunds.map(f=>Math.max(f.q.dubytUntil,f.q.externalUntil)))+2;
 while(joint.net.state().money.time<untilTime){console.log('Waiting for consensus UTC refund window');await new Promise(r=>setTimeout(r,20000));}
 joint.net.start(9);await joint.net.restart(8);await evm.restart();
 for(const f of refunds){
  if(f.q.asset==='USDC'){
   const before=await evm.balance(f.q.externalRefund);
   assert.equal((await send(evm.wallets[3],escrow,abi.encodeFunctionData('refund',['0x'+f.id]))).status,'0x1');
   assert.equal(await evm.balance(f.q.externalRefund),before+BigInt(f.q.externalAtomic));
   assert.equal((await send(evm.wallets[3],escrow,abi.encodeFunctionData('refund',['0x'+f.id]))).status,'0x0');
  }else{
   await btc.rpc('setmocktime',[untilTime+100]);await btc.rpc('generatetoaddress',[12,f.q.externalRefund]);const txid=await btc.rpc('sendrawtransaction',[f.raw]);await btc.rpc('generatetoaddress',[2,f.q.externalRefund]);const tx=await btc.rpc('getrawtransaction',[txid,true]);assert.equal(tx.vout[0].value,Number(f.q.externalAtomic)/1e8);
  }
  const command={type:'REFUND',id:f.id};await joint.net.submit(fixture.wire(command));assert.equal(joint.net.state().exchangeBook.orders[f.id].status,'REFUNDED');
  record(f.q.direction+' '+f.q.asset+' external and native refund after UTC expiry and restart');
 }
 const finalHeight=joint.net.state().money.height;
 await until(async()=>{for(let i=0;i<10;i++)assert(Number((await joint.net.rpc(i,'status')).sync_info.latest_block_height)>finalHeight);});
 const replay=await joint.net.replay();assert.equal(replay.supply,'200000000');assert(replay.height>=finalHeight);
 const totals=await until(async()=>{const values=await joint.balances();assert.deepEqual(values,['99996000','99996000']);return values;});assert.equal(joint.net.state().money.fees,'8000');
 record('independent block replay; both verified wallets recover principal, fees charged once, unchanged synthetic supply');
 fs.writeFileSync(join(out,'result.json'),JSON.stringify({passed:true,isolated:true,productionChanged:false,issuance:false,results,replay,totals,observers:'three separate processes, three Bitcoin full nodes, three EVM databases; one host and one test coordinator',consensus:'ten CometBFT processes, shared Node application host',wallet:'packaged Wallet/VerifiedClient/WalletExchange engines, real signatures and header verification; not GUI automation',external:{bitcoinGenesis:btc.genesis,usdcContract:evm.pins.contract,escrowContract:escrow}},null,2));
}catch(error){fs.writeFileSync(join(out,'failure.json'),JSON.stringify({passed:false,message:error.message,stack:error.stack,completed:results},null,2));throw error;}
finally{await watchers?.close();await joint?.close();await readers?.close();await btc?.stop();await evm?.stop();}

