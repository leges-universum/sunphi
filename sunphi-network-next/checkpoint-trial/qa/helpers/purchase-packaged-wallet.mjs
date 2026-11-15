// Real wallet HTTP process and encrypted synthetic wallet; no operational home.
import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {fork} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {hash} from '../../crypto.mjs';
import {seal} from '../../vault.mjs';
import {CHECKPOINT} from '../../checkpoint.mjs';
import {until} from './purchase-comet-network.mjs';
export async function packagedWallet({home,config,key,trust,url}){
 assert(home.replaceAll('\\','/').startsWith('E:/DueByte-USB/purchase-api-custody-lab-'));fs.mkdirSync(home,{recursive:true});
 const password='synthetic-wallet-password-only',genesis=JSON.parse(fs.readFileSync(trust.genesisFile)),policy={domain:CHECKPOINT+'/POLICY',network:config.chainId,genesisHash:trust.genesisHash,...config.control.policy};
 assert(trust.walletTrust?.checkpoint&&trust.walletTrust?.bounded,'verified wallet fixture required');
 const docs={'app-config':config,genesis,'trust-policy':policy,connections:{rpc:trust.historyUrl,workers:{}},checkpoint:trust.walletTrust.checkpoint,'indexed-wallet':{bounded:trust.walletTrust.bounded},'purchase-lab-profile':{configHash:hash(config),url,genesisHash:trust.genesisHash,anchor:trust.anchor}};
 for(const [n,v] of Object.entries(docs))fs.writeFileSync(join(home,n+'.json'),JSON.stringify(v));
 const vault=join(home,'wallet.encrypted.json');if(!fs.existsSync(vault))fs.writeFileSync(vault,JSON.stringify(seal(key,password)),{flag:'wx'});
 const fd=fs.openSync(join(home,'process.log'),'a'),child=fork(resolve(import.meta.dirname,'../../wallet-server.mjs'),[home,'30651',hash(policy),trust.historyUrl],{windowsHide:true,execArgv:[],stdio:['ignore',fd,fd,'ipc']});fs.closeSync(fd);
 const token=randomBytes(32).toString('hex'),base='http://127.0.0.1:30651';
 const call=async(path,data,capability=token)=>{const r=await fetch(base+path,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json','x-duebyte-token':capability},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(90000)});const b=await r.json();assert(r.ok,b.error??'wallet request failed');return b;};
 let browser,page;const close=async()=>{await browser?.close();if(child.exitCode!==null)return;const exit=new Promise(r=>child.once('exit',r));child.kill();await exit;};
 try{
  await until(async()=>{assert.equal(child.exitCode,null,'wallet process exited');await call('/status');},15000);
  assert((await(await fetch(base)).text()).includes('purchase-refund'));
  await call('/unlock',{password});await until(async()=>assert(!(await call('/status')).working));
  await until(async()=>{const s=await call('/status');assert(s.checkedAt&&!s.error,s.error??'wallet not verified');});
  await assert.rejects(()=>call('/purchase/availability',{},randomBytes(32).toString('hex')));
  const {chromium}=await import(pathToFileURL('C:/Users/Leges Universum/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
  browser=await chromium.launch();page=await browser.newPage({viewport:{width:1280,height:1000}});await page.addInitScript(t=>sessionStorage.setItem('duebyte-session',t),token);
  await page.goto(base);await page.locator('#funds').waitFor();await page.locator('[data-tab=exchange]').click();
  await page.waitForFunction(()=>!purchaseBusy&&purchaseAvailable,{},{timeout:90000});
  const handle=async(action,payload)=>{
   await until(async()=>assert(!(await call('/status')).working));
   if(action==='quote'){
    if(await page.locator('#purchase-result').isVisible()){await page.locator('#purchase-back').waitFor({timeout:90000});await page.locator('#purchase-back').click();}
    await page.locator('#purchase-form').waitFor();await page.locator('#purchase-methods [data-route='+payload.route+']').click();await page.locator('#purchase-amount').fill(payload.amount);await page.locator('#purchase-refund').fill(payload.refundDestination);
    await page.locator('#purchase-prepare').click();await page.waitForFunction(()=>purchaseDraft!==null);assert(await page.locator('#purchase-address').isHidden());
    await page.screenshot({path:join(home,payload.route+'-review.png')});return page.evaluate(()=>purchaseDraft);
   }
   if(action==='accept'){
    await page.locator('#purchase-confirm').click();await page.waitForFunction(id=>purchaseOrder?.id===id,payload.id,{timeout:90000});await page.locator('#purchase-address').waitFor();
    await page.screenshot({path:join(home,'committed-order.png')});return page.evaluate(()=>purchaseOrder);
   }
   if(['order','availability'].includes(action))return until(async()=>{await page.waitForFunction(()=>!purchaseBusy);const s=await call('/status');assert(!s.working&&!s.error&&s.checkedAt);return call('/purchase/'+action,payload);});
   return call('/purchase/'+(action==='accept-api'?'accept':action),payload);
  };
  return {base,token,status:()=>call('/status'),handle,close};
 }catch(e){await close();throw e;}
}
