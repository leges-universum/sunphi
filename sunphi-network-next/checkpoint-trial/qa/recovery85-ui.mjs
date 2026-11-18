import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Leges Universum/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const root=path.resolve(process.argv[2]||'..'),out=process.argv[3]||'F:/DueByteWork/recovery85/ui-source';fs.mkdirSync(out,{recursive:true});
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
const server=createServer((req,res)=>{try{const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));assert(file.startsWith(root+path.sep));res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));}catch{res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch(),checks=[],errors=[];
try{for(const theme of ['dark','light'])for(const width of [1440,390]){
 const page=await browser.newPage({viewport:{width,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(theme=>{const now=Date.now();window.qaState={configured:true,network:'qa',homeVerification:'bounded-verifier-v1',progress:'checking-history',walletReady:true,recoveryProgress:{phase:'checkpoint',height:0,target:0,startedAt:now,updatedAt:now},updates:{phase:'idle',current:'0.3.85'}};window.sunphiNode={request:async()=>({ok:true,value:window.qaState})};document.addEventListener('DOMContentLoaded',()=>document.documentElement.dataset.theme=theme);},theme);
 await page.goto('http://127.0.0.1:'+server.address().port+'/checkpoint-trial/consumer.html');await page.locator('#recovery-progress').waitFor();await page.evaluate(()=>document.fonts.ready);
 const positions=[];for(const phase of ['checkpoint','headers','state','retry']){
  await page.evaluate(phase=>{window.qaState.recoveryProgress={...window.qaState.recoveryProgress,phase,height:12345,target:12400,updatedAt:Date.now()};},phase);
  await page.waitForFunction(phase=>document.getElementById('status').textContent.includes({checkpoint:'Checking for',headers:'Verifying recent',state:'Checking balances',retry:'Reconnecting'}[phase]),phase);
  positions.push(await page.locator('.primary-controls').evaluate(n=>n.getBoundingClientRect().top));
  assert.equal(await page.locator('.recovery-track').evaluate(n=>getComputedStyle(n,'::after').animationName),'update-progress');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(phase==='headers'){assert.match(await page.locator('#recovery-detail').innerText(),/55 remaining/);await page.screenshot({path:out+'/'+theme+'-'+width+'.png',fullPage:true});}
 }
 assert(Math.max(...positions)-Math.min(...positions)<=1,'Waiting stages move controls: '+positions);
 await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.recovery-track').evaluate(n=>getComputedStyle(n,'::after').animationName),'none');
 await page.evaluate(()=>{const now=Date.now();window.qaState={...window.qaState,progress:'running',error:null,recoveryProgress:{...window.qaState.recoveryProgress,phase:'complete'},verification:{network:'qa',height:12401,appHeight:12400,blockHash:'a'.repeat(64),root:'b'.repeat(64),time:now}};});
 await page.waitForFunction(()=>document.getElementById('status').textContent==='Connected to the network');assert(await page.locator('#recovery-progress').isHidden());
 const connectedPosition=await page.locator('.primary-controls').evaluate(n=>n.getBoundingClientRect().top);assert(Math.abs(connectedPosition-positions[0])<=1,'Completion moves controls: '+JSON.stringify({width,positions,connectedPosition}));
 checks.push({theme,width,stableControls:true,progress:true,animation:true,reducedMotion:true,complete:true});await page.close();
}assert.deepEqual(errors,[]);fs.writeFileSync(out+'/report.json',JSON.stringify({passed:true,checks,errors,personalWindowAccess:false},null,2));console.log(JSON.stringify({passed:true,checks}));}finally{await browser.close();server.close();}
