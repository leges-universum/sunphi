// Real isolated chains: paid external legs, full observer outage, late resolution.
import fs from 'node:fs';import assert from 'node:assert/strict';import {join,resolve} from 'node:path';import {createRequire} from 'node:module';
import {hash,digest,sign} from '../crypto.mjs';import {origin} from '../core.mjs';
import {exchangeAcceptance} from '../research/exchange-escrow.mjs';import {EXCHANGE_V2} from '../research/exchange-resolution.mjs';
import {bitcoinExchangeScript} from '../research/exchange-bitcoin-script.mjs';import {bitcoinSpend} from './helpers/exchange-bitcoin-spend.mjs';
import {resolutionFixture} from '../test/helpers/exchange-resolution-fixture.mjs';
import {exchangeCometWallets} from './helpers/exchange-comet-wallets.mjs';import {until} from './helpers/purchase-comet-network.mjs';
import {bitcoinLab,evmLab} from './helpers/purchase-external-networks.mjs';import {bitcoinReaders,exchangeObservers} from './helpers/exchange-observers.mjs';
import {randomBytes} from 'node:crypto';import {ExchangeRecovery} from '../research/exchange-recovery.mjs';import {recoveryAdapter} from './helpers/exchange-recovery-adapter.mjs';
import {sealRecoveryBackup,restoreRecoveryBackup,writeRecoveryBackup} from '../research/exchange-recovery-backup.mjs';
import {ExchangeSigningAuthority,fencedPreparation} from '../research/exchange-signing-authority.mjs';
import {vaultSession} from './helpers/exchange-vault-session.mjs';
const windows=process.platform==='win32',out=resolve(process.argv[2]??'');assert(windows?out.startsWith('F:\\DueByteWork\\exchange-'):/^\/tmp\/duebyte-exchange54-[a-z0-9-]+$/.test(out));assert(!fs.existsSync(out));fs.mkdirSync(out,{recursive:true});
const tools=windows?'E:/DueByte-USB/purchase-evm-tools':'/tmp/duebyte-exchange54-tools',bitcoin=windows?'E:/DueByte-USB/purchase-native-lab-20261109/bitcoin-bin/bitcoin-32.1/bin/bitcoind.exe':tools+'/bitcoin-32.1/bin/bitcoind',require=createRequire(join(tools,'package.json')),solc=require('solc');
const automatic=process.argv.includes('--automatic');let recoveryWorker,autoAdapter;
const fenced=process.argv.includes('--fenced');assert(!fenced||automatic);let signingAuthority;
const remoteSigner=process.argv.includes('--vault-service');assert(!remoteSigner||(automatic&&fenced));let vaultSigner;
const backupRecovery=process.argv.includes('--backup');assert(!backupRecovery||automatic);let earlyBackup,backupPassword;
let btc,evm,joint,readers,watchers;const f=resolutionFixture(Math.floor(Date.now()/1000)-2),results=[],orders=[];const pass=s=>{results.push(s);console.log('PASS '+s);};
try{
 btc=await bitcoinLab(join(out,'btc'),bitcoin);evm=await evmLab(join(out,'evm'),tools,{replicas:2});const E=evm.ethers;
 const source=fs.readFileSync(new URL('./contracts/RecoverableUSDC.sol',import.meta.url),'utf8'),compiled=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'RecoverableUSDC.sol':{content:source}},settings:{evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}})));assert(!compiled.errors?.some(e=>e.severity==='error'));const artifact=compiled.contracts['RecoverableUSDC.sol'].RecoverableUSDC,abi=new E.Interface(artifact.abi),token=new E.Interface(['function approve(address,uint256) returns(bool)','function setPaused(bool)']);
 async function send(w,to,data){await evm.rpc('evm_setTime',[Date.now()]);const block=await evm.rpc('eth_getBlockByNumber',['latest',false]),raw=await w.signTransaction({type:2,chainId:31337,nonce:Number(BigInt(await evm.rpc('eth_getTransactionCount',[w.address,'pending']))),to,data,value:0n,gasLimit:3000000n,maxFeePerGas:BigInt(block.baseFeePerGas)*2n+1000000000n,maxPriorityFeePerGas:1000000000n});return evm.receipt(await evm.rpc('eth_sendRawTransaction',[raw]));}
 const escrows=[];let codeHash;
 await evm.pay(evm.addresses[1],'20000000');
 // Funding plans reserve distinct inputs before any transaction is broadcast.
 for(const wallet of [btc.buyer,btc.seller]){const destinations={};for(let i=0;i<4;i++)destinations[await wallet('getnewaddress')]=0.1;await wallet('sendmany',['',destinations]);await btc.mine(2);}
 f.p.routes.BTC.genesis=btc.genesis;f.p.routes.USDC.genesis=evm.pins.genesis.slice(2);f.p.routes.USDC.contract=evm.pins.contract;
 f.c.initial.outputs={};for(const who of ['provider','user'])for(let i=0;i<6;i++)f.c.initial.outputs[hash([who,i])]={owner:f[who].publicKey,value:'20000000',unlock:0};f.c.initial.supply='240000000';f.s=origin(f.c);
 joint=await exchangeCometWallets(join(out,'comet'),f);readers=await bitcoinReaders(join(out,'readers'),btc,bitcoin);
 let generation=0;const startObservers=async()=>exchangeObservers({out:join(out,'observers-'+generation++),policy:f.p,keys:f.observers,btcReaders:readers,evm,pins:{escrows,codeHash,confirmations:2}});
 pass('ten real CometBFT validators with isolated V2 policy');
 const now=joint.net.state().money.time;let count={provider:0,user:0};
 for(const direction of ['BUY_DUBYT','SELL_DUBYT'])for(const asset of ['USDC','BTC'])for(const outcome of ['PAYOUT','REFUND','CANCELLED']){
  const o=f.order(direction,asset,now),payer=direction==='BUY_DUBYT'?0:1,receiver=1-payer;
  o.q.externalAtomic=asset==='BTC'?'123456':'1234567';o.q.quoteUntil=now+60;o.q.dubytUntil=now+(direction==='BUY_DUBYT'?240:300);o.q.externalUntil=now+(direction==='BUY_DUBYT'?300:240);
  o.q.externalRecipient=asset==='USDC'?evm.addresses[receiver]:await (receiver?btc.seller:btc.buyer)('getnewaddress');o.q.externalRefund=asset==='USDC'?evm.addresses[payer]:await (payer?btc.seller:btc.buyer)('getnewaddress');o.id=hash(o.q);o.outcome=outcome;o.externalPayer=payer;
  o.lock={type:'LOCK',quote:o.q,providerSignature:sign(o.q,f.provider.privateKey),userSignature:sign(exchangeAcceptance(o.q),f.user.privateKey)};
  o.plan={domain:EXCHANGE_V2+'/PLAN',order:o.id,asset};
  if(asset==='USDC'){
   const deployment=await send(evm.wallets[0],null,'0x'+artifact.evm.bytecode.object+abi.encodeDeploy([evm.pins.contract,'0x'+o.id,o.q.externalRefund,o.q.externalRecipient,BigInt(o.q.externalAtomic),'0x'+o.q.hashlock,o.q.externalUntil]).slice(2));assert.equal(deployment.status,'0x1');const escrow=deployment.contractAddress,actualHash=digest(Buffer.from((await evm.rpc('eth_getCode',[escrow,'latest'])).slice(2),'hex'));if(codeHash)assert.equal(actualHash,codeHash);else codeHash=actualHash;escrows.push(escrow);Object.assign(o.plan,{escrow,codeHash});
   const terms=abi.decodeFunctionResult('locks',await evm.rpc('eth_call',[{to:escrow,data:abi.encodeFunctionData('locks',['0x'+o.id])},'latest']));assert.equal(terms[5],4n);assert.equal(terms[2],BigInt(o.q.externalAtomic));
  }
  else{
   const claim=E.Wallet.createRandom(),back=E.Wallet.createRandom(),claimKey=E.SigningKey.computePublicKey(claim.privateKey,true).slice(2),refundKey=E.SigningKey.computePublicKey(back.privateKey,true).slice(2),template=bitcoinExchangeScript({network:'bitcoin-regtest',hashlock:o.q.hashlock,claimKey,refundKey,refundAt:o.q.externalUntil}),address=(await btc.rpc('decodescript',[template.witnessScript])).segwit.address,amount=String(BigInt(o.q.externalAtomic)+1000n),wallet=payer?btc.seller:btc.buyer;
   const raw=await btc.rpc('createrawtransaction',[[],{[address]:Number(amount)/1e8}]),funded=await wallet('fundrawtransaction',[raw,{lockUnspents:true}]),signed=await wallet('signrawtransactionwithwallet',[funded.hex]);assert(signed.complete);const decoded=await btc.rpc('decoderawtransaction',[signed.hex]),index=decoded.vout.find(v=>v.scriptPubKey.address===address).n;o.fundingRaw=signed.hex;
   Object.assign(o.plan,{fundingTransaction:decoded.txid,index,claimKey,refundKey,feeAtomic:'1000'});
   o.claimRaw=bitcoinSpend(E,{txid:decoded.txid,index,amount,output:(await btc.rpc('validateaddress',[o.q.externalRecipient])).scriptPubKey,script:template.witnessScript,key:claim.privateKey,secret:o.secret});
   o.refundRaw=bitcoinSpend(E,{txid:decoded.txid,index,amount,output:(await btc.rpc('validateaddress',[o.q.externalRefund])).scriptPubKey,script:template.witnessScript,key:back.privateKey,refundAt:o.q.externalUntil});
   if(remoteSigner)o.refundKey=back.privateKey;
   if(outcome==='CANCELLED'){
    let inputTotal=0n;for(const v of decoded.vin){const prev=await btc.rpc('gettxout',[v.txid,v.vout]);assert(prev);inputTotal+=BigInt(Math.round(prev.value*1e8));}
    const cancel=await wallet('signrawtransactionwithwallet',[await btc.rpc('createrawtransaction',[decoded.vin.map(v=>({txid:v.txid,vout:v.vout})),{[o.q.externalRefund]:Number(inputTotal-2000n)/1e8}])]);assert(cancel.complete);o.cancelRaw=cancel.hex;
   }
  }
  o.arm=f.arm(o.q,o.plan);const who=direction==='BUY_DUBYT'?'provider':'user';o.input=hash([who,count[who]++]);orders.push(o);
 }
 watchers=await startObservers();
 // Recover the cancellation packet from disk before using it. Disposable lab keys only.
 const recovery=join(out,'unfunded-recovery.json');fs.writeFileSync(recovery,JSON.stringify(orders.filter(o=>o.outcome==='CANCELLED').map(o=>({id:o.id,fundingRaw:o.fundingRaw,cancelRaw:o.cancelRaw,plan:o.plan}))));
 for(const item of JSON.parse(fs.readFileSync(recovery))){const o=orders.find(x=>x.id===item.id);assert.deepEqual(item.plan,o.plan);if(o.q.asset==='BTC'){o.fundingRaw=item.fundingRaw;o.cancelRaw=item.cancelRaw;}}
 await Promise.all(orders.map(o=>joint.net.submit(f.wire(o.lock,[o.input],o.payer))));await Promise.all(orders.map(o=>joint.net.submit(f.wire(o.arm))));
 const recoveryKey=automatic?randomBytes(32):null,recoveryFile=join(out,'exchange-recovery.sqlite');
 if(automatic){recoveryWorker=new ExchangeRecovery(recoveryFile,{config:f.c,key:recoveryKey});for(const o of orders)recoveryWorker.enqueue({quote:o.q,providerSignature:o.lock.providerSignature,userSignature:o.lock.userSignature,arm:o.arm,recoveryKind:o.outcome==='PAYOUT'?'OBSERVE':o.outcome});}
 if(backupRecovery){backupPassword=randomBytes(32).toString('hex');earlyBackup=sealRecoveryBackup(recoveryWorker,backupPassword);writeRecoveryBackup(join(out,'early-recovery.enc.json'),earlyBackup);}
 for(const o of orders){assert.deepEqual(joint.net.state().exchangeBook.orders[o.id].plan,o.plan);if(o.outcome==='CANCELLED')continue;if(o.q.asset==='USDC'){
   assert.equal((await send(evm.wallets[o.externalPayer],evm.pins.contract,token.encodeFunctionData('approve',[o.plan.escrow,BigInt(o.q.externalAtomic)]))).status,'0x1');assert.equal((await send(evm.wallets[o.externalPayer],o.plan.escrow,abi.encodeFunctionData('lock',['0x'+o.id]))).status,'0x1');
   assert.equal((await send(evm.wallets[o.externalPayer],o.plan.escrow,abi.encodeFunctionData('cancelUnfunded',['0x'+o.id]))).status,'0x0');
  }else{assert.equal(await btc.rpc('sendrawtransaction',[o.fundingRaw]),o.plan.fundingTransaction);await btc.mine(2);}
 }
 pass('twelve exact plans armed; four never funded; funded USDC cannot be cancelled');
 // A failing external transfer can expose the secret without paying anyone.
 const paused=orders.find(o=>o.q.asset==='USDC'&&o.outcome==='PAYOUT');await send(evm.wallets[0],evm.pins.contract,token.encodeFunctionData('setPaused',[true]));const failed=await send(evm.wallets[3],paused.plan.escrow,abi.encodeFunctionData('claim',['0x'+paused.id,'0x'+paused.secret]));assert.equal(failed.status,'0x0');await send(evm.wallets[0],evm.pins.contract,token.encodeFunctionData('setPaused',[false]));
 const request=(o,transaction,kind=o.outcome)=>({kind,quote:o.q,providerSignature:o.lock.providerSignature,userSignature:o.lock.userSignature,arm:o.arm,transaction,...(kind==='CANCELLED'&&o.q.asset==='BTC'?{fundingRaw:o.fundingRaw}:{})});
 await evm.mine(2);await readers.sync();for(const client of watchers.clients)await assert.rejects(()=>client(request(paused,failed.transactionHash.slice(2))));pass('all observers reject a reverted USDC transfer despite the revealed secret');
 for(const o of orders.filter(o=>o.outcome==='PAYOUT')){
  if(o.q.asset==='USDC'){const before=await evm.balance(o.q.externalRecipient),r=await send(evm.wallets[3],o.plan.escrow,abi.encodeFunctionData('claim',['0x'+o.id,'0x'+o.secret]));assert.equal(r.status,'0x1');assert.equal(await evm.balance(o.q.externalRecipient),before+BigInt(o.q.externalAtomic));o.transaction=r.transactionHash.slice(2);}
  else{o.transaction=await btc.rpc('sendrawtransaction',[o.claimRaw]);await btc.mine(2);assert.equal((await btc.rpc('getrawtransaction',[o.transaction,true])).vout[0].value,Number(o.q.externalAtomic)/1e8);}
 }
 // Do not deliver any successful terminal attestations before the outage.
 await watchers.close();assert(watchers.children.every(c=>!c.connected));await joint.net.stop(9);pass('four external payouts completed; all three observers stopped before native settlement');
 for(const o of orders.filter(o=>!automatic&&o.outcome==='CANCELLED')){
  if(o.q.asset==='USDC'){
   assert.equal((await send(evm.wallets[3],o.plan.escrow,abi.encodeFunctionData('cancelUnfunded',['0x'+o.id]))).status,'0x0','stranger cannot cancel early');
   const before=await evm.balance(o.q.externalRefund),r=await send(evm.wallets[o.externalPayer],o.plan.escrow,abi.encodeFunctionData('cancelUnfunded',['0x'+o.id]));assert.equal(r.status,'0x1');o.transaction=r.transactionHash.slice(2);assert.equal(await evm.balance(o.q.externalRefund),before);
   await send(evm.wallets[o.externalPayer],evm.pins.contract,token.encodeFunctionData('approve',[o.plan.escrow,BigInt(o.q.externalAtomic)]));assert.equal((await send(evm.wallets[o.externalPayer],o.plan.escrow,abi.encodeFunctionData('lock',['0x'+o.id]))).status,'0x0');assert.equal((await send(evm.wallets[3],o.plan.escrow,abi.encodeFunctionData('claim',['0x'+o.id,'0x'+o.secret]))).status,'0x0');
  }else{o.transaction=await btc.rpc('sendrawtransaction',[o.cancelRaw]);await btc.mine(2);await assert.rejects(()=>btc.rpc('sendrawtransaction',[o.fundingRaw]));}
 }
 if(!automatic)pass('four permanent unfunded cancellations while all observers offline; late funding and claims rejected');
 const deadline=Math.max(...orders.map(o=>Math.max(o.q.externalUntil,o.q.dubytUntil)))+2;
 const deadlineWait=Date.now()+420000;
 while(joint.net.state().money.time<deadline){assert(Date.now()<deadlineWait,'consensus UTC stalled');console.log('Waiting for real consensus UTC; external results withheld');await new Promise(r=>setTimeout(r,15000));}
 for(const o of orders){const rejected=await joint.net.rpc(0,'broadcast_tx_sync',{tx:f.wire({type:'REFUND',id:o.id}).toString('base64')});assert.notEqual(rejected.code,0);assert.equal(joint.net.state().exchangeBook.orders[o.id].status,'LOCKED');}
 assert.equal(joint.net.state().exchangeBook.total,String(12n*10000001n));pass('all expired native timeout refunds rejected; paid and unpaid orders remain backed');
 joint.net.start(9);await joint.net.restart(8);joint.reopen();await evm.restart();
 for(const o of orders.filter(o=>!automatic&&o.outcome==='REFUND')){
  if(o.q.asset==='USDC'){const before=await evm.balance(o.q.externalRefund),r=await send(evm.wallets[3],o.plan.escrow,abi.encodeFunctionData('refund',['0x'+o.id]));assert.equal(r.status,'0x1');assert.equal(await evm.balance(o.q.externalRefund),before+BigInt(o.q.externalAtomic));o.transaction=r.transactionHash.slice(2);}
  else{await btc.rpc('setmocktime',[Math.floor(Date.now()/1000)]);await btc.rpc('generatetoaddress',[12,o.q.externalRefund]);o.transaction=await btc.rpc('sendrawtransaction',[o.refundRaw]);await btc.mine(2);assert.equal((await btc.rpc('getrawtransaction',[o.transaction,true])).vout[0].value,Number(o.q.externalAtomic)/1e8);}
 }
 if(automatic){
  autoAdapter=recoveryAdapter({f,orders,joint,btc,evm,abi,watchers:()=>watchers,request});
  if(remoteSigner){vaultSigner=await vaultSession({out,f,orders,joint,btc,evm,abi,tools});autoAdapter.prepare=vaultSigner.prepare;Object.defineProperty(autoAdapter.calls,'prepared',{enumerable:true,get:()=>vaultSigner.preparations});pass('encrypted vault opened inside separate mTLS signer with independent native header verification');}
  else if(fenced){const backend=Object.fromEntries(['authorize','plan','sign','failed'].map(k=>[k,autoAdapter[k].bind(autoAdapter)]));backend.inspect=autoAdapter.inspectPlan.bind(autoAdapter);signingAuthority=new ExchangeSigningAuthority(join(out,'authority.sqlite'),{config:f.c,key:randomBytes(32),backend,create:true});autoAdapter.prepare=fencedPreparation(signingAuthority,signingAuthority.activate());}
  // Simulate an ambiguous response AFTER external commit. The saved transaction
  // must survive reopening; no second preparation is permitted for that order.
  const broadcast=autoAdapter.broadcast;let lost=true;autoAdapter.broadcast=async(...args)=>{const id=await broadcast(...args);if(lost){lost=false;throw Error('injected response loss');}return id;};
  await recoveryWorker.tick(autoAdapter);
  if(remoteSigner){await until(async()=>{if(autoAdapter.calls.prepared<8)await recoveryWorker.tick(autoAdapter);assert.equal(autoAdapter.calls.prepared,8);},60000);await vaultSigner.restart();pass('separate vault signer restarted after eight preparations while observers remain offline');}
  if(backupRecovery){const b=sealRecoveryBackup(recoveryWorker,backupPassword);writeRecoveryBackup(join(out,'current-recovery.enc.json'),b);recoveryWorker.close();recoveryKey.fill(0);recoveryWorker=restoreRecoveryBackup(JSON.parse(fs.readFileSync(join(out,'current-recovery.enc.json'))),{password:backupPassword,file:join(out,'restored-recovery.sqlite'),config:f.c,key:randomBytes(32)});
   const stale=restoreRecoveryBackup(earlyBackup,{password:backupPassword,file:join(out,'stale-recovery.sqlite'),config:f.c,key:randomBytes(32)});try{await stale.tick(autoAdapter);assert.equal(autoAdapter.calls.prepared,8);assert.equal(autoAdapter.calls.broadcast,8);assert.equal(autoAdapter.calls.submitted,0);assert(stale.status().every(r=>r.status!=='COMPLETE'));}finally{stale.close();}
   pass('current and stale encrypted backups restore without original journal key; observers offline cannot settle or sign again');
  }else{recoveryWorker.close();recoveryWorker=new ExchangeRecovery(recoveryFile,{config:f.c,key:recoveryKey});}
  await recoveryWorker.tick(autoAdapter);assert.equal(autoAdapter.calls.prepared,8);assert.equal(autoAdapter.calls.broadcast,8);assert.equal(autoAdapter.calls.submitted,0);
  assert.equal(joint.net.state().exchangeBook.total,String(12n*10000001n));
  pass('autonomous refunds/cancellations persisted before broadcast; lost response and journal reopen do not pay twice');
 }else pass('four actual external refunds while observers remain offline; native escrow still held');
 await readers.sync();await evm.mine(2);await evm.assertReplicas();await until(async()=>{assert(Math.floor(Date.now()/10000)*10>=Math.floor(Date.now()/1000)-2);},20000);watchers=await startObservers();
 const commands=[];
 if(automatic){
  // The worker persists observations until consensus time reaches their fixed
  // timestamp; do not wait for a continuously moving wall-clock target here.
  // Twelve sequential native confirmations at ten seconds need more than two
  // minutes, including the final consensus read that marks jobs COMPLETE.
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),240000);
  let previousSummary='';
  try{await recoveryWorker.run(autoAdapter,{signal:controller.signal,intervalMs:1000,onCycle:()=>{const states=recoveryWorker.status(),summary=JSON.stringify(states.reduce((a,r)=>(a[r.status]=(a[r.status]??0)+1,a),{}));if(summary!==previousSummary){console.log('Recovery states '+summary);previousSummary=summary;}if(states.every(r=>r.status==='COMPLETE'))controller.abort();}});}finally{clearTimeout(timeout);}
  assert(recoveryWorker.status().every(r=>r.status==='COMPLETE'),'autonomous native resolution complete');
  pass('periodic recovery resolves all twelve outcomes after observers return');
  if(backupRecovery){const stale=restoreRecoveryBackup(earlyBackup,{password:backupPassword,file:join(out,'late-restored-recovery.sqlite'),config:f.c,key:randomBytes(32)});try{const before={...autoAdapter.calls};await stale.tick(autoAdapter);assert(stale.status().every(r=>r.status==='COMPLETE'));assert.deepEqual(autoAdapter.calls,before);}finally{stale.close();}pass('old pre-broadcast backup reconciles twelve completed native orders without external payment or duplicate submission');}
 }
 for(const o of orders){if(automatic){const external=await autoAdapter.discover({quote:o.q});o.transaction=external.transaction;}const receipt=await watchers.receipt(request(o,o.transaction));assert(receipt.signatures.length>=2);commands.push({type:'RESOLVE',id:o.id,receipt});}
 await until(async()=>assert(joint.net.state().money.time>=Math.max(...commands.map(c=>c.receipt.body.observedAt))));
 for(const c of commands){const bad={...c,receipt:{...c.receipt,signatures:c.receipt.signatures.slice(0,1)}};assert.notEqual((await joint.net.rpc(0,'broadcast_tx_sync',{tx:f.wire(bad).toString('base64')})).code,0);}
 if(!automatic)await Promise.all(commands.map(c=>joint.net.submit(f.wire(c))));const settled=joint.net.state();
 pass('all twelve terminal outcomes committed after observer recovery');
 if(!automatic)for(const c of commands)await assert.rejects(()=>joint.net.broadcast(f.wire(c)),/already exists in cache/);
 // A different authorized relay must also be harmless after cache deduplication.
 await Promise.all(commands.map(c=>joint.net.submit(f.wire(c,[],f.observers[0]))));assert.deepEqual(joint.net.state().money.outputs,settled.money.outputs);
 for(const o of orders){assert.equal(joint.net.state().exchangeBook.orders[o.id].status,o.outcome==='PAYOUT'?'CLAIMED':'REFUNDED');pass(o.q.direction+' '+o.q.asset+' '+o.outcome+' resolves once after observer recovery');}
 const finalHeight=joint.net.state().money.height;await until(async()=>{for(let i=0;i<10;i++)assert(Number((await joint.net.rpc(i,'status')).sync_info.latest_block_height)>finalHeight);});const replay=await joint.net.replay(),totals=await until(async()=>{const b=await joint.balances();assert.deepEqual(b,['119994000','119994000']);return b;});assert.equal(replay.supply,'240000000');assert.equal(joint.net.state().money.fees,'12000');assert.equal(joint.net.state().exchangeBook.total,'0');
 pass('all validator roots, replay and verified wallet balances agree; conserved supply and fees charged once');
 fs.writeFileSync(join(out,'result.json'),JSON.stringify({passed:true,isolated:true,automaticRecovery:automatic,backupRecovery,fencedSigning:fenced,remoteSigner,signingInventory:signingAuthority?.status(),recoveryCalls:autoAdapter?.calls,productionChanged:false,issuance:false,results,replay,totals,runtime:process.execPath,harness:import.meta.url,scope:'ten Comet processes/shared app host, three observers and distinct BTC/EVM databases on one host; no GUI or mainnet',limits:'automatic public recovery service and production admission not activated'},null,2));
}catch(e){fs.writeFileSync(join(out,'failure.json'),JSON.stringify({message:e.message,stack:e.stack,completed:results},null,2));throw e;}
finally{recoveryWorker?.close();signingAuthority?.close();await vaultSigner?.close();await watchers?.close();await joint?.close();await readers?.close();await btc?.stop();await evm?.stop();}
