// Bounded Linux/server verifier. Only quorum-assigned, already funded payment
// verification jobs are eligible; no wallet/spending key or automatic assignments.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {hash,sign,verify,hex} from './crypto.mjs';
import {envelope,stateHash} from './core.mjs';
import {VerifiedClient,rpc} from './client.mjs';

export class ServerRewardWorker{
 constructor({home,client,key,url,checkpoint,broadcast}){
  hex(key.node);const probe={domain:'DUEBYTE_SERVER_WORK_KEY_CHECK',node:key.node};
  assert(verify(probe,sign(probe,key.privateKey),key.publicKey),'work key pair mismatch');
  Object.assign(this,{client,key,url,checkpoint});this.busy=false;
  mkdirSync(home,{recursive:true,mode:0o700});this.db=new DatabaseSync(join(home,'funded-work.sqlite'));
  this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY,config TEXT NOT NULL,node TEXT NOT NULL); CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,version INTEGER NOT NULL,body TEXT NOT NULL)');
  const identity=this.db.prepare('SELECT * FROM identity WHERE id=1').get();
  if(identity){assert.equal(identity.config,hash(client.config));assert.equal(identity.node,key.node);}
  else this.db.prepare('INSERT INTO identity VALUES(1,?,?)').run(hash(client.config),key.node);
  this.broadcast=broadcast??(async wire=>{try{const r=await rpc(url,'broadcast_tx_sync',{tx:Buffer.from(JSON.stringify(wire)).toString('base64')});assert.equal(r.code,0,'work submission rejected');}catch(e){if(!e.message.includes('tx already exists in cache'))throw e;}});
 }
 async cycle(){
  if(this.busy)return {busy:true};this.busy=true;
  try{
   const {state:s,certificate}=await this.client.sync(await this.checkpoint(),this.url);
   assert.equal(stateHash(s,this.client.config),certificate.appHash);assert.equal(s.height,certificate.appHeight);
   const f=s.rewards?.fundedWork,n=s.rewards?.nodes[this.key.node];
   if(!f)return {height:s.height,submitted:0,ready:false};
   assert(n?.kind==='worker'&&n.key===this.key.publicKey,'server reward identity mismatch');
   const version=f.book.policy.version;
   // Remove only rows whose obsolete/terminal status was consensus-verified.
   for(const row of this.db.prepare('SELECT id,version FROM outbox').all()){
    assert(row.version<=version,'funded work rollback');
    if(row.version<version||f.book.jobs[row.id]?.status!=='assigned')this.db.prepare('DELETE FROM outbox WHERE id=?').run(row.id);
   }
   const entry=Object.entries(f.book.jobs).filter(([,j])=>j.request.node===this.key.node&&j.status==='assigned'&&s.money.time<=j.request.deadline).sort(([a],[b])=>a.localeCompare(b))[0];
   if(!entry)return {height:s.height,submitted:0,ready:true};
   const [id,j]=entry,target=f.targets[id];assert.equal(j.request.kind,'payment','unsupported server work class');
   const payment=s.money.requests[target.pid];assert(payment?.status==='SETTLED','payment is not final');
   assert.deepEqual(target,{pid:payment.intent.pid,digest:payment.digest,terminalHeight:payment.terminalHeight},'assigned payment differs');
   const body={domain:'DUEBYTE_FUNDED_WORK_V1/COMPLETE',configHash:s.configHash,assignment:id,result:hash(target)};
   let row=this.db.prepare('SELECT * FROM outbox WHERE id=?').get(id);
   if(!row){const wire=envelope(this.client.config,{type:'COMPLETE_REWARD_WORK_V1',body,signature:sign(body,this.key.privateKey)},this.key);this.db.prepare('INSERT INTO outbox VALUES(?,?,?)').run(id,version,JSON.stringify(wire));row={body:JSON.stringify(wire)};}
   const wire=JSON.parse(row.body);assert.deepEqual(wire.body.action.body,body,'saved work differs');
   await this.broadcast(wire);return {height:s.height,submitted:1,assignment:id,ready:true};
  }finally{this.busy=false;}
 }
 close(){this.db.close();}
}

if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 const [home,profile,url,binary,keyFile,policyPin]=process.argv.slice(2);
 assert(home&&profile&&url&&binary&&keyFile&&policyPin,'HOME PROFILE LOOPBACK_RPC VERIFIER WORK_KEY_FILE POLICY_HASH required');
 const read=f=>JSON.parse(readFileSync(join(profile,f))),policy=read('trust-policy.json');assert.equal(hash(policy),policyPin,'trust policy pin mismatch');
 const client=new VerifiedClient({home,config:read('app-config.json'),policy,genesisFile:join(profile,'genesis.json'),binary});
 const worker=new ServerRewardWorker({home,client,key:JSON.parse(readFileSync(keyFile)),url,checkpoint:async()=>{const q=await rpc(url,'abci_query',{path:'/checkpoint'});assert(!q.response.code,'checkpoint unavailable');return JSON.parse(Buffer.from(q.response.value,'base64'));}});
 let stopping=false,wake;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopping=true;wake?.();});
 try{while(!stopping){
  try{const result=await worker.cycle();writeFileSync(join(home,'status.json'),JSON.stringify({at:new Date().toISOString(),ok:true,...result}),{mode:0o600});}
  catch{writeFileSync(join(home,'status.json'),JSON.stringify({at:new Date().toISOString(),ok:false,error:'Verification or work submission unavailable; saved assignments retained.'}),{mode:0o600});}
  if(!stopping)await new Promise(r=>{const t=setTimeout(r,5000);wake=()=>{clearTimeout(t);r();};});
 }}finally{worker.close();client.close();}
}
