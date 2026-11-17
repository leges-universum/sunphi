// End-to-end buyer API, real Comet proofs, test chains and encrypted recovery.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {hash,sign} from '../crypto.mjs';
import {nativeFixture} from '../test/helpers/purchase-native-fixture.mjs';
import {queryBounded} from '../research/bounded-query.mjs';
import {PurchaseBroker,servePurchaseBroker} from '../research/purchase-api.mjs';
import {WalletPurchase} from '../wallet-protected-purchase.mjs';
import {CommittedPurchaseReader,ProtectedRefundExecutor,observeCommitted,serviceRpc} from '../research/purchase-service.mjs';
import {bitcoinRefundAdapter} from '../research/purchase-bitcoin-refund.mjs';
import {usdcRefundAdapter} from '../research/purchase-usdc-refund.mjs';
import {sealPurchaseCustody,openPurchaseCustody,writePurchaseCustody} from '../research/purchase-custody.mjs';
import {RefundOutbox} from '../research/purchase-refund-worker.mjs';
import {startSellerSigner,FundedPurchaseSeller} from '../research/purchase-seller.mjs';
import {ProtectedSellerSigner,initializeSellerJournal,SELLER_PROFILE,PERSONAL_SELLER_PROFILE} from '../research/purchase-seller-protected.mjs';
import {seal} from '../vault.mjs';
import {serveSecurePurchaseBroker} from '../research/purchase-transport.mjs';
import {purchaseTlsFixture} from '../test/helpers/purchase-tls-fixture.mjs';
import {HomeSellerRelay} from '../research/purchase-home-relay.mjs';
import {homeSeller} from './helpers/purchase-home-seller.mjs';
import {packagedWallet} from './helpers/purchase-packaged-wallet.mjs';
import {purchaseCometNetwork,until} from './helpers/purchase-comet-network.mjs';
import {bitcoinLab,evmLab} from './helpers/purchase-external-networks.mjs';
const out=resolve(process.argv[2]),tools=resolve(process.argv[3]),bitcoin=resolve(process.argv[4]);
assert(/^[DE]:[\\/]DueByte-USB[\\/]purchase-api-custody-lab-[a-z0-9-]+$/i.test(out)&&!fs.existsSync(out));fs.mkdirSync(out,{recursive:true});
const sourceFiles=['research/purchase-seller.mjs','research/purchase-seller-signer.mjs','research/purchase-seller-protected.mjs','research/purchase-transport.mjs','research/purchase-api.mjs','wallet-protected-purchase.mjs','vault.mjs','test/helpers/purchase-tls-fixture.mjs','qa/purchase-api-custody-lab.mjs'];
sourceFiles.push('wallet-seller.mjs','wallet-server.mjs','wallet.html','research/purchase-home-relay.mjs','qa/helpers/purchase-home-seller.mjs');
const sourcePins=Object.fromEntries(sourceFiles.map(file=>[file,hash(fs.readFileSync(file,'utf8'))]));
let btc,evm,net,broker,server,wallet,executor,signer,relay,relayServer,sellerHome;const readers=[],checks=[];const pass=s=>{checks.push(s);console.log('PASS '+s);};
try{
 btc=await bitcoinLab(join(out,'bitcoin'),bitcoin);evm=await evmLab(join(out,'evm'),tools);
 const f=nativeFixture(Math.floor(Date.now()/1000)-2);f.policy.rpcPins.BTC={genesis:btc.genesis};f.policy.rpcPins.USDC=evm.pins;
 const homeMode=process.argv[6]==='home-seller',packaged=process.argv[5]==='packaged-wallet',personalHttps=homeMode||process.argv[6]==='personal-https',protectedCustody=personalHttps||process.argv[6]==='protected-custody';
 assert(!personalHttps||!packaged,'personal HTTPS mode currently qualifies WalletPurchase API, not packaged UI');
 const tls=personalHttps?purchaseTlsFixture(join(out,'synthetic-tls')):null;
 if(packaged||homeMode)f.c.control.policy.members=f.validators.slice(0,4).map((k,i)=>({key:k.publicKey,group:hash(['policy',i])}));
 net=await purchaseCometNetwork(join(out,'comet'),f,{walletReady:packaged||homeMode});
 const genesisFile=join(net.homes[0],'config/genesis.json'),genesisHash=hash(JSON.parse(fs.readFileSync(genesisFile))),first=(await net.rpc(0,'commit',{height:'1'})).signed_header;
 const trust={binary:resolve('build/duebyte-abci.exe'),genesisFile,genesisHash,anchor:{height:1,blockHash:first.commit.block_id.hash.toLowerCase()},configHash:hash(f.c),policy:f.policy,historyUrl:'http://127.0.0.1:36001',walletTrust:net.walletTrust};
 const reader=name=>{const home=join(out,name);fs.mkdirSync(home,{recursive:true});const r=new CommittedPurchaseReader({...trust,home});readers.push(r);return r;};
 const state=()=>net.state(),order=id=>state().purchaseBook.orders[id];
 async function proof(id){const h=net.apps[0].handler,p=queryBounded(h,{type:'purchase-order',id},h.root);await until(async()=>assert(Number((await net.rpc(0,'status')).sync_info.latest_block_height)>=p.result.height+1));return p;}
 const settings={minOrderMicro:'1000000',maxOrderMicro:'20000000',quoteSeconds:120,paymentSeconds:600,rates:{BTC:{numerator:'1',denominator:'1000',feeAtomic:'100'},USDC:{numerator:'1',denominator:'1000',feeAtomic:'100'}},usdcDestinations:evm.addresses.slice(1,3)};
 const empty=new RefundOutbox(':memory:'),vaultFile=join(out,'seller.encrypted.json'),password='synthetic-seller-unlock-'+hash(out);
 if(personalHttps)fs.writeFileSync(vaultFile,JSON.stringify(seal(f.seller,password)),{flag:'wx',mode:0o600});
 else writePurchaseCustody(vaultFile,sealPurchaseCustody({configHash:hash(f.c),policyHash:hash(f.policy),outbox:empty.snapshot(hash(f.c)),secrets:[{name:'dubyt-seller',kind:'ed25519-private-key',data:Buffer.from(f.seller.privateKey).toString('base64')}]},password));empty.close();
 const btcDestinations=[await btc.seller('getnewaddress'),await btc.seller('getnewaddress')];
 const signerOptions={config:f.c,settings,vaultFile,password,btcDestinations};let protectedOptions;
 if(protectedCustody){
  const bundle=JSON.parse(fs.readFileSync(vaultFile));
  const profile={domain:personalHttps?PERSONAL_SELLER_PROFILE:SELLER_PROFILE,...(personalHttps?{vaultKind:'personal-wallet'}:{}),operator:'Ledges Universum LLC - isolated qualification',config:f.c,settings,vaultHash:hash(bundle),btcDestinations,dailyLimitMicro:'40000000'},journal=join(out,'seller-authorizations.sqlite');
  initializeSellerJournal(journal,profile);fs.writeFileSync(join(out,'seller-profile.json'),JSON.stringify(profile));protectedOptions={profile,bundle,password,journal};
 }
 // This Windows chain run qualifies the protected engine. Separate-UID service
 // qualification is qa/protected-seller-linux.mjs, not this process.
 const openSigner=async()=>{
  if(!homeMode)return protectedCustody?new ProtectedSellerSigner(protectedOptions):startSellerSigner(signerOptions);
  await sellerHome?.close();relay=new HomeSellerRelay(join(out,'home-relay.sqlite'),protectedOptions.profile);
  if(!relayServer)relayServer=await serveSecurePurchaseBroker({policy:f.policy,handle:request=>relay.handle(request)},tls);
  sellerHome=await homeSeller({home:join(out,'seller-home'),config:f.c,trust,...protectedOptions,transport:{kind:'pinned-https-v1',url:relayServer.url,spkiSha256:relayServer.spkiSha256,caPem:tls.caPem}});
  pass('actual Home unlock and explicit UI permission enable local seller signing; foreign session denied');return relay;
 };
 signer=await openSigner();f.seller.privateKey='';
 const funded=()=>new FundedPurchaseSeller({config:f.c,signer,state,bitcoinRpc:btc.seller,btcDestinations,usdcDestinations:settings.usdcDestinations,usedDestinations:()=>broker.db.prepare('SELECT quote FROM quotes').all().map(r=>JSON.parse(r.quote).offer.destination)});
 let lost=false,prepared=0;const brokerOptions={file:join(out,'seller.sqlite'),config:f.c,
  quote:p=>funded().quote(p),prepare:async command=>{prepared++;return funded().prepare(command);},
  submit:async(wire,id)=>{if(!state().purchaseBook?.orders[id]){const created=JSON.parse(wire).body.action.command.offer.createdAt;await until(()=>assert(state().money.time>=created));await net.submit(wire);}if(lost){lost=false;throw Error('injected lost acceptance reply');}},proof};
 const diagnostics={onError:e=>console.log('API diagnostic: '+String(e.message).slice(0,240))};
 const openServer=()=>personalHttps?serveSecurePurchaseBroker(broker,tls):servePurchaseBroker(broker,diagnostics);
 broker=new PurchaseBroker(brokerOptions);server=await openServer();
 const openWallet=async()=>packaged?packagedWallet({home:join(out,'packaged-wallet'),config:f.c,key:f.buyer,trust,url:server.url}):new WalletPurchase({file:join(out,'buyer.sqlite'),config:f.c,key:f.buyer,reader:reader('wallet-reader'),url:server.url,transport:personalHttps?{kind:'pinned-https-v1',url:server.url,spkiSha256:server.spkiSha256,caPem:tls.caPem}:null});wallet=await openWallet();
 if(personalHttps)pass('synthetic personal wallet vault and pinned HTTPS transport admitted only in isolated chain');
 if(packaged)pass('packaged wallet verifies indexed balance and Comet headers before purchase');
 const observerReaders=[reader('observer-0'),reader('observer-1'),reader('observer-2')],rpcs={BTC:serviceRpc(btc.connection),USDC:evm.rpc};
 async function observe(id,kind,extra){const request={id,kind,proof:await proof(id),now:Math.floor(Date.now()/1000),...extra};const results=await Promise.all(observerReaders.map((r,i)=>observeCommitted({reader:r,key:f.attesters[i],rpcs,request})));assert(results.every(x=>hash(x.body)===hash(results[0].body)));const command={type:'EVIDENCE',body:results[0].body,approvals:results.map(x=>x.approval)};await until(()=>assert(state().money.time>=command.body.observedAt));await net.submit(f.wire(command));}
 let btcSeller=serviceRpc({...btc.connection,url:btc.connection.url+'/wallet/seller'}),usdcSigner=evm.wallets[2];
 const makeExecutor=(name)=>{const home=join(out,name);fs.mkdirSync(home,{recursive:true});return new ProtectedRefundExecutor({home,reader:reader(name+'-reader'),rpcs,maxAtomic:{BTC:'100000',USDC:'100000'},adapters:{BTC:()=>bitcoinRefundAdapter({rpc:btcSeller,genesis:btc.genesis}),USDC:()=>usdcRefundAdapter({rpc:evm.rpc,signer:usdcSigner,codec:evm.ethers,pins:evm.pins,codeHash:evm.codeHash})}});};
 executor=makeExecutor('executor');const request=async(id,deposits)=>({id,deposits,proof:await proof(id)});
 const results=[];let recoveredPayload;
 for(const route of ['BTC','USDC'])for(const mode of ['exact','partial']){
  const refundDestination=route==='BTC'?await btc.refundAddress():evm.addresses[0];
  const quoted=await wallet.handle('quote',{amount:'10',route,refundDestination});assert(!quoted.destination);
  if(route==='BTC'&&mode==='exact'){
   lost=true;await assert.rejects(()=>wallet.handle(packaged?'accept-api':'accept',{id:quoted.id}));assert(order(quoted.id),'lost reply must follow actual commit');await wallet.close();wallet=null;await server.close();server=null;broker.close();await signer.close();signer=await openSigner();broker=new PurchaseBroker(brokerOptions);server=await openServer();wallet=await openWallet();
   const restored=await wallet.handle('availability',{});assert.equal(restored.activeOrder.id,quoted.id);assert(restored.activeOrder.destination);assert.equal(prepared,1);pass('lost acceptance reply and seller/wallet restart retain one committed reservation');
  }else await wallet.handle('accept',{id:quoted.id});
  const o=order(quoted.id),txid=route==='BTC'?await btc.pay(o.offer.destination,mode==='exact'?'10000':'5000'):await evm.pay(o.offer.destination,mode==='exact'?'10000':'5000');
  if(homeMode&&route==='USDC'&&mode==='partial'){await sellerHome.lock();pass('seller wallet locked before external refund; refund executor has no DUBYT private key');}
  if(route==='BTC')await btc.mine(6);else await evm.mine();
  const deposits=[{txid,index:route==='BTC'?await btc.index(txid,o.offer.destination):0}];await observe(quoted.id,'PAYMENT',deposits[0]);
  if(mode==='exact'){assert.equal((await wallet.handle('order',{id:quoted.id})).status,'COMPLETED');pass(route+' API purchase releases native DUBYT only after committed payment quorum');}
  else{
   await observe(quoted.id,'REFUND_INTENT',{deposits});const sent=await executor.execute(await request(quoted.id,deposits));
   // Export a real Bitcoin wallet backup together with the exact signed outbox.
   const backup=join(out,'bitcoin-wallet.synthetic.backup');if(!fs.existsSync(backup))await btc.seller('backupwallet',[backup]);
   const input={configHash:hash(f.c),policyHash:hash(f.policy),outbox:executor.box.snapshot(hash(f.c)),secrets:[{name:'bitcoin-seller',kind:'bitcoin-wallet-backup',data:fs.readFileSync(backup).toString('base64')},{name:'usdc-seller',kind:'evm-private-key',data:Buffer.from(evm.wallets[2].privateKey).toString('base64')}]};
   const password='synthetic-offline-recovery-'+hash(quoted.id),bundle=sealPurchaseCustody(input,password);writePurchaseCustody(join(out,route+'-custody.encrypted.json'),bundle);recoveredPayload=openPurchaseCustody(bundle,password,{configHash:hash(f.c),policyHash:hash(f.policy)});
   executor.close();executor=null;usdcSigner=new evm.ethers.Wallet(Buffer.from(recoveredPayload.secrets.find(s=>s.kind==='evm-private-key').data,'base64').toString());
   if(route==='BTC'){
    const recoveredFile=join(out,'bitcoin-wallet.restored.backup');fs.writeFileSync(recoveredFile,Buffer.from(recoveredPayload.secrets.find(s=>s.kind==='bitcoin-wallet-backup').data,'base64'),{flag:'wx',mode:0o600});
    await btc.rpc('unloadwallet',['seller']);await btc.rpc('restorewallet',['recovered-seller',recoveredFile]);btcSeller=serviceRpc({...btc.connection,url:btc.connection.url+'/wallet/recovered-seller'});
   }
   executor=makeExecutor('restored-'+route);executor.box.restore(recoveredPayload.outbox,hash(f.c));assert.equal((await executor.execute(await request(quoted.id,deposits))).txid,sent.txid);
   if(route==='BTC')await btc.mine(6);else await evm.mine();await observe(quoted.id,'REFUND',{txid:sent.txid,index:route==='BTC'?await btc.index(sent.txid,refundDestination):0});
   assert.equal((await wallet.handle('order',{id:quoted.id})).status,'REFUNDED');pass(route+' encrypted key/outbox restoration on fresh executor repeats original refund only');
   if(route==='BTC'){
    // A restored executor cannot service new orders without reconciliation.
    executor.close();executor=null;executor=makeExecutor('executor-next');
   }
  }
  results.push({route,mode,id:quoted.id,status:order(quoted.id).status});
 }
 if(packaged){await until(async()=>{const s=await wallet.status();assert(!s.error&&s.checkedAt);assert.equal(s.balance.available,'20000000');});pass('wallet verified balance contains exactly the two completed purchases');}
 await net.restart(9);await until(async()=>assert((await net.rpc(9,'status')).sync_info.catching_up===false));const replay=await net.replay();assert.equal(replay.supply,'100000000');assert.equal(prepared,4);
 pass('restarted validator and complete block replay preserve supply and order outcomes');
 for(const file of sourceFiles)assert.equal(hash(fs.readFileSync(file,'utf8')),sourcePins[file],'source changed during qualification');
 fs.writeFileSync(join(out,'report.json'),JSON.stringify({passed:true,checks,results,replay,prepared,sourcePins,packagedWallet:packaged,protectedCustody,personalHttps,homeMode,sellerSigningProcess:homeMode||!protectedCustody,productionWrites:false,issuance:false,limitations:[personalHttps?'Pinned TLS on local lab endpoint; public DNS and cross-host transport not qualified':'Loopback API only; no public sale','Home source process and rendered wallet UI; three release packages not rebuilt by this test','Observers share host/operator in this run; distinct-host qualification recorded separately','TestUSDC is not Circle USDC','Restored executors cannot sign absent outbox rows; reconciliation still required']},null,2));
}finally{await sellerHome?.close();await relayServer?.close();await wallet?.close();await server?.close();broker?.close();executor?.close();await signer?.close();for(const r of readers)try{r.close();}catch{}await net?.close();await btc?.stop();await evm?.stop();}
