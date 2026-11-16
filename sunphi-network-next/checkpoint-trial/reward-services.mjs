// Dedicated host services; no browser/edge polling and no launch-issuance route.
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync,writeFileSync,mkdirSync,statSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {hash,keys,exact} from './crypto.mjs';
import {VerifiedClient,rpc} from './client.mjs';
import {RewardProposalSigner,RewardCoordinator} from './reward-coordinator.mjs';
import {WarmupWorker} from './warmup-worker.mjs';
import {ProgramWarmupWorker} from './program-warmup-worker.mjs';
import {CenturyWarmupWorker,remoteWarmupReceipt} from './century-warmup-worker.mjs';
import {MAX_ACTIVE_VALIDATORS} from './validator-authority.mjs';
import {Wallet} from './wallet.mjs';
import {unseal} from './vault.mjs';
import {HomeAdmissionQueue,startHomeAdmissionHTTP} from './home-admission-service.mjs';
const loopback=url=>{const u=new URL(url);assert.equal(u.protocol,'http:');assert(['127.0.0.1','[::1]'].includes(u.hostname));assert(!u.username&&!u.password&&!u.search&&!u.hash);return u;};
export function readRewardConsent(file,body){
 // Public signed statement only. The coordinator never loads the manager key.
 if(!file||!existsSync(file))return null;
 const st=statSync(file);assert(st.isFile()&&st.size<=65536,'reward consent file bound');
 if(process.platform==='linux'){assert.equal(st.uid,0,'root-owned reward consent');assert.equal(st.mode&0o022,0,'protected reward consent');}
 const value=JSON.parse(readFileSync(file,'utf8'));exact(value,['body','signature']);
 return hash(value.body)===hash(body)?value.signature:null;
}
export async function startRewardSignerHTTP({signer,port}){
 let busy=false;const server=http.createServer(async(req,res)=>{
  const reply=(status,value)=>{if(!res.destroyed){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}};
  if(req.method!=='POST'||req.url!=='/approve'||req.headers.origin||!req.headers['content-type']?.startsWith('application/json')){reply(400,{error:'invalid signing request'});req.resume();return;}
  if(busy){reply(503,{error:'signer busy'});req.resume();return;}busy=true;
  try{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>131072){reply(413,{error:'request too large'});req.destroy();return;}chunks.push(chunk);}
   const approvals=await signer.approve(JSON.parse(Buffer.concat(chunks).toString('utf8')));reply(200,{approvals});
  }catch{reply(422,{error:'proposal did not pass independent verification'});}finally{busy=false;}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;server.maxHeadersCount=24;
 await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok);});
 return{port:server.address().port,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
export function remoteRewardSigner(url){
 const u=loopback(url);assert.equal(u.pathname,'/approve');
 return async packet=>{const response=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(packet),signal:AbortSignal.timeout(30000)});assert(response.ok,'independent signer unavailable');
  // Bound decoded bytes while streaming, including responses without Content-Length.
  // An Ed25519 approval is below 192 JSON bytes; allow a small envelope margin.
  const limit=MAX_ACTIVE_VALIDATORS*192+1024,chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;assert(size<=limit,'signer response too large');chunks.push(chunk);}
  const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));assert(Array.isArray(value.approvals)&&value.approvals.length<=MAX_ACTIVE_VALIDATORS,'signer approval count');return value.approvals;};
}
export async function runRewardService(file){
 if(process.platform==='linux'){const st=statSync(file);assert.equal(st.uid,0,'service configuration must be root-owned');assert.equal(st.mode&0o022,0,'service configuration must not be writable by other users');}
 const cfg=JSON.parse(readFileSync(file,'utf8'));assert(['signer','coordinator','warmup','home-admission'].includes(cfg.mode));assert(typeof cfg.enabled==='boolean');
 const read=name=>JSON.parse(readFileSync(join(cfg.profile,name),'utf8')),config=read('app-config.json'),policy=read('trust-policy.json');assert.equal(hash(policy),cfg.policyPin);loopback(cfg.url);
 mkdirSync(cfg.home,{recursive:true,mode:0o700});const status=data=>writeFileSync(join(cfg.home,'status.json'),JSON.stringify({at:new Date().toISOString(),mode:cfg.mode,network:config.chainId,...data}),{mode:0o600,flush:true});
 // Prepared installation is deliberately inert and does not even read keys.
 if(!cfg.enabled){status({prepared:true,enabled:false,monetaryActions:0});return;}
 if(cfg.mode==='warmup'&&cfg.bounded){assert(/^[a-f0-9]{64}$/.test(cfg.centuryPlanHash),'indexed warmup requires a pinned century plan');assert(!cfg.custody&&!cfg.reservePolicyHash&&!cfg.launchPolicyHash,'ambiguous warmup configuration');}
 if(cfg.mode==='warmup'&&cfg.centuryPlanHash)assert(cfg.bounded,'century warmup requires verified indexed state');
 const clients=[],wallets=[];let service,httpServer,stopping=false,wake;
 const makeClient=home=>{mkdirSync(home,{recursive:true,mode:0o700});const c=new VerifiedClient({home,config,policy,genesisFile:join(cfg.profile,'genesis.json'),binary:cfg.binary,bounded:cfg.bounded});clients.push(c);return c;};
 const checkpoint=async()=>{const q=await rpc(cfg.url,'abci_query',{path:'/checkpoint'});assert(!q.response.code,'checkpoint unavailable');return JSON.parse(Buffer.from(q.response.value,'base64'));};
 const broadcast=async wire=>{try{const r=await rpc(cfg.url,'broadcast_tx_sync',{tx:Buffer.from(JSON.stringify(wire)).toString('base64')});assert.equal(r.code,0,'proposal not admitted');}catch(e){if(!e.message.includes('tx already exists in cache'))throw e;}};
 const stop=()=>{stopping=true;wake?.();};process.once('SIGTERM',stop);process.once('SIGINT',stop);
 try{
  if(cfg.mode==='home-admission'){
   assert(cfg.bounded,'Home admission requires verified indexed state');const client=makeClient(join(cfg.home,'verifier'));
   service=new HomeAdmissionQueue({file:join(cfg.home,'home-admission.sqlite'),config,capacity:cfg.capacity??4096});
   httpServer=await startHomeAdmissionHTTP({queue:service,port:cfg.listenPort,view:async()=>client.sync(await checkpoint(),cfg.url,{service:true})});status({enabled:true,ready:true,port:httpServer.port,monetaryActions:0});
  }else if(cfg.mode==='signer'){
   const validatorKeys=cfg.validatorFiles.map(f=>{const k=JSON.parse(readFileSync(f,'utf8'));return{publicKey:Buffer.from(k.pub_key.value,'base64').toString('base64url'),privateKey:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(k.priv_key.value,'base64').subarray(0,32)]).toString('base64url')};});
   service=new RewardProposalSigner({client:makeClient(join(cfg.home,'verifier')),url:cfg.url,validatorKeys,home:cfg.home,plannerOptions:cfg.plannerOptions});
   httpServer=await startRewardSignerHTTP({signer:service,port:cfg.listenPort});status({enabled:true,ready:true,port:httpServer.port});
  }else if(cfg.mode==='coordinator'){
   const file=join(cfg.home,'proposal-author.json');if(!existsSync(file))writeFileSync(file,JSON.stringify(keys()),{flag:'wx',mode:0o600,flush:true});
   service=new RewardCoordinator({client:makeClient(join(cfg.home,'verifier')),url:cfg.url,checkpoint,home:cfg.home,key:JSON.parse(readFileSync(file,'utf8')),plannerOptions:cfg.plannerOptions,signers:cfg.signers.map(remoteRewardSigner),broadcast,founderConsent:body=>readRewardConsent(cfg.founderConsentFile,body)});
  }else if(cfg.centuryPlanHash){
   const receipt=remoteWarmupReceipt(cfg.routes);
   const file=join(cfg.home,'runner-author.json');if(!existsSync(file))writeFileSync(file,JSON.stringify(keys()),{flag:'wx',mode:0o600,flush:true});
   service=new CenturyWarmupWorker({client:makeClient(join(cfg.home,'verifier')),url:cfg.url,checkpoint,key:JSON.parse(readFileSync(file,'utf8')),planHash:cfg.centuryPlanHash,receipt,broadcast,enabled:()=>!existsSync(join(cfg.home,'PAUSE'))});
  }else if(cfg.reservePolicyHash){
   assert(!cfg.custody,'program service must not contain fund custody keys');
   const file=join(cfg.home,'runner-author.json');if(!existsSync(file))writeFileSync(file,JSON.stringify(keys()),{flag:'wx',mode:0o600,flush:true});
   service=new ProgramWarmupWorker({home:cfg.home,client:makeClient(join(cfg.home,'verifier')),url:cfg.url,checkpoint,key:JSON.parse(readFileSync(file,'utf8')),policyHash:cfg.reservePolicyHash,routes:cfg.routes,broadcast,enabled:()=>!existsSync(join(cfg.home,'PAUSE'))});
  }else{
   assert(cfg.custody.length===2);for(let i=0;i<2;i++){
    const entry=cfg.custody[i],backup=JSON.parse(readFileSync(entry.vaultFile,'utf8'));assert.equal(backup.network,config.chainId);assert.equal(backup.configHash,hash(config));
    const password=readFileSync(entry.passwordFile,'utf8').replace(/\r?\n$/,''),key=unseal(backup.vault,password),home=join(cfg.home,'wallet'+i);
    wallets.push(new Wallet({home,key,client:makeClient(home),routes:cfg.routes,url:cfg.url,checkpoint}));
   }
   service=new WarmupWorker({home:cfg.home,wallets,policyHash:cfg.launchPolicyHash,enabled:()=>!existsSync(join(cfg.home,'PAUSE'))});
  }
  while(!stopping){
   if(!['signer','home-admission'].includes(cfg.mode))try{status({enabled:true,ok:true,...await service.cycle()});}catch{status({enabled:true,ok:false,error:'Verification or transport unavailable; durable work retained.'});}
   if(!stopping)await new Promise(r=>{const timer=setTimeout(r,cfg.mode==='signer'?30000:5000);wake=()=>{clearTimeout(timer);r();};});
  }
 }finally{if(httpServer)await httpServer.close();service?.close?.();for(const w of wallets)w.close();for(const c of clients)c.close();process.off('SIGTERM',stop);process.off('SIGINT',stop);}
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 assert(process.argv[2],'root-owned service configuration path required');await runRewardService(process.argv[2]);
}
