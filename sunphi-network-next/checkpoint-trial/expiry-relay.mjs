// Permissionless EXPIRE transport; never creates an intent or chooses a refund destination.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {keys} from './crypto.mjs';
import {envelope,stateHash} from './core.mjs';
import {VerifiedClient,rpc} from './client.mjs';
export class ExpiryRelay {
 constructor({client,key,url,checkpoint,batch=4,cooldownMs=30000,now=Date.now}){
  assert(Number.isInteger(batch)&&batch>=1&&batch<=16);assert(cooldownMs>=1000);
  Object.assign(this,{client,key,url,checkpoint,batch,cooldownMs,now});this.attempts=new Map();this.busy=false;
 }
 async cycle(){
  if(this.busy)return {busy:true};this.busy=true;
  try{
   const doc=await this.checkpoint(),{state,certificate}=await this.client.sync(doc,this.url);
   assert.equal(stateHash(state,this.client.config),certificate.appHash);assert.equal(state.height,certificate.appHeight);
   const requests=state.money.requests,now=this.now();
   for(const pid of this.attempts.keys())if(requests[pid]?.status!=='RESERVED')this.attempts.delete(pid);
   // A strictly past certified height avoids an early expiry when the chain stops.
   const due=Object.entries(requests).filter(([pid,r])=>r.status==='RESERVED'&&state.money.height>r.intent.deadline&&now-(this.attempts.get(pid)??-Infinity)>=this.cooldownMs).sort(([a,x],[b,y])=>x.intent.deadline-y.intent.deadline||a.localeCompare(b)).slice(0,this.batch),submitted=[];
   for(const [pid,r] of due){
    this.attempts.set(pid,now);while(this.attempts.size>256)this.attempts.delete(this.attempts.keys().next().value);
    const wire=envelope(this.client.config,{type:'EXPIRE',pid,request:r.digest},this.key);
    try{const result=await rpc(this.url,'broadcast_tx_sync',{tx:Buffer.from(JSON.stringify(wire)).toString('base64')});submitted.push({pid,admitted:result.code===0});}
    catch(e){if(e.message.includes('tx already exists in cache'))submitted.push({pid,admitted:true});else throw e;}
   }
   return {height:certificate.height,moneyHeight:state.money.height,submitted};
  }finally{this.busy=false;}
 }
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 const [home,profile,url,binary]=process.argv.slice(2);assert(home&&profile&&url&&binary);
 mkdirSync(home,{recursive:true,mode:0o700});const read=f=>JSON.parse(readFileSync(join(profile,f)));
 const file=join(home,'relay-key.json');if(!existsSync(file))writeFileSync(file,JSON.stringify(keys()),{flag:'wx',mode:0o600,flush:true});
 const client=new VerifiedClient({home,config:read('app-config.json'),policy:read('trust-policy.json'),genesisFile:join(profile,'genesis.json'),binary});
 const relay=new ExpiryRelay({client,key:JSON.parse(readFileSync(file)),url,checkpoint:async()=>{const q=await rpc(url,'abci_query',{path:'/checkpoint'});assert(!q.response.code,'checkpoint unavailable');return JSON.parse(Buffer.from(q.response.value,'base64'));}});
 let stopping=false,wake;process.on('SIGTERM',()=>{stopping=true;wake?.();});process.on('SIGINT',()=>{stopping=true;wake?.();});
 try{while(!stopping){try{const result=await relay.cycle();writeFileSync(join(home,'status.json'),JSON.stringify({at:new Date().toISOString(),ok:true,...result}));if(result.submitted.length)console.log(JSON.stringify(result));}catch(e){writeFileSync(join(home,'status.json'),JSON.stringify({at:new Date().toISOString(),ok:false,error:e.message}));console.error('Expiry verification/submission unavailable: '+e.message);}if(!stopping)await new Promise(r=>{const t=setTimeout(r,5000);wake=()=>{clearTimeout(t);r();};});}}
 finally{client.close();}
}
