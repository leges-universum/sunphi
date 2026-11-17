// Isolated visual fixture: no personal wallet, network accounts or transfers.
import fs from 'node:fs';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL('C:/Users/Leges Universum/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const root=process.argv[2]?pathToFileURL(process.argv[2].replaceAll('\\','/')+'/'):new URL('../',import.meta.url),out=process.argv[3]??'D:/CodexData/DueByteWork/wallet-assets96-ui';fs.mkdirSync(out,{recursive:true});
const server=createServer((q,r)=>r.end(fs.readFileSync(new URL('wallet.html',root))));await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port,browser=await chromium.launch(),checks=[],errors=[];
try{for(const width of [360,768,1440])for(const name of ['graphite','light']){
 const ctx=await browser.newContext({viewport:{width,height:1000},timezoneId:'Asia/Tokyo'}),p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));
 const owner='A'.repeat(43),s={locked:false,working:false,hasVault:true,activeWallet:'fixture',wallets:[{id:'fixture',name:'Fixture'}],owner,network:'DueByte fixture',unitScale:'1000000',checkedAt:Date.parse('2026-11-16T20:16:59Z'),height:100,balance:{available:'1879998',reserved:'0',protected:'0',scheduled:'0',display:{available:'1.879998',reserved:'0',protected:'0',scheduled:'0'}},payments:[],features:{delayedPayments:true}};
 await p.addInitScript(()=>{window.copied=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>copied.push(text)}});});
 await p.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!==origin)return route.abort();if(u.pathname==='/')return route.continue();
  if(/^\/brand\/[a-zA-Z0-9.-]+$/.test(u.pathname))return route.fulfill({body:fs.readFileSync(new URL('../desktop'+u.pathname,root))});
  return route.fulfill({json:u.pathname==='/status'?s:u.pathname==='/broker/availability'?{enabled:false,providers:[]}:{}});
 });
 await p.goto(origin);await p.locator('#funds').waitFor();await p.evaluate(n=>theme(n),name);
 for(const muted of [false,true]){
  if(muted)await p.locator('#payment-sound').click();
  await p.mouse.move(1,1);await p.evaluate(()=>document.activeElement?.blur());
  const frames=await p.locator('header #theme,header #payment-sound').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {width:r.width,height:r.height,y:r.y,border:s.border,borderRadius:s.borderRadius,padding:s.padding};}));
  assert.equal(frames.length,2);assert.deepEqual(frames[0],frames[1]);
 }
 const rows=[{asset:'DUBYT',network:'duebyte-trial-fresh-20261109-v45',available:'1.879998',status:'verified',address:owner},{asset:'BTC',network:'Bitcoin',available:null,status:'loading'},{asset:'USDC',network:'Ethereum',available:null,status:'not-connected'},{asset:'USDT',network:'Ethereum',available:null,status:'not-connected'},{asset:'XMR',network:'Monero',available:null,status:'not-supported'}];
 await p.evaluate(r=>drawAssets(r),rows);
 assert.equal(await p.locator('tr[data-asset="DUBYT"] .asset-network').count(),0);
 assert.equal(await p.locator('tr[data-asset="USDC"] .asset-network').innerText(),'Ethereum');
 assert.equal(await p.locator('.assets-table tbody tr').count(),5);const colors=await p.locator('.assets-table tbody tr').evaluateAll(rs=>rs.map(r=>getComputedStyle(r).backgroundColor));assert.equal(colors[0],colors[2]);assert.equal(colors[1],colors[3]);assert.notEqual(colors[0],colors[1]);assert.equal(await p.locator('.balance-loading').count(),1);
 assert.equal(await p.locator('tr[data-asset="DUBYT"] .asset-value').innerText(),'1.879998');
 await p.getByRole('button',{name:'Copy DUBYT public address',exact:true}).click();assert.deepEqual(await p.evaluate(()=>copied),[owner]);
 assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const overflow=await p.locator('.assets-table').evaluate(t=>[...t.querySelectorAll('tbody td,tbody th')].filter(e=>e.getBoundingClientRect().width>0&&e.scrollWidth>e.clientWidth+1).map(e=>({class:e.className,text:e.textContent,width:e.clientWidth,scroll:e.scrollWidth})));assert.deepEqual(overflow,[]);
 await p.locator('#assets-panel').screenshot({path:out+'/'+width+'-'+name+'.png'});
 await p.emulateMedia({reducedMotion:'reduce'});assert.equal(await p.locator('.balance-loading').evaluate(e=>getComputedStyle(e).animationName),'none');
 await p.evaluate(r=>drawAssets(r.map(a=>({...a,status:a.status==='loading'?'unavailable':a.status}))),rows);assert.equal(await p.locator('.balance-loading').count(),0);
 checks.push({width,theme:name,rows:5,exactCopy:true,onlyActualLoadingAnimated:true,noOverflow:true,reducedMotion:true});await ctx.close();
}assert.deepEqual(errors,[]);fs.writeFileSync(out+'/report.json',JSON.stringify({passed:true,checks,errors},null,2));console.log('PASS 6 accounting-table layout cases, copy, loading and reduced-motion');}
finally{await browser.close();server.close();}


