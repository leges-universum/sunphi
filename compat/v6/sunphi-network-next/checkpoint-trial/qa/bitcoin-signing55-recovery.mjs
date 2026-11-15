// Real regtest input ownership and signed-but-unbroadcast funding recovery.
// Disposable keys only; no production endpoints, balances or native issuance.
import fs from 'node:fs';import assert from 'node:assert/strict';import {join,resolve} from 'node:path';import {createRequire} from 'node:module';import {randomBytes} from 'node:crypto';
import {hash,digest} from '../crypto.mjs';import {resolutionFixture} from '../test/helpers/exchange-resolution-fixture.mjs';import {bitcoinExchangeScript} from '../research/exchange-bitcoin-script.mjs';
import {SigningCoordinator,coordinatorChannel} from '../research/exchange-signing-coordinator.mjs';import {coordinatedBitcoinSigning} from '../research/exchange-bitcoin-signing.mjs';
import {bitcoinSpend} from './helpers/exchange-bitcoin-spend.mjs';import {bitcoinLab} from './helpers/purchase-external-networks.mjs';
const out=resolve(process.argv[2]);assert(out.startsWith('F:\\DueByteWork\\bitcoin-signing55-')&&!fs.existsSync(out));fs.mkdirSync(out);
const E=createRequire('E:/DueByte-USB/purchase-evm-tools/package.json')('ethers');let btc,c;const key=randomBytes(32),config=resolutionFixture().c,file=join(out,'ledger.sqlite'),checks=[];let channel;
const reopen=()=>{c?.close();c=new SigningCoordinator(file,{config,key,create:!fs.existsSync(file)});channel=coordinatorChannel(c,c.activate());};
const calls={funding:0,refund:0,cancel:0};
try{
 btc=await bitcoinLab(join(out,'btc'),'E:/DueByte-USB/purchase-native-lab-20261109/bitcoin-bin/bitcoin-32.1/bin/bitcoind.exe');config.exchangeLab.policy.routes.BTC.genesis=btc.genesis;reopen();
 const claim=E.Wallet.createRandom(),back=E.Wallet.createRandom(),refund=await btc.buyer('getnewaddress'),secret=randomBytes(32),deadline=Math.floor(Date.now()/1000)-3600;
 const script=bitcoinExchangeScript({network:'bitcoin-regtest',hashlock:digest(secret),claimKey:E.SigningKey.computePublicKey(claim.privateKey,true).slice(2),refundKey:E.SigningKey.computePublicKey(back.privateKey,true).slice(2),refundAt:deadline});
 const address=(await btc.rpc('decodescript',[script.witnessScript])).segwit.address,amount='124456',base=await btc.rpc('createrawtransaction',[[],{[address]:Number(amount)/1e8}]),funded=await btc.buyer('fundrawtransaction',[base,{lockUnspents:true}]),tx=await btc.rpc('decoderawtransaction',[funded.hex]),index=tx.vout.find(v=>v.scriptPubKey.address===address).n,order=hash(['regtest-recovery',tx.txid]);
 const run=(purpose,unsigned,sign)=>coordinatedBitcoinSigning({channel,rpc:btc.rpc,genesis:btc.genesis,order,purpose,request:hash([order,purpose]),unsigned,authorize:async()=>{},sign});
 const fundingSign=async()=>{calls.funding++;const r=await btc.buyer('signrawtransactionwithwallet',[funded.hex]);assert(r.complete);return r.hex;};
 const funding=await run('FUNDING',funded.hex,fundingSign);assert.equal(funding.transaction,tx.txid);await assert.rejects(()=>btc.rpc('getrawtransaction',[tx.txid,true]));
 let total=0n;for(const v of tx.vin)total+=BigInt(Math.round((await btc.rpc('gettxout',[v.txid,v.vout])).value*1e8));
 const cancellation=await btc.rpc('createrawtransaction',[tx.vin.map(v=>({txid:v.txid,vout:v.vout})),{[refund]:Number(total-2000n)/1e8}]);
 await assert.rejects(run('CANCELLED',cancellation,async()=>{calls.cancel++;throw Error('must not sign');}),/UNIQUE/);assert.equal(calls.cancel,0);checks.push('signed unbroadcast funding cannot be replaced by a conflicting cancellation');
 reopen();await btc.restart();assert.deepEqual(await run('FUNDING',funded.hex,fundingSign),funding);assert.equal(calls.funding,1);checks.push('journal and Bitcoin restart recover exact funding bytes without invoking the key');
 assert.equal(await btc.rpc('sendrawtransaction',[funding.raw]),tx.txid);await btc.mine(2);
 const terms={txid:tx.txid,index,amount,output:(await btc.rpc('validateaddress',[refund])).scriptPubKey,script:script.witnessScript,refundAt:deadline},unsigned=bitcoinSpend(E,terms);
 const refundSign=async()=>{calls.refund++;return bitcoinSpend(E,{...terms,key:back.privateKey});};
 const signedRefund=await run('REFUND',unsigned,refundSign);assert.equal((await btc.rpc('testmempoolaccept',[[signedRefund.raw]]))[0].allowed,true);
 await btc.rpc('sendrawtransaction',[signedRefund.raw]);await btc.mine(2);const before=await btc.buyer('getbalances');
 reopen();assert.deepEqual(await run('REFUND',unsigned,refundSign),signedRefund);assert.equal(calls.refund,1);
 const seen=await btc.rpc('getrawtransaction',[signedRefund.transaction,true]);assert.equal(seen.vout[0].value,0.00123456);assert(seen.confirmations>=2);assert.equal(await btc.rpc('gettxout',[tx.txid,index]),null);
 checks.push('retained funding completes through the original hashlock refund after restart');
 try{await btc.rpc('sendrawtransaction',[signedRefund.raw]);}catch(e){assert.equal(e.rpcCode,-27);}assert.deepEqual(await btc.buyer('getbalances'),before);checks.push('replay of signed refund cannot credit the wallet twice');
 assert(c.status().every(r=>r.status==='SIGNED'));assert.deepEqual(calls,{funding:1,refund:1,cancel:0});
 fs.writeFileSync(join(out,'result.json'),JSON.stringify({passed:true,isolated:true,checks,calls,funding:funding.transaction,refund:signedRefund.transaction,inventory:c.status(),productionChanged:false,issuance:false,scope:'real Bitcoin regtest and independent durable journal; native authorization mocked, covered separately by combined Comet lab'},null,2));console.log(JSON.stringify({passed:true,checks:checks.length,calls}));
}catch(e){fs.writeFileSync(join(out,'failure.json'),JSON.stringify({message:e.message,stack:e.stack,checks},null,2));throw e;}finally{c?.close();key.fill(0);await btc?.stop();}
