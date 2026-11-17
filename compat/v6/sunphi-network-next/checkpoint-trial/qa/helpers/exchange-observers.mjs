import fs from 'node:fs';
import {join} from 'node:path';
import {spawn,fork} from 'node:child_process';
import assert from 'node:assert/strict';
import {hash} from '../../crypto.mjs';
import {localRpc} from '../../research/purchase-observer.mjs';
import {until} from './purchase-comet-network.mjs';
import {collectExchangeObservations} from '../../research/exchange-observer-quorum.mjs';
import {EXCHANGE_V2} from '../../research/exchange-resolution.mjs';
export async function bitcoinReaders(out,btc,exe){
 const children=[],readers=[];fs.mkdirSync(out,{recursive:true});
 const close=async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}};
 try{
  for(let i=0;i<3;i++){
   const home=join(out,'reader'+i),port=35540+i,p2p=35550+i;fs.mkdirSync(home);const fd=fs.openSync(join(home,'process.log'),'w');
   const child=spawn(exe,['-regtest','-server=1','-listen=1','-bind=127.0.0.1:'+p2p,'-port='+p2p,'-connect=0','-dnsseed=0','-discover=0','-txindex=1','-rpcbind=127.0.0.1','-rpcport='+port,'-datadir='+home],{windowsHide:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);children.push(child);
   const account={url:'http://127.0.0.1:'+port,cookieFile:join(home,'regtest/.cookie')};
   const rpc=localRpc(account.url,{headers:()=>({authorization:'Basic '+Buffer.from(fs.readFileSync(account.cookieFile,'utf8').trim()).toString('base64')})});
   await until(()=>rpc('getblockchaininfo',[]));await btc.rpc('addnode',['127.0.0.1:'+p2p,'add']);readers.push({account,rpc});
  }
  const sync=async()=>{const head=await btc.rpc('getbestblockhash',[]);await until(async()=>{for(const r of readers){assert.equal(await r.rpc('getbestblockhash',[]),head);assert((await r.rpc('getindexinfo',[])).txindex.synced);}});};
  await sync();return {readers,sync,close};
 }catch(e){await close();throw e;}
}
export async function exchangeObservers({out,policy,keys,btcReaders,evm,pins,runtime=process.execPath,worker=new URL('./exchange-observer-process.mjs',import.meta.url)}){
 const children=[],clients=[];fs.mkdirSync(out,{recursive:true});let sequence=0;
 const close=async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}};
 try{
  for(let i=0;i<3;i++){
   const fd=fs.openSync(join(out,'observer'+i+'.log'),'w'),child=fork(worker,[],{execPath:runtime,execArgv:[],windowsHide:true,stdio:['ignore',fd,fd,'ipc']});fs.closeSync(fd);children.push(child);
   const pending=new Map();let ready;
   child.on('exit',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('observer offline'));}pending.clear();});
   child.on('message',m=>{if(m.ready){ready();return;}const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error)):p.resolve(m.result);});
   const init=new Promise(r=>{ready=r;});child.send({type:'init',config:{policy,key:keys[i],rpc:{BTC:{...btcReaders.readers[i].account,pins:{confirmations:2}},USDC:{url:evm.urls[i],pins}}}});await Promise.race([init,new Promise((_,reject)=>setTimeout(()=>reject(Error('observer init timeout')),10000).unref())]);
   clients.push(request=>new Promise((resolve,reject)=>{if(!child.connected||child.exitCode!==null||child.signalCode!==null)return reject(Error('observer offline'));const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('observer timeout'));},15000);pending.set(id,{resolve,reject,timer});child.send({id,request});}));
  }
  return {clients,children,close,async receipt(request){
   if(policy.domain===EXCHANGE_V2)return until(()=>collectExchangeObservations({policy,request,clients:clients.map((read,i)=>({observer:keys[i].publicKey,read})),now:Math.floor(Date.now()/1000),timeoutMs:15000}),30000);
   return until(async()=>{const results=await Promise.allSettled(clients.map(c=>c(request))),groups=new Map();for(const r of results)if(r.status==='fulfilled'){const id=hash(r.value.body),g=groups.get(id)??[];g.push(r.value);groups.set(id,g);}const group=[...groups.values()].find(g=>g.length>=2);assert(group,'independent observer quorum unavailable');return {body:group[0].body,signatures:group.map(x=>x.signature)};},30000);
  }};
 }catch(e){await close();throw e;}
}
