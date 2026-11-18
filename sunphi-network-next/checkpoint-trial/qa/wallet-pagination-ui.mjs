// Synthetic local UI fixtures. No real wallet, network or spending authority.
import fs from 'node:fs';
import path from 'node:path';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL('C:/Users/Leges Universum/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const root=path.resolve(process.argv[2]??path.resolve(import.meta.dirname,'..')),out=process.argv[3]??'F:/DueByteWork/wallet-sender/pagination';fs.mkdirSync(out,{recursive:true});
const errors=[],checks=[];let count=37,fail=false,requests=0;
const row=n=>({pid:String(n).padStart(64,'0'),status:'SETTLED',direction:'Received',sender:'b'.repeat(43),value:'1234567',unitScale:'1000000',display:{value:'1.234567'}});
const history=(offset,limit,through=null)=>{const total=through??count;assert(total<=count&&offset<=total);return {offset,total,available:count,rows:Array.from({length:Math.min(limit,total-offset)},(_,n)=>row(total-1-offset-n))};};
const state=()=>({locked:false,hasVault:true,working:false,checkedAt:Date.now(),error:null,network:'Isolated UI fixture',height:100,owner:'a'.repeat(43),wallets:[{id:'qa',name:'QA wallet'}],activeWallet:'qa',selectedWallet:'qa',unitScale:'1000000',balance:{available:'1234567',reserved:'0',scheduled:'0',protected:'0',display:{available:'1.234567',reserved:'0',scheduled:'0',protected:'0'}},payments:[{pid:'local-draft',status:'QUEUED',direction:'Sent',value:'1000000',unitScale:'1000000',display:{value:'1'}}],indexedHistory:history(0,32),features:{},analytics:null});
const server=createServer(async(req,res)=>{try{
 res.setHeader('Cache-Control','no-store');
 if(req.url==='/status'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(state()));}
 if(req.url==='/history'){let body='';for await(const part of req)body+=part;const q=JSON.parse(body);requests++;assert.equal(q.limit,5);await new Promise(r=>setTimeout(r,350));if(fail){fail=false;throw Error('Verification temporarily unavailable.');}res.setHeader('content-type','application/json');return res.end(JSON.stringify(history(q.offset,q.limit,q.through)));}
 const name=new URL(req.url,'http://localhost').pathname;assert(!name.includes('..'));const file=name==='/'?path.join(root,'wallet.html'):name.startsWith('/brand/')?path.join(root,'../desktop',name):null;assert(file);
 res.setHeader('content-type',file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.woff2')?'font/woff2':'text/html');res.end(fs.readFileSync(file));
 }catch(e){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message}));}});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const browser=await chromium.launch();
try{
 for(const mode of ['graphite','light'])for(const width of [1180,390,320]){
  count=37;const page=await browser.newPage({viewport:{width,height:1000}});page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('#funds').waitFor();await page.evaluate(mode=>{theme(mode);selectTab('activity');},mode);
  assert.equal(await page.locator('#payments > li').count(),5);assert((await page.locator('#history-range').innerText()).includes('of 37'));assert((await page.locator('#payments').innerText()).includes('1.234567 DUBYT'));assert((await page.locator('main').innerText()).includes('local-draft'));
  await page.locator('#history-pagination-top').getByRole('button',{name:'Next history page',exact:true}).click();await page.waitForFunction(()=>historyPage===2&&!historyBusy);const before=await page.locator('#payments').innerText();count=40;await page.evaluate(s=>paint(s),state());assert.equal(await page.locator('#payments').innerText(),before);assert((await page.locator('#history-refresh').innerText()).startsWith('3 new'));
  fail=true;await page.locator('#history-pagination-top').getByRole('button',{name:'Next history page',exact:true}).click();await page.waitForFunction(()=>!historyBusy);assert.equal(await page.locator('#payments').innerText(),before);await page.evaluate(s=>paint(s),state());assert((await page.locator('#message').innerText()).includes('Verification temporarily'));
  await page.locator('#history-pagination-top').getByRole('button',{name:'Next history page',exact:true}).click();await page.waitForFunction(()=>historyPage===3&&!historyBusy);assert((await page.locator('#history-range').innerText()).includes('of 37'));assert.equal(await page.locator('#message').innerText(),'');
  await page.locator('#history-refresh').click();await page.waitForFunction(()=>historyPage===1&&!historyBusy);assert((await page.locator('#history-range').innerText()).includes('of 40'));
  assert.equal(await page.locator('#history-range-top').innerText(),await page.locator('#history-range').innerText());
  const requestCount=requests;await page.locator('#history-pagination').getByRole('button',{name:'Next history page',exact:true}).click();
  await page.waitForFunction(()=>historyBusy);assert.equal(await page.locator('#history-pagination-top').getAttribute('aria-busy'),'true');assert(await page.locator('#history-pagination-top button').first().isDisabled());
  assert(await page.locator('#history-range-top').evaluate(n=>getComputedStyle(n,'::before').animationName!=='none'));
  await page.waitForFunction(()=>historyPage===2&&!historyBusy);assert.equal(requests,requestCount+1);
  if(width>600)await page.locator('#history-pagination-top').getByRole('button',{name:'History page 8',exact:true}).click();else for(let pageNumber=3;pageNumber<=8;pageNumber++){await page.locator('#history-pagination-top').getByRole('button',{name:'Next history page',exact:true}).click();await page.waitForFunction(n=>historyPage===n&&!historyBusy,pageNumber);}await page.waitForFunction(()=>historyPage===8&&!historyBusy);
  assert((await page.locator('#history-range').innerText()).includes('36–40 of 40'));assert(await page.locator('#history-pagination button').last().isDisabled());
  for(const n of [0,3]){count=n;await page.reload();await page.locator('#funds').waitFor();await page.evaluate(mode=>{theme(mode);selectTab('activity');},mode);
    assert.equal(await page.locator('#payments > li').count(),n);assert(await page.locator('#history-pagination-top').isVisible());assert(await page.locator('#history-pagination button').last().isDisabled());assert.equal(await page.locator('#history-pagination .history-page-summary').textContent(),'Page 1 of 1');
  }
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(out,mode+'-'+width+'.png')});checks.push({mode,width,pages:true,stableOnNewArrival:true,failedReadRetainsPage:true});await page.close();
 }
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,synthetic:true},null,2));console.log(JSON.stringify({checks:checks.length,errors}));
}finally{await browser.close();server.closeAllConnections();await new Promise(ok=>server.close(ok));}
