// Actual Home wallet HTTP backend + rendered UI; synthetic vault only.
import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {fork} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {hash} from '../../crypto.mjs';
import {CHECKPOINT} from '../../checkpoint.mjs';
import {until} from './purchase-comet-network.mjs';
export async function homeSeller({home,config,trust,profile,bundle,password,journal,transport}){
 assert(home.replaceAll('\\','/').startsWith('E:/DueByte-USB/purchase-api-custody-lab-'));fs.mkdirSync(home,{recursive:true});
 const policy={domain:CHECKPOINT+'/POLICY',network:config.chainId,genesisHash:trust.genesisHash,...config.control.policy};
 const docs={'app-config':config,genesis:JSON.parse(fs.readFileSync(trust.genesisFile)),'trust-policy':policy,connections:{rpc:trust.historyUrl,workers:{}},checkpoint:trust.walletTrust.checkpoint,'indexed-wallet':{bounded:trust.walletTrust.bounded},'seller-home-profile':{profile,transport}};
 for(const [name,value]of Object.entries(docs))fs.writeFileSync(join(home,name+'.json'),JSON.stringify(value));
 if(!fs.existsSync(join(home,'wallet.encrypted.json')))fs.writeFileSync(join(home,'wallet.encrypted.json'),JSON.stringify(bundle),{flag:'wx'});
 if(!fs.existsSync(join(home,'seller-authorizations.sqlite')))fs.copyFileSync(journal,join(home,'seller-authorizations.sqlite'));
 const fd=fs.openSync(join(home,'home.log'),'a'),child=fork(resolve(import.meta.dirname,'../../wallet-server.mjs'),[home,'30652',hash(policy),trust.historyUrl],{windowsHide:true,execArgv:[],stdio:['ignore',fd,fd,'ipc']});fs.closeSync(fd);
 const token=randomBytes(32).toString('hex'),base='http://127.0.0.1:30652';let browser,page;
 const call=async(route,data,capability=token)=>{const r=await fetch(base+route,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Duebyte-Token':capability},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(15000)});const b=await r.json();assert(r.ok,b.error??'Home request failed');return b;};
 const close=async()=>{await browser?.close();if(child.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill();await done;};
 try{
  await until(()=>call('/status'),15000);await assert.rejects(()=>call('/seller/status',{}));await call('/unlock',{password});
  await until(async()=>{const s=await call('/status');assert(!s.working&&s.checkedAt&&!s.error);});
  await assert.rejects(()=>call('/seller/start',{profileHash:hash(profile)},randomBytes(32).toString('hex')));
  await assert.rejects(()=>call('/seller/start',{profileHash:hash(profile)}));assert.equal((await call('/seller/status',{})).enabled,false);
  const {chromium}=await import(pathToFileURL('C:/Users/Leges Universum/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
  browser=await chromium.launch();page=await browser.newPage({viewport:{width:1280,height:1050}});await page.addInitScript(t=>sessionStorage.setItem('duebyte-session',t),token);await page.goto(base);await page.locator('#funds').waitFor();await page.locator('[data-tab=exchange]').click();await page.locator('#seller-panel').waitFor();
  await page.locator('#seller-start').click();await until(async()=>assert((await call('/seller/status',{})).enabled));
  await page.screenshot({path:join(home,'seller-dark.png')});await page.locator('#theme').click();await page.screenshot({path:join(home,'seller-light.png')});
  return {call,close,page,lock:async()=>{await until(async()=>assert(!(await call('/status')).working));await call('/lock',{});},resume:async()=>{await call('/unlock',{password});await until(async()=>{const s=await call('/status');assert(s.checkedAt&&!s.error&&!s.working);});const s=await call('/seller/status',{});assert.equal(s.enabled,false);await page.reload();await page.locator('#funds').waitFor();await page.locator('[data-tab=exchange]').click();await page.locator('#seller-start').click();await until(async()=>assert((await call('/seller/status',{})).enabled));}};
 }catch(e){await close();throw e;}
}
