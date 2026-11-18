// Actual wallet + brand styles, isolated responses. No personal wallet or funds.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
const root=path.resolve(process.argv[2]||path.resolve(import.meta.dirname,'..')),out=process.argv[3]||'D:/CodexData/DueByteWork/wallet-receipt96-ui';fs.mkdirSync(out,{recursive:true});
const {chromium}=await import(pathToFileURL('C:/Users/Leges Universum/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const browser=await chromium.launch(),checks=[],errors=[];
try{for(const themeName of ['graphite','light'])for(const width of [1440]){
 const p=await browser.newPage({viewport:{width,height:900}});p.on('pageerror',e=>errors.push(e.message));
 const state={locked:false,working:false,hasVault:true,activeWallet:'fixture',selectedWallet:'fixture',wallets:[{id:'fixture',name:'Fixture'}],owner:'A'.repeat(43),network:'Isolated fixture',unitScale:'1000000',checkedAt:Date.parse('2026-11-17T12:00:00Z'),height:100,balance:{available:'10000000',reserved:'0',protected:'0',scheduled:'0',display:{available:'10',reserved:'0',protected:'0',scheduled:'0'}},payments:[],features:{delayedPayments:true}};
 await p.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!=='http://127.0.0.1:41238')return route.abort();if(u.pathname==='/')return route.fulfill({body:fs.readFileSync(root+'/wallet.html'),contentType:'text/html'});if(/^\/brand\/[a-zA-Z0-9.-]+$/.test(u.pathname)){const n=u.pathname.slice(7);return route.fulfill({body:fs.readFileSync(root+'/../desktop/brand/'+n),contentType:n.endsWith('.css')?'text/css':n.endsWith('.svg')?'image/svg+xml':n.endsWith('.woff2')?'font/woff2':'image/png'});}return route.fulfill({json:u.pathname==='/status'?state:u.pathname==='/broker/availability'?{enabled:false,providers:[]}:{}});});

 await p.addInitScript(()=>{window.audioStarts=0;window.audioStops=0;window.AudioContext=class{
 constructor(){this.state='running';this.destination={};}resume(){this.state='running';return Promise.resolve();}
 decodeAudioData(){return Promise.resolve({duration:2});}
 createBufferSource(){return {connect(){},disconnect(){},start(){window.audioStarts++;setTimeout(()=>this.onended?.(),0);},stop(){window.audioStops++;this.onended?.();}};}
 };});
 await p.goto('http://127.0.0.1:41238');await p.locator('#funds').waitFor();await p.evaluate(t=>theme(t),themeName);
 await p.locator('#theme').click();await p.evaluate(t=>theme(t),themeName);
 const payment=(id,h,extra={})=>({pid:id.toString(16).padStart(64,'0'),direction:'Received',status:'SETTLED',sender:'B'.repeat(43),recipient:state.owner,height:h,value:'1000000',unitScale:'1000000',display:{value:'1'},...extra});
 const feed=async(height,payments=[],extra={})=>{await p.evaluate(s=>paint(s),{...state,height,payments,...extra});await p.waitForTimeout(15);};
 const count=async n=>assert.equal(await p.evaluate(()=>audioStarts),n);
 await feed(100,[payment(1,98)]);await count(0); // historical opening is silent
 await feed(101,[payment(2,100)]);await count(1); // normal confirmed transfer
 await feed(101,[payment(2,100)]);await feed(102,[payment(2,100)]);await count(1);
 await feed(103,[payment(3,102)],{error:'Offline'});await count(1);
 await feed(103,[payment(3,102)]);await count(2); // recovery, once
 await feed(104,[],{rewards:{paid:'9999999'},balance:{...state.balance,available:'99999999'}});await count(2);
 await feed(105,[payment(4,104,{sender:state.owner})]);await count(2);
 await feed(106,[payment(5,105,{direction:'Sent',recipient:'B'.repeat(43)})]);await count(2);
 await feed(107,[payment(6,106,{status:'RESERVED'})]);await count(2);
 await feed(108,[payment(6,107)]);await count(3);
 await feed(109,[],{indexedHistory:{rows:[payment(7,108)],total:1,available:1}});await count(4);
 await feed(110,[payment(8,109),payment(9,109)],{indexedHistory:{rows:[payment(8,109)],total:2,available:2}});await count(5); // batch + overlap, one sound
 await p.locator('#payment-sound').click();assert.equal(await p.locator('#payment-sound').getAttribute('aria-pressed'),'false');
 await feed(111,[payment(10,110)]);await count(5);
 await p.reload();await p.locator('#funds').waitFor();assert.equal(await p.locator('#payment-sound').getAttribute('aria-pressed'),'false');await count(0);
 await p.locator('#payment-sound').click();assert.equal(await p.locator('#payment-sound').getAttribute('aria-pressed'),'true');
 await feed(100,[]);await feed(101,[payment(11,100)]);await count(1);
 await feed(102,[],{locked:true});await feed(105,[payment(12,104)]);await count(1); // reopening is silent
 await feed(106,[payment(13,105)]);await count(2);
 const other='C'.repeat(43);await feed(107,[payment(14,106,{recipient:other})],{owner:other,activeWallet:'other'});await count(2);
 await feed(108,[payment(15,107,{recipient:other})],{owner:other,activeWallet:'other'});await count(3);
 await feed(109,[payment(16,108)],{owner:other,activeWallet:'other'});await count(3); // foreign recipient
 await feed(110,[payment(17,110,{recipient:other})],{owner:other,activeWallet:'other'});await count(3); // uncertified state height
 await feed(111,[payment(18,90,{recipient:other})],{owner:other,activeWallet:'other'});await count(3); // old pages never sound
 await p.evaluate(t=>theme(t),themeName);await p.locator('header').screenshot({path:out+'/'+themeName+'-sound-on.png'});await p.locator('#payment-sound').click();await p.locator('header').screenshot({path:out+'/'+themeName+'-sound-off.png'});
 assert(await p.evaluate(()=>receiptSoundMp3.length>1000));
 checks.push({theme:themeName,incomingOnly:true,confirmedOnly:true,noRewards:true,noSelfTransfer:true,noHistoryReplay:true,recovery:true,indexedHistory:true,batchDedup:true,mutePersistent:true,walletSwitch:true,embeddedMp3:true});await p.close();
}assert.deepEqual(errors,[]);fs.writeFileSync(out+'/report.json',JSON.stringify({passed:true,checks,errors,productionTransfers:0},null,2));console.log('PASS receipt sound filtering, deduplication, recovery, mute persistence and coin waveform');}finally{await browser.close();}

