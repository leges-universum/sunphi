// Isolated wallet fixture. Never opens the personal wallet or sends network funds.
import fs from 'node:fs';import path from 'node:path';import {createServer} from 'node:http';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';
import {parseToken,formatToken} from '../token-units.mjs';
const {chromium}=await import(process.env.DUEBYTE_PLAYWRIGHT_MODULE||pathToFileURL('C:/Users/Leges Universum/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const root=path.resolve(process.argv[2]||path.resolve(import.meta.dirname,'..')),out=process.argv[3]||'F:/DueByteWork/wallet89/ui';fs.mkdirSync(out,{recursive:true});
const server=createServer((q,r)=>r.end(fs.readFileSync(root+'/wallet.html')));await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port,browser=await chromium.launch(),checks=[],errors=[];
try{for(const [width,timezoneId,themeName]of [[1440,'UTC','graphite'],[360,'Europe/Kyiv','graphite'],[1440,'America/New_York','light']]){
 const ctx=await browser.newContext({viewport:{width,height:1000},timezoneId}),p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));
 await p.addInitScript(()=>{window.copied=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{if(window.copyFails)throw Error('Denied');window.copied.push(text);}}});});
 const owner='A'.repeat(43),state={locked:false,working:false,hasVault:true,activeWallet:'fixture',wallets:[{id:'fixture',name:'Fixture'}],owner,network:'Isolated fixture',unitScale:'1000000',checkedAt:Date.parse('2026-11-16T20:16:59Z'),height:100,balance:{available:'10000000',reserved:'0',protected:'0',scheduled:'0',display:{available:'10',reserved:'0',protected:'0',scheduled:'0'}},payments:[],features:{delayedPayments:true}};let quotes=[],sent=[];
 await p.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());if(u.origin!==origin)return route.abort();if(u.pathname==='/')return route.continue();
  if(/^\/brand\/[a-zA-Z0-9.-]+$/.test(u.pathname)){const name=u.pathname.slice(7);return route.fulfill({body:fs.readFileSync(root+'/../desktop/brand/'+name),contentType:name.endsWith('.css')?'text/css':name.endsWith('.woff2')?'font/woff2':name.endsWith('.svg')?'image/svg+xml':'image/png'});}
  let result={};if(u.pathname==='/status')result=state;
  else if(u.pathname==='/quote'){const q=req.postDataJSON();quotes.push(q);const value=parseToken(q.value,'1000000'),total=String(BigInt(value)+5000n);result={unitScale:'1000000',value,fee:'5000',abortFee:'500',total,display:{value:formatToken(value,'1000000'),fee:'0.005',abortFee:'0.0005',total:formatToken(total,'1000000')}};}
  else if(u.pathname==='/authorize-action')result={permit:'isolated-fixture'};
  else if(u.pathname==='/send'){sent.push(req.postDataJSON());result=state;}
  else if(u.pathname==='/broker/availability')result={enabled:false,providers:[]};
  return route.fulfill({json:result});
 });
 await p.goto(origin);await p.locator('#funds').waitFor();await p.evaluate(t=>theme(t),themeName);
 await p.locator('#copy-overview-address').click();assert.deepEqual(await p.evaluate(()=>copied),[owner]);
 await p.evaluate(()=>selectTab('receive'));await p.locator('#copy-address').click();assert.deepEqual(await p.evaluate(()=>copied),[owner,owner]);
 await p.evaluate(()=>copyFails=true);await p.locator('#copy-address').click();assert.match(await p.locator('#notice').innerText(),/copy it manually/);await p.evaluate(()=>copyFails=false);
 await p.evaluate(()=>selectTab('send'));await p.locator('#recipient').fill('B'.repeat(43));
 for(const [input,canonical]of [['0,6','0.6'],['0.6','0.6'],['0,000001','0.000001'],['1,234567','1.234567']]){
  await p.locator('#amount').fill(input);await p.locator('#send').click();await p.locator('#payment-review').waitFor();assert.equal(quotes.at(-1).value,canonical);assert((await p.locator('#review-amount').innerText()).includes(canonical+' DUBYT'));
  if(input==='0,6'){await p.screenshot({path:out+'/'+width+'-'+themeName+'-receipt.png'});await p.locator('#confirm-payment').click();await p.locator('#payment-review').waitFor({state:'hidden'});assert.equal(sent.at(-1).value,'0.6');assert.equal(sent.at(-1).fee,'5000');await p.evaluate(()=>selectTab('send'));await p.locator('#recipient').fill('B'.repeat(43));}
  else await p.locator('#cancel-payment').click();
 }
 const count=quotes.length;for(const input of ['1,234.5','1.234,5','1,2,3','0,0000001','1e3','-0,6','01,2']){await p.locator('#amount').fill(input);await p.locator('#send').click();await p.waitForFunction(()=>document.getElementById('message').textContent.includes('decimal places'));assert.equal(quotes.length,count);assert(await p.locator('#payment-review').isHidden());}
 await p.evaluate(()=>selectTab('overview'));assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.locator('#owner').locator('..').screenshot({path:out+'/'+width+'-'+themeName+'-overview.png'});
 checks.push({width,timezoneId,theme:themeName,commaAndDot:true,microUnit:true,invalidInputRejected:true,copyBothViews:true,clipboardDenied:true,canonicalSend:true});await ctx.close();
}assert.deepEqual(errors,[]);fs.writeFileSync(out+'/report.json',JSON.stringify({passed:true,checks,errors,productionTransfers:0},null,2));console.log('PASS 3 wallet cases: decimal input, exact review/send, clipboard and responsive layout');}
finally{await browser.close();server.close();}
