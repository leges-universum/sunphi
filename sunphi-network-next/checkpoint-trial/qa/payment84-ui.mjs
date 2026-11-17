import fs from 'node:fs';import path from 'node:path';import {createServer} from 'node:http';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL('C:/Users/Leges Universum/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const out=process.argv[3]||'F:/DueByteWork/payment84/ui-source';fs.mkdirSync(out,{recursive:true});
const old=JSON.parse(fs.readFileSync('F:/DueByteWork/compatible-packages81-r1/release.json')).releases.find(p=>p.platform==='windows-x64').folder+'/resources/app/sunphi-network-next/checkpoint-trial';
let root=old,quotes=0,sends=0,lastSend=null,failure=null;const errors=[],checks=[];
const state={locked:false,hasVault:true,working:true,checkedAt:Date.now(),error:null,network:'Isolated UI fixture',height:100,owner:'a'.repeat(43),wallets:[{id:'qa',name:'QA wallet'}],activeWallet:'qa',selectedWallet:'qa',unitScale:'1000000',balance:{available:'4000000',reserved:'0',scheduled:'0',protected:'0',display:{available:'4',reserved:'0',scheduled:'0',protected:'0'}},payments:[],features:{delayedPayments:false},networkTime:1000,analytics:null};
const server=createServer(async(req,res)=>{try{
 res.setHeader('Content-Type','application/json');
 if(req.url==='/status')return res.end(JSON.stringify(state));
 if(req.method==='POST'){let raw='';for await(const c of req)raw+=c;const q=JSON.parse(raw);
  if(req.url==='/quote'){quotes++;await new Promise(r=>setTimeout(r,250));return res.end(JSON.stringify({unitScale:'1000000',value:'3000000',fee:'5000',abortFee:'500',total:'3005000',display:{value:'3',fee:'0.005',abortFee:'0.0005',total:'3.005'}}));}
  if(req.url==='/authorize-action')return res.end(JSON.stringify({permit:'synthetic'}));
  if(req.url==='/send'){await new Promise(r=>setTimeout(r,500));lastSend=q;sends++;if(failure){res.statusCode=400;return res.end(JSON.stringify(failure));}return res.end(JSON.stringify(state));}
  res.writeHead(400);return res.end(JSON.stringify({error:'Unused isolated route'}));
 }
 const pathname=new URL(req.url,'http://localhost').pathname;assert(!pathname.includes('..'));
 const file=pathname==='/'?root+'/wallet.html':pathname.startsWith('/brand/')?path.resolve(root,'../desktop')+pathname:null;assert(file);
 res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.png')?'image/png':file.endsWith('.woff2')?'font/woff2':'text/html');res.end(fs.readFileSync(file));
}catch{res.writeHead(404);res.end('{}');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();
try{
 const legacy=await browser.newPage();await legacy.goto('http://127.0.0.1:'+server.address().port);await legacy.locator('#funds').waitFor();await legacy.evaluate(()=>selectTab('send'));assert(await legacy.locator('#send').isDisabled());assert(await legacy.locator('#delayed-send').isDisabled());checks.push({exact81BusyRegressionReproduced:true});await legacy.close();
 root=process.argv[2]||path.resolve(import.meta.dirname,'..');
 for(const theme of ['graphite','light'])for(const width of [390,1440]){
  const p=await browser.newPage({viewport:{width,height:1000}});p.on('pageerror',e=>errors.push(e.message));await p.goto('http://127.0.0.1:'+server.address().port);await p.locator('#funds').waitFor();await p.evaluate(t=>{theme(t);selectTab('send');},theme);
  assert(await p.locator('#send').isEnabled());assert(await p.locator('#delayed-send').isDisabled());assert((await p.locator('#payment-readiness').innerText()).includes('Background verification'));
  await p.locator('#recipient').fill('b'.repeat(43));await p.locator('#amount').fill('3');const before=sends;await p.locator('#send').click();await p.locator('#payment-review').waitFor();assert.equal(sends,before);assert((await p.locator('#review-amount').innerText()).includes('3.005 DUBYT'));assert.equal(await p.locator('#confirm-payment').innerText(),'Send payment');
  await p.locator('#cancel-payment').click();assert.equal(sends,before);
  state.features.delayedPayments=true;await p.evaluate(()=>{paint({...lastStatus,features:{delayedPayments:true}});});assert(await p.locator('#delayed-send').isEnabled());
  await p.locator('#delayed-send').check();await p.locator('#protection').check();await p.locator('#send').click();await p.locator('#payment-review').waitFor();assert.equal(sends,before);assert.equal(await p.locator('#confirm-payment').innerText(),'Schedule payment');assert((await p.locator('#review-protection').innerText()).includes('another 24 hours'));
  await p.screenshot({path:out+'/'+theme+'-'+width+'-review.png',fullPage:true});await p.locator('#confirm-payment').click();assert.equal(await p.locator('#payment-review').getAttribute('aria-busy'),'true');assert(await p.locator('#payment-review .operation-wait').isVisible());await p.locator('#payment-review').waitFor({state:'hidden'});assert.equal(sends,before+1);assert(lastSend.delayed&&lastSend.protected);assert.equal(lastSend.fee,'5000');assert.equal(lastSend.value,'3');state.features.delayedPayments=false;
  await p.evaluate(()=>selectTab('send'));
  for(const known of [true,false]){
   failure=known?{error:'Insufficient spendable funds.',paymentOutcome:'not_created',code:'INSUFFICIENT_FUNDS'}:{error:'Connection interrupted'};
   await p.locator('#recipient').fill('b'.repeat(43));await p.locator('#amount').fill('3');await p.locator('#delayed-send').uncheck();await p.locator('#protection').uncheck();
   await p.locator('#send').click();await p.locator('#payment-review').waitFor();const attempts=sends;await p.locator('#confirm-payment').click();await p.waitForFunction(()=>document.querySelector('#review-error').textContent.length>0);
   const error=await p.locator('#review-error').innerText();assert(known?error.startsWith('No payment was created or sent.'):error.startsWith('The result is uncertain.'));assert(await p.locator('#confirm-payment').isDisabled());assert.equal(sends,attempts+1);
   await p.screenshot({path:out+'/'+theme+'-'+width+'-'+(known?'not-created':'uncertain')+'.png'});await p.locator('#cancel-payment').click();failure=null;
  }
  await p.evaluate(()=>paint({...lastStatus,checkedAt:null}));assert(await p.locator('#send').isDisabled());assert(await p.locator('#delayed-send').isDisabled());
  await p.evaluate(s=>paint(s),state);assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.evaluate(()=>{feedback='';paint({...lastStatus,working:false,error:null,paymentNotice:null});});
  const top=await p.locator('#workspace-tools').boundingBox();
  for(const change of [{error:'Verification temporarily unavailable.'},{error:null,paymentNotice:'Waiting for payment confirmations. The original payment will retry automatically; do not send it again.'},{error:null,paymentNotice:null},{working:true}]){
   await p.evaluate(c=>paint({...lastStatus,...c}),change);assert.equal((await p.locator('#workspace-tools').boundingBox()).y,top.y,'notification must not move workspace');
  }
  await p.evaluate(()=>{selectTab('activity');const rows=[{pid:'a'.repeat(64),status:'RESERVED',direction:'Sent',value:'3',fee:'0.005'},{pid:'b'.repeat(64),status:'SETTLED',direction:'Received',value:'1.234567',fee:'0'}];$('payments').replaceChildren(...rows.map(paymentRecordElement));});
  assert.equal(await p.locator('#payments .wait-indicator').count(),1);
  const colours=await p.locator('#payments .financial-number').evaluateAll(ns=>ns.map(n=>getComputedStyle(n).color));assert.notEqual(colours[0],colours[1]);
  await p.screenshot({path:out+'/'+theme+'-'+width+'-activity.png',fullPage:true});
  const deliveryTop=await p.locator('#workspace-tools').boundingBox();
  await p.evaluate(()=>{const p={pid:'c'.repeat(64),direction:'Sent',value:'3',status:'RESERVED'};paint({...lastStatus,error:null,payments:[p]});paint({...lastStatus,payments:[{...p,status:'SETTLED'}]});});
  assert((await p.locator('#notice').innerText()).includes('Payment delivered: 3 DUBYT'));assert.equal(await p.locator('#notice').getAttribute('data-kind'),'delivered');
  assert.equal((await p.locator('#workspace-tools').boundingBox()).y,deliveryTop.y);
  await p.evaluate(()=>{selectTab('activity');paint({...lastStatus});});assert.equal(await p.locator('#notice').innerText(),'','delivery notice must not repeat');
  await p.evaluate(()=>{const q={pid:'d'.repeat(64),direction:'Sent',value:'2',status:'RESERVED'};paint({...lastStatus,error:null,payments:[q]});paint({...lastStatus,error:'Temporary verification failure',payments:[{...q,status:'SETTLED'}]});});
  assert(!(await p.locator('#notice').innerText()).includes('Payment delivered: 2'));
  await p.evaluate(()=>paint({...lastStatus,error:null}));assert((await p.locator('#notice').innerText()).includes('Payment delivered: 2 DUBYT'));
  await p.evaluate(()=>{selectTab('collateral');renderMyNodes({verifiedHeight:100,collateral:{remaining:'900',nodes:10,deposited:'900',withdrawn:'0'},nodes:[{id:'a'.repeat(64),kind:'home',display:{earned:'0.006571',paid:'0.006571',pending:'0'},alerts:[]},{id:'b'.repeat(64),kind:'server',display:{earned:'1.011165',paid:'1.011165',pending:'0'},alerts:[],collateral:{owned:true,display:{remaining:'90',support:'10',total:'100',deposited:'90',withdrawn:'0',consensus:'10',tasks:'0',capacity:'0'}}}]});});
  assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.screenshot({path:out+'/'+theme+'-'+width+'-nodes.png',fullPage:true});
  await p.emulateMedia({reducedMotion:'reduce'});assert.equal(await p.locator('#sync .connection-dot').evaluate(n=>getComputedStyle(n).animationName),'none');
  await p.screenshot({path:out+'/'+theme+'-'+width+'.png',fullPage:true});checks.push({theme,width,reviewDuringBackground:true,explicitConfirmation:true,networkFeatureGate:true,scheduledConfirmation:true,syntheticSendOnce:true});await p.close();
 }
 assert.deepEqual(errors,[]);assert.equal(sends,12);fs.writeFileSync(out+'/report.json',JSON.stringify({passed:true,exact84:!!process.argv[2],stableFeedback:true,receiptTypography:true,waitingIndicators:true,knownAndUncertainErrorsDistinct:true,productionTransfers:0,checks,quotes,sends,errors},null,2));console.log(JSON.stringify({checks:checks.length,quotes,sends,errors}));
}finally{await browser.close();server.close();}
