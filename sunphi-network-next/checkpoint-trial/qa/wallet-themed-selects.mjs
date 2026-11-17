// Actual wallet + brand styles, isolated responses. No personal wallet or funds.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
const root=path.resolve(process.argv[2]||path.resolve(import.meta.dirname,'..')),out=process.argv[3]||'D:/CodexData/DueByteWork/wallet-themed-selects-20261117';fs.mkdirSync(out,{recursive:true});
const {chromium}=await import(pathToFileURL('C:/Users/Leges Universum/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const browser=await chromium.launch(),checks=[],errors=[];
try{for(const themeName of ['graphite','light'])for(const width of [1440,390]){
 const p=await browser.newPage({viewport:{width,height:900}});p.on('pageerror',e=>errors.push(e.message));
 const state={locked:false,working:false,hasVault:true,activeWallet:'fixture',selectedWallet:'fixture',wallets:[{id:'fixture',name:'Fixture'}],owner:'A'.repeat(43),network:'Isolated fixture',unitScale:'1000000',checkedAt:Date.parse('2026-11-17T12:00:00Z'),height:100,balance:{available:'10000000',reserved:'0',protected:'0',scheduled:'0',display:{available:'10',reserved:'0',protected:'0',scheduled:'0'}},payments:[],features:{delayedPayments:true}};
 await p.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!=='http://127.0.0.1:41238')return route.abort();if(u.pathname==='/')return route.fulfill({body:fs.readFileSync(root+'/wallet.html'),contentType:'text/html'});if(/^\/brand\/[a-zA-Z0-9.-]+$/.test(u.pathname)){const n=u.pathname.slice(7);return route.fulfill({body:fs.readFileSync(root+'/../desktop/brand/'+n),contentType:n.endsWith('.css')?'text/css':n.endsWith('.svg')?'image/svg+xml':n.endsWith('.woff2')?'font/woff2':'image/png'});}return route.fulfill({json:u.pathname==='/status'?state:u.pathname==='/broker/availability'?{enabled:false,providers:[]}:{}});});
 await p.goto('http://127.0.0.1:41238');await p.locator('#funds').waitFor();await p.evaluate(t=>{theme(t);selectTab('exchange');},themeName);
 const picker=p.locator('#exchange-currency-picker'),menu=p.locator('#exchange-currency-options');await picker.click();await menu.waitFor({state:'visible'});
 assert.equal(await menu.getByRole('option',{selected:true}).innerText(),'Bitcoin · BTC');
 await p.screenshot({path:out+'/'+themeName+'-'+width+'.png'});
 await p.keyboard.press('End');await p.keyboard.press('Enter');assert.equal(await p.locator('#exchange-currency').inputValue(),'XMR');assert(await menu.isHidden());assert.match(await picker.innerText(),/Monero/);
 await picker.press('ArrowDown');await p.keyboard.press('Home');await p.keyboard.press('ArrowDown');await p.keyboard.press('Enter');assert.equal(await p.locator('#exchange-currency').inputValue(),'USDC');assert.match(await p.locator('#exchange-summary').innerText(),/USDC/);
 await picker.click();await p.keyboard.press('b');await p.keyboard.press('Enter');assert.equal(await p.locator('#exchange-currency').inputValue(),'BTC');
 await picker.click();await p.keyboard.press('End');await p.keyboard.press('Escape');assert.equal(await p.locator('#exchange-currency').inputValue(),'BTC');assert(await picker.evaluate(e=>e===document.activeElement));
 await picker.click();await p.keyboard.press('Tab');assert(await menu.isHidden());assert(!await picker.evaluate(e=>e===document.activeElement));
 await picker.click();await p.locator('h1').last().click({force:true});assert(await menu.isHidden());
 // Native form contract: programmatic changes + dynamic options and busy state.
 // Check after the select observer runs, before the next asynchronous quote refresh.
 assert(await p.evaluate(async()=>{const s=document.getElementById('exchange-currency');s.disabled=true;await Promise.resolve();return document.getElementById('exchange-currency-picker').disabled;}));
 await p.evaluate(()=>{const s=document.getElementById('exchange-currency');s.disabled=false;s.value='USDT';s.dispatchEvent(new Event('change',{bubbles:true}));});await p.waitForFunction(()=>document.getElementById('exchange-currency-picker').textContent.includes('USDT'));
 await p.waitForFunction(()=>pendingOperations.size===0);
 await p.evaluate(()=>{const s=document.getElementById('broker-destination');document.getElementById('exchange-chooser').append(document.getElementById('broker-withdraw'));document.getElementById('broker-withdraw').hidden=false;s.replaceChildren(...Array.from({length:20},(_,i)=>new Option('Ethereum · 0x'+String(i).padStart(40,'0'),String(i))));s.disabled=false;});
 const dest=p.locator('#broker-destination-picker');await dest.click();await p.keyboard.press('End');await p.keyboard.press('Enter');assert.equal(await p.locator('#broker-destination').inputValue(),'19');
 await dest.click();const box=await p.locator('#broker-destination-options').boundingBox();assert(box.x>=0&&box.y>=0&&box.x+box.width<=width+1&&box.y+box.height<=901);
 await p.keyboard.press('Escape');assert(await p.evaluate(()=>document.querySelector('main').scrollWidth<=document.querySelector('main').clientWidth+1));
 checks.push({theme:themeName,width,keyboard:true,typeahead:true,cancelAndTab:true,dynamicAddresses:true,disabledSync:true,boundedPopup:true});await p.close();
}assert.deepEqual(errors,[]);fs.writeFileSync(out+'/report.json',JSON.stringify({passed:true,checks,errors,productionWrites:false},null,2));console.log('PASS themed dropdowns: 4 theme/viewport cases');}finally{await browser.close();}
