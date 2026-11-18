// Synthetic chart samples only, isolated browser; no live node or wallet actions.
import {createServer} from 'node:http';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,extname,sep,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL('C:/Users/Leges Universum/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const root=process.argv[3]?resolve(process.argv[3]):resolve(import.meta.dirname,'../..'),out=resolve(process.argv[2]||'D:/CodexData/duebyte-dashboard-composition-20261104/charts');mkdirSync(out,{recursive:true});
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
const server=createServer((req,res)=>{try{const file=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(!file.startsWith(root+sep))throw Error();res.setHeader('Content-Type',mime[extname(file)]||'application/octet-stream');res.end(readFileSync(file));}catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true}),errors=[],results=[];
try{
 for(const theme of ['dark','light']){
  const page=await browser.newPage({viewport:{width:1180,height:960}});page.on('pageerror',e=>errors.push(e.message));
  const external=[];page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:'))external.push(r.url());});
  const start=Date.parse('2026-11-04T12:00:00Z');await page.clock.install({time:start});
  await page.addInitScript(({theme,start})=>{
   window.qaState={configured:true,network:'qa-network',progress:'running',walletReady:true,rpc:{chain:'qa-network',height:'1000',time:new Date(start).toISOString(),catchingUp:false,votingPower:'0',peers:2}};
   window.sunphiNode={request:async()=>{if(window.qaUnavailable)throw Error('Test unavailable');return {ok:true,value:window.qaState};}};
   document.addEventListener('DOMContentLoaded',()=>document.documentElement.dataset.theme=theme);
  },{theme,start});
  await page.goto(`http://127.0.0.1:${server.address().port}/checkpoint-trial/consumer.html`);
  await page.waitForFunction(()=>document.getElementById('status').textContent==='Connected to the network');
  assert.equal(await page.locator('#rate-chart .chart-point').count(),0);
  for(let i=1;i<=20;i++){
   await page.evaluate(({i,start})=>{Object.assign(window.qaState.rpc,{height:String(1000+i*5),time:new Date(start+i*15000).toISOString(),traffic:{incoming:4096+(i%4)*1024,outgoing:1024+(i%3)*512}});},{i,start});
   await page.clock.fastForward(15000);
   await page.waitForFunction(n=>document.querySelectorAll('#rate-chart .chart-point').length===n,i);
  }
  assert.equal(await page.locator('#traffic-chart .chart-line').count(),2);
  assert.equal(await page.locator('#traffic-chart .chart-target').count(),40);
  assert.equal(await page.locator('#rate-value').textContent(),'20 blocks/min');
  assert.equal(await page.locator('#interval-value').textContent(),'20 blocks/min');
  assert.equal(await page.locator('#rate-chart rect.chart-point').count(),20);
  assert.equal(await page.locator('#interval-chart circle.chart-point').count(),16);
  for(const path of await page.locator('#traffic-chart path.chart-line').all())assert.match(await path.getAttribute('d'),/C/);
  assert.deepEqual(await page.locator('#network-activity .chart-unit').allTextContents(),['blocks/min','blocks/min','KiB/s']);
  // Exercise the actual SVG renderer with irregular sample times, a peak,
  // a plateau and a missing reading. Read the control points it produced.
  const trace=await page.evaluate(()=>{
   const plot=document.createElementNS('http://www.w3.org/2000/svg','svg');
   const times=[0,1,3,4,5,6,7,9,10],values=[0,1,3,8,4,4,null,0,2];
   const points=times.map((t,i)=>({at:t*1000,incoming:values[i]}));
   DueBytePlots.drawChart(plot,points,['incoming'],'KiB/s','Test traffic');
   return plot.querySelector('path').getAttribute('d').match(/[MC][^MC]+/g);
  });
  assert.equal(trace.map(part=>part[0]).join(''),'MCCCCCMC');
  let lastY;
  for(const [i,part] of trace.entries()){
   const values=part.slice(1).trim().split(/\s+/).map(Number);
   const y=values.at(-1);
   if(part[0]==='C'){
    const [,a,,b]=values,lo=Math.min(y,lastY)-1e-9,hi=Math.max(y,lastY)+1e-9;
    assert(a>=lo&&a<=hi&&b>=lo&&b<=hi,'controls within sampled range');
    if(i===1)assert(Math.abs(a-lastY-(y-lastY)/3)<1e-9&&Math.abs(b-y+(y-lastY)/3)<1e-9,'uniform slope stays straight');
    if(i===3)assert.equal(b,y,'horizontal tangent at the peak');
    if(i===5)assert.equal(lastY,y,'constant traffic stays flat');
   }
   lastY=y;
  }
  await page.locator('#traffic-chart').locator('..').screenshot({path:join(out,theme+'-traffic.png')});
  await page.locator('#traffic-chart .chart-target').first().focus();
  assert.match(await page.locator('#traffic-chart .chart-target').first().getAttribute('aria-label'),/incoming.*KiB\/s/);
  for(const width of [1180,800,390]){
   await page.setViewportSize({width,height:960});
   assert.equal(await page.evaluate(()=>[document.documentElement,document.querySelector('main'),...document.querySelectorAll('.mini-chart')].some(e=>e.scrollWidth>e.clientWidth+1)),false,`${theme}/${width}`);
   results.push({theme,width,filled:true});
   if(width===1180){await page.locator('#heading').scrollIntoViewIfNeeded();await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(out,`${theme}-charts.png`),fullPage:true});}
  }
  await page.evaluate(()=>window.qaState.rpc.traffic={incoming:null,outgoing:null});await page.clock.fastForward(15000);
  await page.waitForFunction(()=>document.getElementById('traffic-value').textContent==='— ↓ / — ↑ KiB/s');
  await page.evaluate(()=>window.qaUnavailable=true);await page.clock.fastForward(1500);
  await page.waitForFunction(()=>document.getElementById('activity-empty').textContent.includes('paused') || document.getElementById('activity-empty').textContent.includes('saved history'));
  assert.equal(await page.locator('#rate-chart .chart-point').count(),20);
  assert.deepEqual(external,[]);await page.close();
 }
 assert.deepEqual(errors,[]);writeFileSync(join(out,'report.json'),JSON.stringify({passed:true,scope:'Synthetic data; local chart privacy, gaps, keyboard descriptions and layouts',results,errors},null,2));console.log('PASS filled charts: 6 layouts, reset/missing data, no external requests');
}finally{await browser.close();await new Promise(r=>server.close(r));}
