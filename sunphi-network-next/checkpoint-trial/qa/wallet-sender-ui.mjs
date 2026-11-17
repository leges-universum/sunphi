import fs from 'node:fs';import path from 'node:path';import {createServer} from 'node:http';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL('C:/Users/Leges Universum/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const out=process.argv[3]||'F:/DueByteWork/wallet-sender/ui';fs.mkdirSync(out,{recursive:true});
const old=JSON.parse(fs.readFileSync('F:/DueByteWork/compatible-packages81-r1/release.json')).releases.find(p=>p.platform==='windows-x64').folder+'/resources/app/sunphi-network-next/checkpoint-trial';
let root=old,quotes=0,sends=0,lastSend=null,failure=null;const errors=[],checks=[];
const state={locked:false,hasVault:true,working:true,checkedAt:Date.now(),error:null,network:'Isolated UI fixture',height:100,owner:'a'.repeat(43),wallets:[{id:'qa',name:'QA wallet'}],activeWallet:'qa',selectedWallet:'qa',unitScale:'1000000',balance:{available:'4000000',reserved:'0',scheduled:'0',protected:'0',display:{available:'4',reserved:'0',scheduled:'0',protected:'0'}},payments:[],features:{delayedPayments:false},networkTime:1000,analytics:null};
const server=createServer(async(req,res)=>{try{
 res.setHeader('Content-Type','application/json');
 if(req.url==='/status')return res.end(JSON.stringify(state));
 if(req.method==='POST'){let raw='';for await(const c of req)raw+=c;const q=JSON.parse(raw);
  if(req.url==='/quote'){quotes++;await new Promise(r=>setTimeout(r,250));return res.end(JSON.stringify({unitScale:'1000000',value:'3000000',fee:'5000',abortFee:'500',total:'3005000',display:{value:'3',fee:'0.005',abortFee:'0.0005',total:'3.005'}}));}
  if(req.url==='/authorize-action')return res.end(JSON.stringify({permit:'synthetic'}));
  if(req.url==='/send'){await new Promise(r=>setTimeout(r,500));lastSend=q;sends++;if(failure){res.statusCode=400;return res.end(JSON.stringify(failure));}return res.end(JSON.stringify(state));}
  res.writeHead(400);return res.end(JSON.stringify({error:'Unused isolated route'}));
 }
 const pathname=new URL(req.url,'http://localhost').pathname;assert(!pathname.includes('..'));
 const file=pathname==='/'?root+'/wallet.html':pathname.startsWith('/brand/')?path.resolve(root,'../desktop')+pathname:null;assert(file);
 res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.png')?'image/png':file.endsWith('.woff2')?'font/woff2':'text/html');res.end(fs.readFileSync(file));
}catch{res.writeHead(404);res.end('{}');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();

try{
 root=process.argv[2]||path.resolve(import.meta.dirname,'..');
 const cases=[
 ['UTC','2026-11-16T11:18:40Z','16.11.2026 11:18:40','UTC+00:00'],
 ['Europe/Kyiv','2026-11-16T11:18:40Z','16.11.2026 13:18:40','UTC+02:00'],
 ['Europe/Kyiv','2026-07-16T11:18:40Z','16.07.2026 14:18:40','UTC+03:00'],
 ['America/New_York','2026-11-01T05:59:59Z','01.11.2026 01:59:59','UTC−04:00'],
 ['America/New_York','2026-11-01T06:00:00Z','01.11.2026 01:00:00','UTC−05:00'],
 ['Asia/Kathmandu','2026-11-16T11:18:40Z','16.11.2026 17:03:40','UTC+05:45'],
 ['Pacific/Honolulu','2026-11-16T00:30:00Z','15.11.2026 14:30:00','UTC−10:00'],
 ['Pacific/Kiritimati','2026-11-16T11:18:40Z','17.11.2026 01:18:40','UTC+14:00'],
 ['Australia/Sydney','2026-11-16T11:18:40Z','16.11.2026 22:18:40','UTC+11:00']];
 for(const theme of ['graphite','light'])for(const width of [320,1440])for(const [timezoneId,iso,local,offset]of cases){
  const ctx=await browser.newContext({timezoneId,viewport:{width,height:1000},hasTouch:width===320});const p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));
  state.checkedAt=Date.parse(iso);state.error=null;state.payments=[{pid:'cbcb5ce58ff332cea1793598faa8214344a29f28f9ab0b1b60fe2077b11ecb7b',value:'2'},{pid:'bc7945e8b69cfeca38438394ae697803f2741ea8310ab862f17088e9288b1214',value:'3'}].map(p=>({...p,recipient:'8NPs9FAr2XxzkUEz1vtbKgP8DWoTBHT8UTqmWULljYQ',status:'SETTLED',direction:'Sent',fee:'0.005'}));await p.goto('http://127.0.0.1:'+server.address().port);await p.locator('#funds').waitFor();
  await p.evaluate(({themeName,s})=>{theme(themeName);feedback='';paint(s);selectTab('activity');const recipient='8NPs9FAr2XxzkUEz1vtbKgP8DWoTBHT8UTqmWULljYQ';$('payments').replaceChildren(...[{pid:'cbcb5ce58ff332cea1793598faa8214344a29f28f9ab0b1b60fe2077b11ecb7b',value:'2',recipient},{pid:'bc7945e8b69cfeca38438394ae697803f2741ea8310ab862f17088e9288b1214',value:'3',recipient}].map(x=>paymentRecordElement({...x,status:'SETTLED',direction:'Sent',fee:'0.005'})));},{themeName:theme,s:state});
  const date=new Date(iso),expected=String(date.getUTCDate()).padStart(2,'0')+'.'+String(date.getUTCMonth()+1).padStart(2,'0')+'.'+date.getUTCFullYear()+' '+iso.slice(11,19)+' UTC';
  assert.equal(await p.locator('#check-time').innerText(),expected);const tip=await p.locator('#check-time-local').textContent();assert(tip.includes(local)&&tip.includes(offset),tip);
  const before=await p.locator('#workspace-tools').boundingBox();
  if(width===320)await p.locator('#check-time').tap();else await p.locator('#check-time').hover();
  assert(await p.locator('#check-time-local').isVisible());assert.equal((await p.locator('#workspace-tools').boundingBox()).y,before.y);
  const rect=await p.locator('#check-time-local').boundingBox();assert(rect.x>=0&&rect.x+rect.width<=width&&rect.y>=0);
  assert.notEqual(await p.locator('#check-time-local').evaluate(n=>getComputedStyle(n).backgroundColor),'rgba(0, 0, 0, 0)');
  await p.keyboard.press('Escape');assert(await p.locator('#check-time-local').isHidden());await p.locator('#check-time').blur();await p.locator('#check-time').focus();assert(await p.locator('#check-time-local').isVisible());
  assert.equal(await p.locator('#payments .record-recipient').count(),2);assert.equal(await p.locator('#payments .record-id').count(),2);
  assert((await p.locator('#payments .record-explanation').first().innerText()).includes('lookup and verification'));
  assert((await p.locator('#payments .record-recipient').allTextContents()).every(x=>x==='8NPs9FAr2XxzkUEz1vtbKgP8DWoTBHT8UTqmWULljYQ'));
  assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Horizontal overflow '+width);
  assert(await p.locator('#explain').evaluate(n=>n.scrollHeight<=n.clientHeight+1),'Verification time clipped');
  for(const selector of ['.record-recipient','.record-id'])assert(Number.parseFloat(await p.locator('#payments '+selector).first().evaluate(n=>getComputedStyle(n).fontSize))<=12);
  if(timezoneId==='Europe/Kyiv'&&iso.includes('11-16'))await p.screenshot({path:out+'/'+theme+'-'+width+'.png',fullPage:true});
  const sender='H4HoFRvZ_2D_M45E5_rWgS8gEOvTYahBJw10HbZExpM';state.owner='8NPs9FAr2XxzkUEz1vtbKgP8DWoTBHT8UTqmWULljYQ';
  state.payments=[...state.payments,{pid:'4eb7016f63e7639303f9a39c8ce44916947433cee3967677842a50b1663ac319',value:'1',status:'SETTLED'}].map(x=>({...x,direction:'Received',sender,recipient:'8NPs9FAr2XxzkUEz1vtbKgP8DWoTBHT8UTqmWULljYQ',fee:'0.005'}));
  await p.evaluate(s=>{paint(s);historyGo(1);},state);
  assert.equal(await p.locator('#payments .record-sender').count(),3);
  assert((await p.locator('#payments .record-sender').allTextContents()).every(x=>x===sender));
  assert.equal(await p.locator('#payments .record-recipient').count(),0);
  assert.equal(await p.locator('#payments .outgoing-number').count(),0);
  assert((await p.locator('#payments .record-explanation').allTextContents()).every(x=>x.includes('sender address identifies the wallet')));
  assert.equal(await p.locator('#payments .record-id').count(),3);
  assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert(Number.parseFloat(await p.locator('#payments .record-sender').first().evaluate(n=>getComputedStyle(n).fontSize))<=12);
  if(timezoneId==='Europe/Kyiv'&&iso.includes('11-16'))await p.screenshot({path:out+'/'+theme+'-'+width+'-received.png',fullPage:true});
  state.payments=[{pid:'e'.repeat(64),direction:'Received',value:'1',status:'SETTLED',recipient:sender}];
  await p.evaluate(s=>paint(s),state);assert.equal(await p.locator('#payments .record-sender').innerText(),'Unavailable in this record');
  state.payments[0].sender='<img src=x onerror=alert(1)>';await p.evaluate(s=>paint(s),state);
  assert.equal(await p.locator('#payments .record-sender img').count(),0);assert.equal(await p.locator('#payments .record-sender').innerText(),state.payments[0].sender);
  state.error='Connection interrupted';state.payments=[{pid:'d'.repeat(64),recipient:'b'.repeat(43),value:'1',status:'RESERVED',direction:'Sent'}];await p.evaluate(s=>paint(s),state);
  assert(await p.locator('#payments .wait-indicator').isVisible());assert.notEqual(await p.locator('#sync .connection-dot').evaluate(n=>getComputedStyle(n).animationName),'none');
  await p.emulateMedia({reducedMotion:'reduce'});assert.equal(await p.locator('#sync .connection-dot').evaluate(n=>getComputedStyle(n).animationName),'none');
  state.checkedAt=null;await p.evaluate(s=>paint(s),state);assert(await p.locator('#explain').isHidden());assert(await p.locator('#check-time-local').isHidden());
  checks.push({theme,width,timezoneId,iso,utc:expected,local:tip,tooltip:true,stableLayout:true,receipt:true,incomingSender:true,missingSenderNotInferred:true,safeText:true,waiting:true,reducedMotion:true});await ctx.close();
 }
 const layout=[];
 for(const themeName of ['graphite','light'])for(const width of [1440,1024,801,800,390,320]){
  const ctx=await browser.newContext({viewport:{width,height:1100}}),p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));
  state.error=null;state.checkedAt=Date.now();state.payments=[];state.owner='H4HoFRvZ_2D_M45E5_rWgS8gEOvTYahBJw10HbZExpM';
  await p.goto('http://127.0.0.1:'+server.address().port);await p.locator('#funds').waitFor();await p.evaluate(t=>{theme(t);selectTab('overview');},themeName);
  const a=await p.locator('[data-screen=overview]>section').filter({has:p.locator('#available')}).boundingBox(),b=await p.locator('[data-screen=overview]>section').filter({has:p.locator('#owner')}).boundingBox();
  if(width>800){assert(Math.abs(a.y-b.y)<1);assert(Math.abs(a.height-b.height)<1);}else assert(b.y>=a.y+a.height);
  assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await p.locator('#available').evaluate(n=>n.closest('section').scrollIntoView());await p.screenshot({path:out+'/overview-'+themeName+'-'+width+'.png'});
  layout.push({theme:themeName,width,balanceHeight:a.height,walletHeight:b.height,sideBySide:width>800});await ctx.close();
 }
 assert.deepEqual(errors,[]);assert.equal(sends,0);fs.writeFileSync(out+'/report.json',JSON.stringify({passed:true,checks,layout,errors,productionTransfers:0},null,2));console.log('PASS '+checks.length+' timezone/receipt cases and '+layout.length+' overview layouts');
}finally{await browser.close();server.close();}
