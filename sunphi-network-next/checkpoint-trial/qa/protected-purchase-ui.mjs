import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
import {startPurchaseLab} from './protected-purchase-lab.mjs';import {orderId} from '../research/purchase-contract.mjs';
const out=process.argv[2];assert(out&&!fs.existsSync(out));fs.mkdirSync(out,{recursive:true});
const temp=path.join(out,'browser-temp');fs.mkdirSync(temp);process.env.TEMP=temp;process.env.TMP=temp;
const {chromium}=await import(pathToFileURL('C:/Users/Leges Universum/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const lab=await startPurchaseLab(path.join(out,'ledger'),process.argv[3]?{root:path.resolve(process.argv[3])}:{}),browser=await chromium.launch(),errors=[],checks=[];
try{
 for(const themeName of ['graphite','light'])for(const width of [1180,390]){
  lab.resetSession();const page=await browser.newPage({viewport:{width,height:1050}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(lab.url);await page.locator('#funds').waitFor();await page.evaluate(t=>theme(t),themeName);
  lab.setAvailable(false);await page.locator('[data-tab=exchange]').click();await page.waitForFunction(()=>document.getElementById('purchase-status').textContent.includes('No connected seller'));
  assert(await page.locator('#purchase-form').isHidden());assert.equal(await page.locator('#purchase-currency,#purchase-counterparty,#purchase-fiat').count(),0);
  lab.setAvailable(true);await page.locator('#purchase-refresh').click();await page.locator('#purchase-form').waitFor();
  for(const route of ['BTC','USDC']){
   await page.locator('#purchase-methods [data-route='+route+']').click();await page.locator('#purchase-amount').fill('10');
   await page.locator('#purchase-refund').fill(route==='BTC'?'bcrt1qtestonlyrefundaddress':'0x1111111111111111111111111111111111111111');
   await page.locator('#purchase-prepare').click();await page.locator('#purchase-result').waitFor();
   assert(await page.locator('#purchase-address').isHidden());assert.equal(Object.values(lab.current().orders).filter(o=>o.status==='AWAITING_PAYMENT').length,0);
   assert((await page.locator('#purchase-summary').innerText()).includes('10 DUBYT'));
   await page.screenshot({path:path.join(out,themeName+'-'+width+'-'+route+'-review.png')});
   await page.locator('#purchase-confirm').click();await page.locator('#purchase-address').waitFor();const id=orderId(lab.active.offer);
   assert.equal(lab.current().orders[id].status,'AWAITING_PAYMENT');
   lab.disconnect(2);lab.outage(true);await page.waitForFunction(()=>document.getElementById('purchase-status').textContent.includes('Connection interrupted'));
   lab.outage(false);lab.payment({confirmations:1});await page.waitForFunction(()=>document.getElementById('purchase-heading').textContent==='Confirming payment');
   assert(await page.locator('#purchase-address').isHidden());
   await page.reload();await page.locator('#funds').waitFor();await page.locator('[data-tab=exchange]').click();await page.waitForFunction(()=>document.getElementById('purchase-heading').textContent==='Confirming payment');
   lab.payment();lab.reconnect(2);await page.waitForFunction(()=>document.getElementById('purchase-heading').textContent==='DUBYT received');
   assert.equal(lab.current().orders[id].status,'COMPLETED');assert.equal(new Set(lab.stores.map(s=>s.root)).size,1);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   checks.push({theme:themeName,width,route,noPaymentBeforeReserve:true,reloadRetainsOrder:true,outageRetainsOrder:true,replicaReplay:true,completed:true});
   await page.locator('#purchase-back').click();await page.locator('#purchase-form').waitFor();lab.next();
  }
  await page.evaluate(()=>showPurchase({status:'AWAITING_PAYMENT',statusLabel:'Waiting for payment',payUntil:1,destination:'must-not-be-shown',payTotal:'1',dubyt:'1',route:'BTC',fee:'0',feeNote:'',seller:'Test',terms:'',paymentNetwork:'regtest',message:''},true));
  assert(await page.locator('#purchase-address').isHidden());assert((await page.locator('#purchase-status').innerText()).includes('Do not send'));
  await page.locator('#purchase-refresh').click();await page.locator('#purchase-form').waitFor();
  // A delayed quote cannot reappear after locking or changing the wallet.
  let release,started;const held=new Promise(r=>release=r),begun=new Promise(r=>started=r);
  await page.route('**/purchase/quote',async route=>{const response=await route.fetch();started();await held;await route.fulfill({response});});
  await page.locator('#purchase-amount').fill('1');await page.locator('#purchase-refund').fill('0x1111111111111111111111111111111111111111');await page.locator('#purchase-prepare').click();await Promise.race([begun,new Promise((_,reject)=>setTimeout(()=>reject(Error('quote interception timeout')),10000))]);
  await page.evaluate(()=>{token=newSession();paint({...lastStatus,locked:true});});release();await page.waitForFunction(()=>!purchaseBusy);
  assert(await page.locator('#purchase-result').isHidden());await page.close();
 }
 assert.deepEqual(errors,[]);assert.equal(lab.current().balances[lab.f.buyer.publicKey],'80000000');assert.equal(lab.current().supplyMicro,'100000000');
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({isolated:true,externalEvidence:'synthetic signed attestations',consensus:'native bounded interpreter, single coordinator with replay replicas; CometBFT qualified separately',checks,errors,root:lab.stores[0].root,commands:lab.commands.length,balancesPreserved:true,issuance:false},null,2));
 console.log(JSON.stringify({passed:true,checks:checks.length,errors,commands:lab.commands.length,out}));
}finally{await browser.close();await lab.close();}
