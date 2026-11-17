// Local operator workflow for an existing home-admission service configuration.
// Output contains public requests/proposals only. Approval keys are never loaded.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {hash,hex} from './crypto.mjs';
import {VerifiedClient,rpc} from './client.mjs';
import {HomeAdmissionQueue} from './home-admission-service.mjs';
import {assertBoundedServiceView,usesIndexedHomeAdmission} from './research/bounded-wallet-view.mjs';
export async function homeAdmissionOperator(file,command,arg){
 assert(['pending','proposal','publish'].includes(command));
 const st=fs.statSync(file);if(process.platform==='linux'){assert.equal(st.uid,0);assert.equal(st.mode&0o022,0);}
 const cfg=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(cfg.mode,'home-admission');assert(cfg.bounded);
 const read=name=>JSON.parse(fs.readFileSync(join(cfg.profile,name),'utf8')),config=read('app-config.json'),policy=read('trust-policy.json');assert.equal(hash(policy),cfg.policyPin);
 const queue=new HomeAdmissionQueue({file:join(cfg.home,'home-admission.sqlite'),config,capacity:cfg.capacity??4096});let client;
 try{
  if(command==='pending')return queue.pending({after:arg??'',limit:32});
  const home=join(cfg.home,'operator-verifier');fs.mkdirSync(home,{recursive:true,mode:0o700});
  client=new VerifiedClient({home,config,policy,genesisFile:join(cfg.profile,'genesis.json'),binary:cfg.binary,bounded:cfg.bounded});
  const q=await rpc(cfg.url,'abci_query',{path:'/checkpoint'});assert(!q.response.code);const checkpoint=JSON.parse(Buffer.from(q.response.value,'base64'));
  const view=await client.sync(checkpoint,cfg.url,{service:true});assertBoundedServiceView(view.state,view.certificate,config);assert(usesIndexedHomeAdmission(view.state));assert(Math.abs(Math.floor(Date.now()/1000)-view.state.money.time)<=120,'stale enrollment state');
  if(command==='proposal'){hex(arg);return queue.proposal(arg,view.state);}
  assert(fs.statSync(arg).size<=65536,'signed offer size');return queue.publish(JSON.parse(fs.readFileSync(arg,'utf8')),view.state);
 }finally{queue.close();client?.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 const [file,command,arg]=process.argv.slice(2);console.log(JSON.stringify(await homeAdmissionOperator(file,command,arg),null,2));
}
