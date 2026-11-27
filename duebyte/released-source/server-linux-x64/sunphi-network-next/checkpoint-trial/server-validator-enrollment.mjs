import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {exact,hash,sign} from './crypto.mjs';
import {envelope} from './core.mjs';
import {consensusAddress} from './consensus-context.mjs';
import {validatorKey} from './local-validator-key.mjs';
import {fundingState,checkFundingConsent} from './funding-service.mjs';
import {checkBondRequest} from './bond-request.mjs';
import {FUND_WORKER} from './worker-collateral.mjs';
import {enrollmentReply} from './validator-enrollment.mjs';
import {JOIN_BONDED} from './research/bonded-queue.mjs';
import {openValidatorsActive} from './research/open-validator-policy.mjs';
import {signingKey} from './research/bounded-pos-records.mjs';
import {rpc} from './client.mjs';

export function nextValidatorAction(packet,state,record,link){
 const t=packet.template,p=state.authority.posSlashing;
 assert.equal(p?.policyHash,t.policyHash,'Bond policy changed.');
 const {template,...consent}=packet;
 if(!record&&!link){
  assert(state.money.time<packet.body.expires,'Validator authorization expired.');
  return {type:'BIND_CONSENSUS_BOND_V1',consent};
 }
 assert(link?.address===consensusAddress(t.validator) && record?.node===t.node && record.owner===t.owner &&
   record.consent===hash(consent),'Another validator binding exists.');
 assert(!record.signing.jailed&&!record.signing.tombstoned,'Validator is suspended.');
 if(p.activation===null || state.height<p.activation || !p.voting || !p.admissions?.anchor)return null;
 const v=p.voting;
 if(v.validators.some(m=>m.key===t.validator))return 'active';
 if([...(v.pending?.validators??[]),...(v.posNext?.validators??[])].some(m=>m.key===t.validator))return null;
 if(p.admissions.entries.some(e=>e.key===t.validator && e.readyUntil>state.money.time+120))return null;
 if(p.admissions.anchor.height<state.height-32)return null;
 return {type:JOIN_BONDED,validator:t.validator,anchor:p.admissions.anchor};
}

function localRpc(home){
 const toml=fs.readFileSync(path.join(home,'config/config.toml'),'utf8');
 const section=toml.split(/^\[rpc\][^\n]*\n/m)[1]?.split(/^\[/m)[0];
 const match=section?.match(/^\s*laddr\s*=\s*"tcp:\/\/(?:127\.0\.0\.1|0\.0\.0\.0|localhost):(\d+)"\s*$/m);
 assert(match && Number(match[1])<=65535,'Local consensus RPC unavailable.');
 return 'http://127.0.0.1:'+match[1];
}

export class ServerEnrollment {
 constructor(home,config,worker,handler){
  this.home=home;this.config=config;this.worker=worker;this.handler=handler;
  this.key=validatorKey(home);
  this.db=new DatabaseSync(path.join(home,'validator-enrollment.sqlite'));
  this.db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS enrollment(slot INTEGER PRIMARY KEY CHECK(slot=1),request TEXT NOT NULL,packet TEXT NOT NULL,status TEXT NOT NULL)');
  this.job=this.db.prepare('SELECT * FROM enrollment WHERE slot=1').get();
 }
 view(){
  const state=fundingState(this.handler,this.worker.node,{node:this.worker.node});
  assert(Math.abs(Date.now()/1000-state.money.time)<90,'Server is synchronizing.');
  const get=k=>this.handler.store.proof(k,this.handler.root).value;
  return {state,record:get(signingKey(consensusAddress(this.key.publicKey))),link:get('pos/bonds/'+this.worker.node)};
 }
 request(q){
  const v=this.view();
  if(q.phase==='reserve'){
   exact(q,['operation','phase','node','owner','packet','funding']);
   const digest=hash(q);
   if(this.job?.request!==digest){
    const offer=enrollmentReply({operation:q.operation,phase:'offer',node:q.node,owner:q.owner},
     {state:v.state,network:this.config.chainId,worker:this.worker,validator:this.key,binding:v.link});
    assert(!offer.body.bound,'The validator bond has already been recorded.');
    assert.deepEqual(q.packet.template,offer.body.template);
    checkBondRequest(q.packet,v.state.money.time,['owner']);
    assert.equal(q.funding.type,FUND_WORKER);
    assert.equal(q.funding.body.owner,q.owner);assert.equal(q.funding.body.node,q.node);
    const funding=fundingState(this.handler,q.node,q.funding.body);
    checkFundingConsent(q.funding,funding,this.worker);
    this.storeJob(digest,{packet:q.packet,depositDigest:hash(q.funding.body),sequence:q.funding.body.sequence},'funding',v.state.money.time);
   }
   const body={operation:q.operation,request:digest,status:'scheduled'};
   return {body,signature:sign(body,this.worker.privateKey)};
  }
  if(q.phase==='bind'&&this.job?.request===hash(q))return JSON.parse(this.job.packet);
  const packet=enrollmentReply(q,{state:v.state,network:this.config.chainId,worker:this.worker,validator:this.key,binding:v.link});
  if(q.phase==='bind'){
   this.storeJob(hash(q),packet,'waiting',v.state.money.time);
  }
  return packet;
 }
 storeJob(request,packet,status,time){
  if(this.job&&['waiting','funding'].includes(this.job.status)){
   const prior=JSON.parse(this.job.packet);
   assert((prior.packet??prior).body.expires<=time,'A validator authorization is already pending.');
  }
  const job={request,packet:JSON.stringify(packet),status};
  this.db.prepare('INSERT OR REPLACE INTO enrollment VALUES(1,?,?,?)').run(job.request,job.packet,job.status);
  this.job=job;this.tick();
 }
 tick(){
  if(this.running||!['waiting','funding','active'].includes(this.job?.status))return;
  if(this.job.status==='active'){
   if(Date.now()<(this.nextRosterCheck??0))return;
   this.nextRosterCheck=Date.now()+60000;
  }
  this.running=true;
  setImmediate(async()=>{
   try{
    if(this.job.status==='active'){
     const meta=this.handler.networkHeader();
     if(!openValidatorsActive(meta.rewards?.calendarService)||
        meta.authority?.posSlashing?.voting?.validators.some(m=>m.key===this.key.publicKey))return;
    }
    const {state,record,link}=this.view();
    if(this.job.status==='active'&&(!record||!link||record.signing.jailed||record.signing.tombstoned||
       BigInt(record.signing.bond)<BigInt(state.authority.bondedAdmission?.minimumMicro??'100000000')))return;
    let packet=JSON.parse(this.job.packet);
    if(this.job.status==='funding'){
     const term=packet.packet,account=state.workerFunding?.accounts[term.template.node];
     if(state.money.time>=term.body.expires){
      this.db.prepare("UPDATE enrollment SET status='expired' WHERE slot=1").run();this.job.status='expired';return;
     }
     if(account?.sequence!==packet.sequence||account.lastBodyHash!==packet.depositDigest)return;
     packet=enrollmentReply({operation:'DUEBYTE_VALIDATOR_ENROLLMENT_V1',phase:'bind',node:term.template.node,owner:term.template.owner,packet:term},
       {state,network:this.config.chainId,worker:this.worker,validator:this.key,binding:link});
     this.job.packet=JSON.stringify(packet);this.job.status='waiting';
     this.db.prepare("UPDATE enrollment SET packet=?,status='waiting' WHERE slot=1").run(this.job.packet);
    }
    const a=nextValidatorAction(packet,state,record,link);
    if(a==='active'){
     if(this.job.status==='active')return;
     this.db.prepare("UPDATE enrollment SET status='active' WHERE slot=1 AND request=?").run(this.job.request);
     this.job.status='active';return;
    }
    if(!a)return;
    const digest=hash(a);
    if(digest===this.lastDigest && state.height<this.lastHeight+3)return;
    this.lastDigest=digest;this.lastHeight=state.height;
    const tx=envelope(this.config,a,this.key);
    const res=await rpc(localRpc(this.home),'broadcast_tx_sync',{tx:Buffer.from(JSON.stringify(tx)).toString('base64')});
    assert(Number(res.code)===0,'Validator action was rejected by the node.');
   }catch(e){
    const message=String(e.message).split('\n')[0].slice(0,150);
    if(message!==this.lastError)console.warn('Validator enrollment:',message);
    this.lastError=message;
   }finally{this.running=false;}
  });
 }
}
