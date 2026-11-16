// Ten real, isolated CometBFT validators; only synthetic keys and funds.
import fs from 'node:fs';import {resolve,join} from 'node:path';import assert from 'node:assert/strict';
import {fragmentedFixture,inputCertificate} from '../test/helpers/payment-input-fixture.mjs';
import {purchaseCometNetwork,until} from './helpers/purchase-comet-network.mjs';
import {browserPayment} from './payment84-browser-flow.mjs';
import {publicServer} from '../public-rpc.mjs';
import {hash} from '../crypto.mjs';import {sharedInputsEnabled} from '../payment-input-policy.mjs';
import {Wallet,balances} from '../wallet.mjs';import {createBoundedApi} from '../research/bounded-api.mjs';import {boundedHttpQuery,loadBoundedWalletView} from '../research/bounded-wallet-view.mjs';
const out=resolve(process.argv[2]);assert(out.startsWith('F:\\DueByteWork\\payment84-comet-'));
const x=fragmentedFixture(undefined,{startTime:Math.floor(Date.now()/1000)-300,chainId:'duebyte-trial-routing84'}),source=x.s;
let net,api,query,wallet,gateway,unavailable=false;const report={isolated:true,validators:10,syntheticTrustBootstrap:true,productionTransfers:0,checks:[]};
const check=(name,data={})=>{report.checks.push({name,...data});console.log(JSON.stringify(report.checks.at(-1)));};
async function closeApi(){if(api){api.closeAllConnections();await new Promise(r=>api.close(r));api=null;}}
async function openApi(){api=createBoundedApi(net.apps[0].handler);await new Promise(r=>api.listen(0,'127.0.0.1',r));query=boundedHttpQuery('http://127.0.0.1:'+api.address().port);}
try{
 net=await purchaseCometNetwork(out,{...x.f,c:x.c,validators:x.validators},{labSourceState:source,rpcTimeoutMs:30000,basePort:39000,workerKeys:Object.keys(source.money.nodes).map(node=>({node,...x.key(node)}))});await openApi();
 const client={config:x.c,bounded:true,sync:async(_cp,_url,options)=>{const h=net.apps[0].handler,height=h.networkHeader().height,root=h.root;return query.withLease(root,async q=>({...await loadBoundedWalletView(q,{root,height,configHash:hash(x.c),...options}),certificate:{appHash:root,appHeight:height,height:height+1}}));}};
 gateway=publicServer({kind:'rpc',target:39001,workers:Object.fromEntries(Object.keys(source.money.nodes).map((id,i)=>[id,39001+i*10]))},{upstream:async(url,opts)=>{const q=JSON.parse(opts.body);if(unavailable&&q.method==='abci_query'&&q.params.path==='/work')return new Response('{}',{status:503});return fetch(url,opts);}});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 const home=join(out,'wallet');fs.mkdirSync(home);const options={client,key:x.f.alice,home,checkpoint:{},url:'http://127.0.0.1:'+gateway.address().port,routes:{}};wallet=new Wallet(options);
 await assert.rejects(wallet.quote('3','1000000'),e=>e.code==='PAYMENT_INPUT_CAPACITY'&&e.paymentOutcome==='not_created');assert.equal(wallet.db.prepare('select count(*) n from outgoing').get().n,0);check('old limit reproduced before activation; no outbox write');
 const activation=x.wire(inputCertificate(x,net.state()));await net.submit(Buffer.from(JSON.stringify(activation)));await until(()=>assert(sharedInputsEnabled(net.state())),90000);check('quorum future activation committed');
 const before=BigInt(balances(net.state(),x.f.alice.publicKey).available),receiverBefore=BigInt(balances(net.state(),x.f.bob.publicKey).available),q=await wallet.quote('3','1000000');assert.equal(q.fee,'5000');
 const p=await wallet.prepareTokens({recipient:x.f.bob.publicKey,value:'3',unitScale:q.unitScale,fee:q.fee,abortFee:q.abortFee,feeSchedule:q.feeSchedule,partsCount:q.partsCount});
 const intent=JSON.parse(wallet.db.prepare('select body from outgoing where pid=?').get(p.pid).body).body.action.signed.intent;assert(intent.inputs.length>8);check('one payment prepared from fragmented rewards',{inputs:intent.inputs.length,fee:q.fee});
 wallet.close();wallet=null;await closeApi();await net.restartAll();await openApi();wallet=new Wallet(options);check('ten-validator and wallet restart before submission retained outbox');
 await until(async()=>{await wallet.resume(p.pid);assert.equal(net.state().money.requests[p.pid]?.status,'SETTLED');},120000);
 assert.equal(BigInt(balances(net.state(),x.f.bob.publicKey).available),receiverBefore+3000000n);assert.equal(BigInt(balances(net.state(),x.f.alice.publicKey).available),before-3005000n);assert.equal(net.state().money.supply,source.money.supply);
 await wallet.resume(p.pid);assert.equal(BigInt(balances(net.state(),x.f.bob.publicKey).available),receiverBefore+3000000n);check('real signed work receipts settle exactly once with unchanged fee and supply');
 report.browser=await browserPayment({x,net,gateway:'http://127.0.0.1:'+gateway.address().port,apiUrl:'http://127.0.0.1:'+api.address().port,out,setUnavailable:value=>{unavailable=value;}});check('actual browser and HTTP flow with unavailable worker recovery',report.browser);
 wallet.close();wallet=null;await closeApi();await net.restartAll();report.replay=await net.replay();check('all validators restart and archive replay match committed roots');report.passed=true;
}catch(e){report.passed=false;report.error=e.stack;throw e;}finally{wallet?.close();if(gateway){gateway.closeAllConnections();await new Promise(r=>gateway.close(r));}await closeApi();if(net)await net.close();fs.mkdirSync(out,{recursive:true});fs.writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));}
