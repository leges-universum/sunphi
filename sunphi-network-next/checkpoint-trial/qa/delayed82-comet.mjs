// Current storage, tariff and UTC obligations on ten isolated real validators.
// A synthetic trusted laboratory state bootstraps the test; no production funds.
import fs from 'node:fs';import {resolve,join} from 'node:path';import assert from 'node:assert/strict';
import {utcEconomicFixture} from '../test/helpers/utc-economic-fixture.mjs';
import {purchaseCometNetwork,until} from './helpers/purchase-comet-network.mjs';
import {hash} from '../crypto.mjs';import {CONTROL,DELAYED_FEATURE,delayedPaymentsEnabled} from '../authority.mjs';
import {INITIAL_TARIFF} from '../payment-tariff.mjs';import {Wallet,balances} from '../wallet.mjs';
import {createBoundedApi} from '../research/bounded-api.mjs';import {boundedHttpQuery,loadBoundedWalletView} from '../research/bounded-wallet-view.mjs';
const out=resolve(process.argv[2]);assert(out.startsWith('F:\\DueByteWork\\delayed82-comet-'));
const x=utcEconomicFixture({liability:{expanded:true,terminal:true,workerCount:10,startTime:Math.floor(Date.now()/1000)-300,chainId:'duebyte-trial-delayed82'}}),source=structuredClone(x.s);
source.money.paymentTariff={current:null,next:INITIAL_TARIFF,activation:source.money.time,certificateHash:hash('synthetic tariff')};
let net,api,query,wallet;const report={isolated:true,validators:10,syntheticTrustBootstrap:true,productionTransfers:0,checks:[]};
const check=(name,data={})=>{report.checks.push({name,...data});console.log(JSON.stringify(report.checks.at(-1)));};
async function closeApi(){if(api){api.closeAllConnections();await new Promise(r=>api.close(r));api=null;}}
async function openApi(){api=createBoundedApi(net.apps[0].handler);await new Promise(r=>api.listen(0,'127.0.0.1',r));query=boundedHttpQuery('http://127.0.0.1:'+api.address().port);}
try{
 net=await purchaseCometNetwork(out,{...x.f,c:x.c,validators:x.validators},{labSourceState:source,rpcTimeoutMs:30000,basePort:38000,workerKeys:Object.keys(source.money.nodes).map(node=>({node,...x.key(node)}))});await openApi();
 const s=net.state(),body={domain:CONTROL+'/FEATURE',network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,feature:DELAYED_FEATURE,notBefore:s.height+1,expires:s.height+3,activation:s.height+5};
 await net.submit(Buffer.from(JSON.stringify(x.wire({type:'ENABLE_DELAYED_PAYMENTS',certificate:{body,approvals:x.approvals(body)}}))));await until(()=>assert(delayedPaymentsEnabled(net.state())),90000);check('signed future activation committed');
 const client={config:x.c,bounded:true,sync:async(_cp,_url,options)=>{const h=net.apps[0].handler,height=h.networkHeader().height,root=h.root;return query.withLease(root,async q=>({...await loadBoundedWalletView(q,{root,height,configHash:hash(x.c),...options}),certificate:{appHash:root,appHeight:height,height:height+1}}));}};
 const home=join(out,'wallet');fs.mkdirSync(home);const options={client,key:x.f.alice,home,checkpoint:{},url:'http://127.0.0.1:38001',routes:Object.fromEntries(Object.keys(source.money.nodes).map((id,i)=>[id,'http://127.0.0.1:'+(38001+i*10)]))};wallet=new Wallet(options);
 const before=BigInt(balances(net.state(),x.f.alice.publicKey).available),quote=await wallet.quote('1.234567','1000000');assert.equal(quote.fee,'5000');assert.equal(quote.abortFee,'500');
 const request={recipient:x.f.bob.publicKey,value:'1.234567',unitScale:quote.unitScale,fee:quote.fee,abortFee:quote.abortFee,feeSchedule:quote.feeSchedule,partsCount:quote.partsCount,delayed:true,protected:true};
 const prepared=await wallet.prepareTokens(request),pid=prepared.pid;
 await until(async()=>{await wallet.resume(pid);assert.equal(net.state().money.requests[pid]?.status,'SCHEDULED');},120000);
 const scheduled=net.state().money.requests[pid];assert.equal(scheduled.intent.sendDelay,86400);assert.equal(scheduled.intent.delay,86400);assert(scheduled.executeAt-net.state().money.time>86300);check('real work receipts scheduled payment',{fee:quote.fee,releaseFee:quote.abortFee});
 wallet.close();wallet=null;await closeApi();await net.restartAll();await openApi();wallet=new Wallet(options);assert.equal(net.state().money.requests[pid].executeAt,scheduled.executeAt);check('ten-validator restart retained schedule and outbox');
 await wallet.cancel(pid);await until(()=>assert.equal(net.state().money.requests[pid].status,'CANCELLED'),90000);
 const after=BigInt(balances(net.state(),x.f.alice.publicKey).available);assert.equal(after,before-500n);await wallet.cancel(pid);assert.equal(BigInt(balances(net.state(),x.f.alice.publicKey).available),after);check('cancel charges reviewed release fee exactly once');
 const receiverBefore=BigInt(balances(net.state(),x.f.bob.publicKey).available),immediateQuote=await wallet.quote('3','1000000');
 const immediate=await wallet.prepareTokens({recipient:x.f.bob.publicKey,value:'3',unitScale:immediateQuote.unitScale,fee:immediateQuote.fee,abortFee:immediateQuote.abortFee,feeSchedule:immediateQuote.feeSchedule,partsCount:immediateQuote.partsCount,delayed:false,protected:false});
 await until(async()=>{await wallet.resume(immediate.pid);assert.equal(net.state().money.requests[immediate.pid]?.status,'SETTLED');},120000);
 assert.equal(BigInt(balances(net.state(),x.f.bob.publicKey).available),receiverBefore+3000000n);assert.equal(BigInt(balances(net.state(),x.f.alice.publicKey).available),after-3000000n-BigInt(immediateQuote.fee));
 check('ordinary three-token payment settled with exact sender debit, fee and recipient credit',{fee:immediateQuote.fee});
 assert.equal(net.state().money.supply,source.money.supply);wallet.close();wallet=null;await closeApi();await net.restartAll();report.replay=await net.replay();check('restart and complete archive replay preserve roots and supply');report.passed=true;
}catch(e){report.passed=false;report.error=e.stack;throw e;}finally{wallet?.close();await closeApi();if(net)await net.close();fs.mkdirSync(out,{recursive:true});fs.writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));}
