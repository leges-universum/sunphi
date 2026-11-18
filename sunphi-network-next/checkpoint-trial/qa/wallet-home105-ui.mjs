// Browser checks use an isolated wallet and only local response fixtures.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const {chromium}=await import(process.env.DUEBYTE_PLAYWRIGHT_MODULE || pathToFileURL('C:/Users/Leges Universum/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const root=resolve(process.argv[3] || resolve(import.meta.dirname,'..')),out=process.argv[2],checks=[];
if(out)mkdirSync(out,{recursive:true});
const browser=await chromium.launch();
try{
 for(const mode of ['light','graphite'])for(const width of [360,768,1440]){
  const locale=({360:'ru-RU',768:'de-DE',1440:'ja-JP'})[width];
  const page=await browser.newPage({locale,reducedMotion:"reduce",viewport:{width,height:920}});
  const errors=[],changes=[];
  const state={locked:false,working:false,hasVault:true,activeWallet:'fixture',wallets:[{id:'fixture',name:'Test wallet'}],
   owner:'A'.repeat(43),height:100,unitScale:'1000000',network:'local',checkedAt:Date.now(),
   analytics:{scope:'owner',height:100,appHeight:99,blockHash:'a'.repeat(64),checkpoint:'b'.repeat(64),settled:0,volume:'0',reserved:0,unitScale:'1000000',display:{volume:'0'}},
   balance:{available:'0',reserved:'0',protected:'0',scheduled:'0'},payments:[],features:{}};
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   assert.equal(url.hostname,'127.0.0.1');
   if(url.pathname==='/')return route.fulfill({body:readFileSync(join(root,'wallet.html')),contentType:'text/html'});
   if(url.pathname==='/activity-plots.js')return route.fulfill({path:join(root,'activity-plots.js'),contentType:'text/javascript'});
   if(url.pathname.startsWith('/brand/')){
    const name=url.pathname.slice(7);assert.match(name,/^[\w.-]+$/);
    return route.fulfill({path:join(root,'../desktop/brand',name)});
   }
   if(url.pathname==='/change-password'){const data=route.request().postDataJSON();changes.push(data);return route.fulfill({json:{changed:true}});}
   if(url.pathname==='/broker/availability')return route.fulfill({json:{configured:false,providers:[]}});
   if(url.pathname==='/broker/status')return route.fulfill({json:{provider:'partner',orders:[],offset:0,hasMore:false}});
   if(url.pathname==='/broker/review'){
    const {request}=route.request().postDataJSON();
    return route.fulfill({json:{provider:'partner',state:'REVIEW',review:{id:'test',expiresAt:Date.now()+30000,kind:'swap',terms:{
     ...request,from:{symbol:request.from,network:request.fromNetwork,amount:request.amount},to:{symbol:request.to,network:request.toNetwork,amount:'0.75'},
     depositFee:'0',depositFeeSymbol:request.from,withdrawalFee:'0.01',withdrawalFeeSymbol:request.to
    }}}});
   }
   if(url.pathname==='/external/prices')return route.fulfill({json:{prices:[{asset:'USDC',price:'0.9997',source:'Kraken spot',quotedAt:1750000000000,status:'stale'}]}});
   if(url.pathname==='/external/receipt'){
    assert.deepEqual(route.request().postDataJSON(),{route:'usdt-ethereum',txid:'0x'+'b'.repeat(64),address:'0x'+'c'.repeat(40)});
    return route.fulfill({json:{asset:'USDT',network:'Ethereum',source:'PublicNode',status:'confirmed',received:'1.25',checkedAt:1750000000000}});
   }
   return route.fulfill({json:url.pathname==='/status'?state:{}});
  });
  await page.goto('http://127.0.0.1:21800/');await page.locator('#funds').waitFor();
  assert.equal(await page.evaluate(()=>navigator.language),locale);
  const picker=page.locator('.file-picker').filter({has:page.locator('#restore-file')});
  assert.equal(await picker.locator('.file-picker-name').textContent(),'No file selected');
  await page.locator('#restore-file').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from('{}')});
  assert.equal(await picker.locator('.file-picker-name').textContent(),'backup.json');
  await page.evaluate(()=>clearPickedFile('restore-file'));
  assert.equal(await picker.locator('.file-picker-name').textContent(),'No file selected');
  await page.evaluate(t=>theme(t),mode);
  const tabs=await page.locator('nav [data-tab]').evaluateAll(nodes=>nodes.map(n=>n.dataset.tab));assert.equal(tabs.length,9);assert(tabs.includes('external'));
  await page.locator('[data-tab=external]').click();
  await page.locator('#external-prices tr').waitFor();
  assert.match(await page.locator('#external-prices').innerText(),/0\.9997/);
  assert.match(await page.locator('#external-prices').innerText(),/Kraken spot.*UTC.*Older than 5 min/);
  await page.locator('#external-route-picker').click();
  await page.locator('#external-route-options').getByText('USDT · Ethereum').click();
  await page.locator('#external-check').click();
  const fieldError=page.locator('#external-lookup-field-error');
  assert.equal(await fieldError.innerText(),'Enter the transaction ID.');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'external-tx');
  await page.locator('#external-tx').fill('0x'+'b'.repeat(64));
  await page.locator('#external-tx').press('Enter');
  assert.equal(await fieldError.innerText(),'Enter the expected receiving address.');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'external-address');
  await page.locator('#external-address').fill('0x'+'c'.repeat(40));
  assert.equal(await fieldError.count(),0);
  await page.locator('#external-check').click();
  await page.waitForFunction(()=>document.querySelector('#external-result').textContent.includes('Confirmed'));
  assert.match(await page.locator('#external-result').innerText(),/1\.25 USDT · Ethereum · Finalized · PublicNode/);
  await page.locator('#external-tx').fill('');assert.equal(await page.locator('#external-result').innerText(),'');
  assert.equal(await page.locator("#exchange-external-pair").count(),0);
  for(const tab of tabs){
   await page.evaluate(name=>selectTab(name),tab);
   const problems=await page.evaluate(async name=>{
    const screen=document.querySelector('.screen[data-screen="'+name+'"]'),issues=[];
    for(const details of screen.querySelectorAll("details"))details.open=true;
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    for(const child of screen.querySelectorAll('section>h2, section>.hint:last-child,.panel-head,.panel-body,.panel-band,.section-help,#empty-payments')){
     if(!child.getClientRects().length)continue;
     const card=child.closest('section, details');if(!card)continue;
     const r=child.getBoundingClientRect(),b=card.getBoundingClientRect();
     if(r.left<b.left-0.5||r.right>b.right+0.5||r.bottom>b.bottom+0.5)issues.push((child.id||child.className||child.textContent)+' in '+(card.id||card.className||card.tagName)+' x='+[r.left,r.right,b.left,b.right].map(Math.round)+' bottom='+[r.bottom,b.bottom].map(Math.round));
    }
    if(document.documentElement.scrollWidth>innerWidth)issues.push('page width');
    return issues;
   },tab);
   assert.deepEqual(problems,[],mode+' '+width+' '+tab+': '+problems.join(', '));
  }
  await page.locator('#open-password-change').click();
  await page.locator('#old-secret').fill('fixture-old-password');
  await page.locator('#new-secret').fill('short');
  await page.locator('#save-password').click();
  assert.equal(await page.locator('#password-change-form-field-error').innerText(),'Enter at least 12 characters.');
  assert.equal(changes.length,0);
  await page.locator('#new-secret').fill('fixture-new-password');
  await page.locator('#repeat-secret').fill('different-password');
  await page.locator('#save-password').click();assert.match(await page.locator('#password-error').innerText(),/do not match/);
  assert.equal(changes.length,0);await page.locator('#cancel-password').click();
  await page.locator('#open-password-change').click();assert.equal(await page.locator('#old-secret').inputValue(),'');
  await page.locator('#old-secret').fill('fixture-old-password');await page.locator('#new-secret').fill('fixture-new-password');
  await page.locator('#repeat-secret').fill('fixture-new-password');await page.locator('#save-password').click();
  await page.locator('#password-dialog').waitFor({state:'hidden'});assert.equal(changes.length,1);assert.equal(changes[0].walletId,'fixture');
  if(out&&width!==768)await page.locator('[data-screen=security]').screenshot({path:join(out,mode+'-'+width+'-security.png')});
  state.nodeActivity={visible:true,mode:'verification',revision:20,points:Array.from({length:7},(_,i)=>({at:Date.now()-(6-i)*15000,elapsed:15000,generations:i,rate:4*i,average:i>=4?4*(i-2):null,incoming:i,outgoing:i/2}))};
  const result=await page.evaluate(data=>{
   selectTab('network');
   historySample({...lastStatus,nodeActivity:data});
   return {rate:$('block-rate').textContent,average:$('block-average').textContent,traffic:$('transfer-rate').textContent,
    bars:$('history-chart').querySelectorAll('rect').length,trend:$('average-chart').querySelectorAll('.chart-point').length,
    smooth:[...$('wallet-traffic').querySelectorAll('path')].every(p=>p.getAttribute('d').includes('C')),
    trafficLines:$('wallet-traffic').querySelectorAll('path').length};
  },state.nodeActivity);
  assert.deepEqual(result,{rate:'24 blocks/min',average:'16 blocks/min',traffic:'6 ↓ / 3 ↑ KiB/s',bars:7,trend:3,smooth:true,trafficLines:2});
  const metrics=page.locator('#network-metrics');
  for(const label of ['Confirmed payments','Confirmed volume','Your reserved payments']){
   assert.equal(await metrics.getByRole('row',{name:new RegExp(label,'i')}).locator('td').first().innerText(),'0');
  }
  assert.doesNotMatch(await page.locator('[data-screen="network"]').textContent(),/Worker records|Released reservations/i);
  const bars=await page.locator('#history-chart').boundingBox(),line=await page.locator('#average-chart').boundingBox();
  assert.deepEqual(await page.locator('#verification-activity .chart-unit').allTextContents(),['blocks/min','blocks/min','KiB/s']);
  assert(bars&&line&&bars.y+bars.height<=line.y,'separate plots, bars first');
  if(out&&width!==768)await page.locator('#verification-activity').screenshot({path:join(out,mode+'-'+width+'-network.png')});
  assert.deepEqual(errors,[]);await page.close();checks.push({mode,width,locale,tabs,chart:result});console.log('PASS',mode,width,tabs.join(', '));
 }
 if(out)writeFileSync(join(out,'report.json'),JSON.stringify({passed:true,checks},null,2));
}finally{await browser.close();}
