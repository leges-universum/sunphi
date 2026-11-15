// Dedicated private operational service. All state reads are authenticated and bounded.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {hash,keys} from './crypto.mjs';
import {rpc} from './client.mjs';
import {boundedHttpQuery,loadBoundedServiceView} from './research/bounded-wallet-view.mjs';
import {CapacitySigner,CapacityCoordinator} from './warmup-capacity-service.mjs';
import {startRewardSignerHTTP,remoteRewardSigner} from './reward-services.mjs';

export async function broadcastCapacityInterval(url,wire,read=rpc){
 try{
  const r=await read(url,'broadcast_tx_sync',{tx:Buffer.from(JSON.stringify(wire)).toString('base64')});
  assert.equal(r.code,0,'capacity transaction rejected');return {cached:false};
 }catch(error){
  let response;try{response=JSON.parse(error.message);}catch{}
  // A cached transaction is only awaiting reconciliation, never proof of commit.
  if(response?.code===-32603&&response?.data==='tx already exists in cache')return {cached:true};
  throw error;
 }
}

export function localCapacityView(cfg,{read=rpc,query=boundedHttpQuery(cfg.api),clock=()=>Date.now(),space=()=>fs.statfsSync(cfg.home)}={}){
 const configHash=hash(cfg.config);
 assert(Array.isArray(cfg.validators)&&cfg.validators.length>0);
 for(const v of cfg.validators){const u=new URL(v.rpc);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.protocol,'http:');}
 return async requested=>{
  const disk=space();assert(Number(disk.bavail)*Number(disk.bsize)>256*1024*1024,'capacity disk reserve');
  const statuses=await Promise.all(cfg.validators.map(v=>read(v.rpc,'status',{})));
  for(let i=0;i<statuses.length;i++){
   const r=statuses[i];assert.equal(r.node_info.network,cfg.config.chainId);assert.equal(r.sync_info.catching_up,false);
   assert.equal(Buffer.from(r.validator_info.pub_key.value,'base64').toString('base64url'),cfg.validators[i].key);
   const age=clock()-Date.parse(r.sync_info.latest_block_time);assert(Number.isFinite(age)&&age>=-5000&&age<60000,'stale local validator');
  }
  const head=Math.min(...statuses.map(r=>Number(r.sync_info.latest_block_height))),height=requested??head-1;
  assert(Number.isSafeInteger(height)&&height>0&&height<head&&head-height<12,'local height range');
  const blocks=await Promise.all(cfg.validators.map(v=>read(v.rpc,'block',{height:String(height+1)})));
  const root=blocks[0].block.header.app_hash.toLowerCase();assert(/^[a-f0-9]{64}$/.test(root));
  for(const r of blocks){assert.equal(r.block.header.chain_id,cfg.config.chainId);assert.equal(Number(r.block.header.height),height+1);assert.equal(r.block.header.app_hash.toLowerCase(),root);}
  const time=Math.floor(Math.max(...statuses.map(r=>Date.parse(r.sync_info.latest_block_time)))/1000);
  const {state}=await query.withLease(root,q=>loadBoundedServiceView(q,{root,height,configHash}));
  assert.equal(state.configHash,configHash);assert.equal(state.height,height);
  for(const v of cfg.validators)assert(state.authority.validators.some(m=>m.key===v.key),'local validator not admitted');
  assert(time>=state.money.time&&time-state.money.time<=50,'capacity snapshot freshness');
  return{state,time,root};
 };
}

export async function runCapacityService(file){
 const st=fs.statSync(file);assert.equal(st.uid,0);assert.equal(st.mode&0o022,0);
 const cfg=JSON.parse(fs.readFileSync(file));assert(['signer','coordinator'].includes(cfg.mode));
 fs.mkdirSync(cfg.home,{recursive:true,mode:0o700});
 const enabled=()=>!fs.existsSync(path.join(cfg.home,'PAUSE'))&&!(cfg.pauseFile&&fs.existsSync(cfg.pauseFile));
 const view=localCapacityView(cfg),options={planHash:cfg.planHash,rate:'1000'};
 const status=value=>{const target=path.join(cfg.home,'status.json');fs.writeFileSync(target+'.tmp',JSON.stringify({at:new Date().toISOString(),mode:cfg.mode,...value}),{mode:0o600});fs.renameSync(target+'.tmp',target);};
 let service,http,stopping=false;
 if(cfg.mode==='signer'){
  const validatorKeys=cfg.validators.map(v=>{
   const p=fs.statSync(v.keyFile);assert.equal(p.uid,0);assert.equal(p.mode&0o077,0);
   const k=JSON.parse(fs.readFileSync(v.keyFile)),raw=Buffer.from(k.priv_key.value,'base64');
   assert.equal(Buffer.from(k.pub_key.value,'base64').toString('base64url'),v.key);assert.equal(raw.length,64);
   const der=Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),raw.subarray(0,32)]);
   try{return{publicKey:v.key,privateKey:der.toString('base64url')};}finally{raw.fill(0);der.fill(0);k.priv_key.value='';}
  });
  service=new CapacitySigner({file:path.join(cfg.home,'approvals.sqlite'),view,validatorKeys,options,enabled});
  http=await startRewardSignerHTTP({port:cfg.port,signer:{approve:async packet=>{try{const result=await service.approve(packet);status({approved:packet.body.sequence,height:packet.height});return result;}catch(e){status({error:String(e.message).slice(0,240)});throw e;}}}});
  status({ready:true,port:http.port});
 }else{
  const keyFile=path.join(cfg.home,'author.json');if(!fs.existsSync(keyFile))fs.writeFileSync(keyFile,JSON.stringify(keys()),{flag:'wx',mode:0o600,flush:true});
  service=new CapacityCoordinator({file:path.join(cfg.home,'outbox.sqlite'),view,config:cfg.config,key:JSON.parse(fs.readFileSync(keyFile)),options,signers:cfg.signers.map(remoteRewardSigner),enabled,broadcast:async wire=>{
   return broadcastCapacityInterval(cfg.validators[0].rpc,wire);
  }});
 }
 const stop=()=>{stopping=true;};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{while(!stopping){if(cfg.mode==='coordinator')try{status(await service.cycle());}catch(e){status({error:String(e.message).slice(0,240)});}await new Promise(r=>setTimeout(r,5000));}}
 finally{if(http)await http.close();service.close();process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)runCapacityService(process.argv[2]).catch(e=>{console.error(e.message);process.exitCode=1;});
