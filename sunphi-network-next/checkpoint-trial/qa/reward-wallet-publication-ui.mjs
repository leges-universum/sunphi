// Isolated Home renderer; synthetic public metadata, no personal wallet access.
import {createServer} from 'node:http';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,extname,sep,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL('C:/Users/Leges Universum/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const root=resolve(process.argv[3]??resolve(import.meta.dirname,'../..')),out=resolve(process.argv[2]??'F:/DueByteWork/reward-wallet-publication-20261115');mkdirSync(out,{recursive:true});
const server=createServer((req,res)=>{try{const file=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://local').pathname));assert(file.startsWith(root+sep));res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'})[extname(file)]??'application/octet-stream');res.end(readFileSync(file));}catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true}),errors=[],results=[];
try{
 for(const theme of ['dark','light'])for(const width of [1180,390]){
  const page=await browser.newPage({viewport:{width,height:1000}});page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(({theme})=>{
   window.qaState={configured:true,progress:'running',network:'isolated-test',walletReady:true,rpc:{chain:'isolated-test',height:'0',time:'1970-01-01T00:00:00Z',votingPower:'0',peers:2,catchingUp:true},rewards:null,rewardWallets:[]};window.qaCalls=[];
   window.sunphiNode={request:async(action,args)=>{window.qaCalls.push({action,args});if(action==='reward-wallets')for(const w of window.qaState.rewardWallets)w.rewardsSelected=args.ids.includes(w.id);return {ok:true,value:window.qaState};}};
   document.addEventListener('DOMContentLoaded',()=>document.documentElement.dataset.theme=theme);
  },{theme});
  await page.goto(`http://127.0.0.1:${server.address().port}/checkpoint-trial/consumer.html`);
  await page.locator('.reward-empty').waitFor();assert.equal(await page.locator('#history-time').innerText(),'—');
  await page.evaluate(()=>qaState.rewardWallets=[{id:'original',name:'Original wallet',owner:null,rewardsReady:false,rewardsSelected:false}]);
  const first=page.locator('.reward-wallet-row input').first();await first.waitFor();assert(await first.isDisabled());assert.match(await page.locator('.reward-wallet-row').innerText(),/Open once/);
  await page.evaluate(()=>Object.assign(qaState.rewardWallets[0],{owner:'SyntheticPublicWalletAddress0000000001',rewardsReady:true,rewardsSelected:true}));
  await page.waitForFunction(()=>document.querySelector('.reward-wallet-row input')?.checked);assert(await first.isEnabled());
  assert.match(await page.locator('#reward-status').innerText(),/Saved reward wallets/);assert.equal(await page.locator('#node-earnings').innerText(),'Waiting for verified reward accounting.');assert.equal(await page.locator('#save-reward-wallets').isVisible(),false);
  await page.locator('#reward-wallet-panel').screenshot({path:join(out,`${theme}-${width}.png`)});
  await page.evaluate(()=>qaState.rewardWallets.push({id:'second',name:'Restored wallet',owner:'SyntheticPublicWalletAddress0000000002',rewardsReady:true,rewardsSelected:false}));
  await page.waitForFunction(()=>document.querySelectorAll('.reward-wallet-row').length===2);
  await page.locator('.reward-wallet-row input').last().check();await first.uncheck();await page.locator('#save-reward-wallets').click();
  await page.waitForFunction(()=>qaCalls.some(c=>c.action==='reward-wallets'));
  assert.deepEqual(await page.evaluate(()=>qaCalls.find(c=>c.action==='reward-wallets').args.ids),['second']);assert(await page.locator('.reward-wallet-row input').last().isChecked());
  assert.equal(await page.locator('#history-time').innerText(),'—');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  results.push({theme,width,disabledBeforeConsent:true,checkedAfterUnlock:true,selectionSaved:true,unverifiedRewardsNotInvented:true});await page.close();
 }
 assert.deepEqual(errors,[]);writeFileSync(join(out,'report.json'),JSON.stringify({passed:true,at:new Date().toISOString(),results,errors},null,2));console.log(JSON.stringify({passed:true,layouts:results.length,output:out}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
