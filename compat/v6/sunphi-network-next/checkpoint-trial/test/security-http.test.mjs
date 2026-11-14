import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {request} from 'node:http';
import {randomBytes} from 'node:crypto';
import {fixture} from '../../research/transition-core-20261103/fixture.mjs';
import {PROFILE} from '../core.mjs';
import {hash,keys} from '../crypto.mjs';
import {CHECKPOINT} from '../checkpoint.mjs';
import {createVault} from '../vault.mjs';
import {publicServer} from '../public-rpc.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

for(const indexed of [false,true])test('separate wallet clients cannot inherit an unlocked session or reuse payment authority'+(indexed?' (indexed reader)':''),async()=>{
 const dir=mkdtempSync(join(tmpdir(),'duebyte-session-test-')),password='synthetic-test-password',f=fixture();
 const config={profile:PROFILE,chainId:'duebyte-trial-session-test',trialOnly:true,initial:f.state},genesis={chain_id:config.chainId,app_state:config};
 const policy={domain:CHECKPOINT+'/POLICY',version:1,network:config.chainId,genesisHash:hash(genesis),members:Array.from({length:4},(_,i)=>({key:keys().publicKey,group:hash({i})})),threshold:3,maxAge:3600,notAfter:Math.floor(Date.now()/1000)+86400};
 for(const [name,value]of Object.entries({'app-config':config,genesis,'trust-policy':policy,connections:{rpc:'http://127.0.0.1:1',workers:{}},checkpoint:{},'wallet.encrypted':createVault(password)}))writeFileSync(join(dir,name+'.json'),JSON.stringify(value));
 if(indexed)writeFileSync(join(dir,'indexed-wallet.json'),JSON.stringify({bounded:{url:'http://127.0.0.1:1',source:{},certificate:{}}}));
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));let port=probe.address().port;await new Promise(r=>probe.close(r));
 // Existing wallet CLI restricts ports to the non-ephemeral range.
 while(port>=32768){const p=createServer();port=20000+Math.floor(Math.random()*6000);try{await new Promise((r,j)=>{p.once('error',j);p.listen(port,'127.0.0.1',r);});await new Promise(r=>p.close(r));}catch{port=65535;}}
 const child=fork(resolve(import.meta.dirname,'../wallet-server.mjs'),[dir,String(port),hash(policy)],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
 const a=randomBytes(32).toString('hex'),b=randomBytes(32).toString('hex'),url='http://127.0.0.1:'+port;
 const call=async(path,token,data,extra={})=>{const r=await fetch(url+path,{method:data?'POST':'GET',headers:{'x-duebyte-token':token,'content-type':'application/json',...extra},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(5000)});return {code:r.status,body:await r.json()};};
 const held=[];
 function begin(path,token,data){
  const bytes=Buffer.from(JSON.stringify(data));let req;
  const result=new Promise((ok,no)=>{req=request(url+path,{method:'POST',headers:{'x-duebyte-token':token,'content-type':'application/json','content-length':bytes.length}},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>ok({code:res.statusCode,body:JSON.parse(body)}));});req.on('error',no);req.setTimeout(5000,()=>req.destroy(Error('test request timeout')));req.write(bytes.subarray(0,1));});
  result.catch(()=>{});held.push(req);return ()=>{req.end(bytes.subarray(1));return result;};
 }
 try{
  await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error('startup failed');}),sleep(10000).then(()=>{throw Error('startup timeout');})]);
  const html=await (await fetch(url)).text();assert(!html.includes('__TOKEN__'));assert(!/const token=['"][^'"]+['"]/.test(html));
  const coinCss=await (await fetch(url+'/brand/duebyte-coin.css')).text();
  const coinImages=[...new Set([...coinCss.matchAll(/url\('\.\/([^']+)'\)/g)].map(m=>m[1]))];
  assert(coinImages.includes('duebyte-coin-v2.png'));
  for(const image of coinImages){const response=await fetch(url+'/brand/'+image);assert.equal(response.status,200,image);assert.equal(response.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await response.arrayBuffer()),readFileSync(resolve(import.meta.dirname,'../../desktop/brand',image)));}
  assert.equal((await fetch(url+'/brand/not-an-approved-asset.png')).status,400);
  assert.equal((await call('/backup',b)).code,400);assert.equal((await call('/unlock',b,{password:'incorrect-password'})).code,400);
  assert.equal((await call('/unlock',a,{password})).code,200);
  for(const [path,data]of [['/status',null],['/backup',null],['/lock',{}],['/select-wallet',{walletId:'legacy'}],['/authorize-action',{path:'/send',data:{recipient:f.bob.publicKey,value:'1'}}]])assert.equal((await call(path,b,data)).code,400,path);
  assert.equal((await call('/backup',a)).code,200);assert.equal((await call('/status',a,null,{origin:'https://untrusted.invalid'})).code,400);
  for(const path of ['/node-alerts/status','/node-alerts/review','/node-alerts/confirm','/node-alerts/activate','/node-alerts/stop','/nodes/options','/nodes/review','/nodes/confirm','/nodes/check','/collateral/options','/collateral/confirm'])assert.equal((await call(path,b,{})).code,400,'other browser cannot use '+path);
  for(const path of ['/node-alerts/confirm','/node-alerts/activate','/node-alerts/stop'])assert.match((await call(path,a,{})).body.error,/Confirmation/);
  assert.match((await call('/nodes/confirm',a,{id:'a'.repeat(64)})).body.error,/Confirmation/);
  const linkPermit=await call('/authorize-action',a,{path:'/nodes/confirm',data:{id:'a'.repeat(64)}});assert.equal(linkPermit.code,200);
  assert.match((await call('/nodes/confirm',a,{id:'b'.repeat(64)},{'x-duebyte-action':linkPermit.body.permit})).body.error,/Confirmation/);
  assert.match((await call('/nodes/confirm',a,{id:'a'.repeat(64)},{'x-duebyte-action':linkPermit.body.permit})).body.error,/Confirmation/);
  const data={recipient:f.bob.publicKey,value:'1'},p=await call('/authorize-action',a,{path:'/send',data});assert.equal(p.code,200);
  const changed=await call('/send',a,{...data,value:'2'},{'x-duebyte-action':p.body.permit});assert.match(changed.body.error,/Confirmation/);
  assert.match((await call('/send',a,data,{'x-duebyte-action':p.body.permit})).body.error,/Confirmation/);
  const pending=await call('/authorize-action',a,{path:'/send',data});
  for(let n=0;n<50&&(await call('/status',a)).body.working;n++)await sleep(20);
  assert.equal((await call('/lock',a,{})).code,200);assert.equal((await call('/backup',a)).code,400);
  if(indexed){const locked=(await call('/status',a)).body;assert.equal(locked.balance,null);assert.equal(locked.analytics,null);assert.equal(locked.checkedAt,null);}
  assert.equal((await call('/unlock',b,{password})).code,200);assert.equal((await call('/backup',a)).code,400);
  assert.match((await call('/send',b,data,{'x-duebyte-action':pending.body.permit})).body.error,/Confirmation/);
  let current=b;
  for(const next of [b,a]){
   const finishPermit=begin('/authorize-action',current,{path:'/send',data}),finishLock=begin('/lock',current,{});
   await sleep(100);assert.equal((await call('/lock',current,{})).code,200);assert.equal((await call('/unlock',next,{password})).code,200);
   for(const finish of [finishPermit,finishLock]){const stale=await finish();assert.equal(stale.code,400);assert.match(stale.body.error,/session changed/);}
   assert.equal((await call('/status',next)).body.locked,false);assert.equal((await call('/authorize-action',next,{path:'/send',data})).code,200);current=next;
  }
  assert.equal((await call('/lock',current,{})).code,200);
  const before=(await call('/status',current)).body.wallets.length;
  const finishCreate=begin('/create',b,{password,name:'Must not be created'}),finishSelect=begin('/select-wallet',b,{walletId:'legacy'});
  await sleep(100);assert.equal((await call('/unlock',a,{password})).code,200);
  for(const finish of [finishCreate,finishSelect]){const stale=await finish();assert.equal(stale.code,400);assert.match(stale.body.error,/session changed/);}
  const after=(await call('/status',a)).body;assert.equal(after.locked,false);assert.equal(after.wallets.length,before);
  const prepareUpdate=()=>new Promise((resolve,reject)=>{const request=randomBytes(12).toString('hex'),timer=setTimeout(()=>{child.off('message',listener);reject(Error('update IPC timeout'));},2000);function listener(m){if(m?.updateRequest===request){clearTimeout(timer);child.off('message',listener);resolve(m.ready);}}child.on('message',listener);child.send({command:'prepare-update',request});});
  assert.equal(await prepareUpdate(),false,'unlocked wallet must defer update');
  for(let n=0;n<50&&(await call('/status',a)).body.working;n++)await sleep(20);
  assert.equal((await call('/lock',a,{})).code,200);assert.equal(await prepareUpdate(),true);
  const during=await call('/unlock',a,{password});assert.equal(during.code,400);assert.match(during.body.error,/installing an update/);
  assert.equal((await call('/status',a)).body.wallets.length,before,'update handoff must retain wallet catalog');
 }finally{for(const req of held)req.destroy();const exited=once(child,'exit');child.kill();await exited;}
});

test('read saturation leaves payment capacity; spoofed forwarding headers cannot bypass peer quota',async()=>{
 const budget={active:0};let release;const gate=new Promise(r=>release=r);let reads=0;
 const server=publicServer({kind:'rpc',target:22001},{budget,upstream:async(_,options)=>{if(options.method==='GET'){reads++;await gate;}return new Response('{}');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 const pending=Array.from({length:8},()=>fetch(url+'/status'));
 try{
  for(let n=0;n<100&&reads<8;n++)await sleep(10);assert.equal(reads,8);
  const extra=await fetch(url+'/status',{headers:{'x-forwarded-for':'203.0.113.123'}});assert.equal(extra.status,429);
  const payment=await fetch(url,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',method:'broadcast_tx_sync',params:{tx:''}})});assert.equal(payment.status,200);
  assert.equal(budget.reads,8);assert.equal(budget.payments,0);
 }finally{release();await Promise.all(pending);server.closeAllConnections();await new Promise(r=>server.close(r));}
 assert.equal(budget.active,0);assert.equal(budget.parsing,0);assert.equal(budget.peers.size,0);
});

test('disconnect and upstream timeout release RPC budgets',async()=>{
 const budget={active:0};const server=publicServer({kind:'rpc',target:22001},{budget,timeoutMs:100,upstream:async(_,options)=>{await new Promise((r,j)=>{if(options.signal.aborted)j(Error('aborted'));else options.signal.addEventListener('abort',()=>j(Error('aborted')),{once:true});});return new Response('{}');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(url+'/status')).status,502);assert.equal(budget.active,0);
  const controller=new AbortController(),request=fetch(url+'/status',{signal:controller.signal}).catch(()=>null);
  await sleep(20);controller.abort();await request;await sleep(30);assert.equal(budget.active,0);assert.equal(budget.peers.size,0);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
