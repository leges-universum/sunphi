// Consensus is the durable outbox. Repeated submissions bind to the same
// sequence, intent and request digest; this runner holds no custody key.
import assert from 'node:assert/strict';
import {hash,exact,verify} from './crypto.mjs';
import {envelope,PROFILE} from './core.mjs';
import {receiptBody} from './payment-model.mjs';
import {assertBoundedServiceView,boundedHttpQuery} from './research/bounded-wallet-view.mjs';
import {verifyBoundedQuery} from './research/bounded-query.mjs';
import {WARMUP_EXECUTOR_V2} from './century-warmup.mjs';
import {UTC_OBLIGATIONS} from './obligation-clock.mjs';
import {assertZeroStageAttemptTerms} from './zero-stage.mjs';

export function remoteWarmupReceipt(routes) {
 const endpoints=new Map(Object.entries(routes).map(([node,url])=>{
  const u=new URL(url);assert(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash,'use authenticated worker tunnels');return [node,u.href];
 }));
 return async({pid,index,node,signal})=>{
  const url=endpoints.get(node);assert(url,'worker route unavailable');
  const timeout=AbortSignal.timeout(5000);
  const response=await fetch(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},signal:signal?AbortSignal.any([signal,timeout]):timeout,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'abci_query',params:{path:'/work',data:Buffer.from(JSON.stringify({pid,index})).toString('hex')}})});
  assert(response.ok,'worker receipt HTTP');let size=0;const chunks=[];
  try{for await(const chunk of response.body){size+=chunk.length;assert(size<=16384,'worker receipt size');chunks.push(chunk);}}
  catch(error){await response.body.cancel().catch(()=>{});throw error;}
  const reply=JSON.parse(Buffer.concat(chunks));assert(!reply.error&&reply.result?.response&&!reply.result.response.code,'worker receipt unavailable');
  return JSON.parse(Buffer.from(reply.result.response.value,'base64'));
 };
}

async function boundedReceipt(receipt,args){
 const controller=new AbortController();let timer;
 try{return await Promise.race([Promise.resolve().then(()=>receipt({...args,signal:controller.signal})),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('worker receipt timeout'));},5000);})]);}
 finally{clearTimeout(timer);}
}

export class CenturyWarmupWorker {
 constructor({client,url,checkpoint,key,planHash,query,receipt,broadcast,enabled=()=>false,now=()=>Math.floor(Date.now()/1000)}) {
  Object.assign(this,{client,url,checkpoint,key,planHash,query,receipt,broadcast,enabled,now});this.busy=false;
 }
 async cycle() {
  if(this.busy)return {waiting:true,reason:'another-cycle'};
  this.busy=true;
  try {
   const cp=typeof this.checkpoint==='function'?await this.checkpoint():this.checkpoint;
   const {state:s,certificate}=await this.client.sync(cp,this.url,{service:true});
   assertBoundedServiceView(s,certificate,this.client.config);
   const book=s.centuryWarmup;
   if(!book)return {paused:true,reason:'not-funded'};
   assert.equal(book.timeBasis,UTC_OBLIGATIONS,'UTC programme required');
   assert.equal(book.planHash,this.planHash,'warmup economic plan pin');
   if(this.now()-s.money.time>60||s.money.time>this.now()+10)return {paused:true,reason:'stale-consensus'};
   const root=certificate.appHash,configHash=hash(this.client.config);
   const query=this.query??boundedHttpQuery(this.client.bounded.url);
   const gather=async read=>{
    const get=async(type,id=null)=>{
     const request={type,id},result=verifyBoundedQuery(await read(request,root),request,root,configHash);
     assert.equal(result.height,certificate.appHeight,'mixed warmup height');
     assert(!result.isolatedIssuance,'isolated issuance view');return result.data;
    };
    if(book.pending){
     const q=await get('request',book.pending.pid);
     assert(q?.status==='RESERVED'&&hash(q.intent)===book.pending.intentHash,'pending warmup binding');
     assert.equal(q.intent.pid,book.pending.pid);assert.equal(q.digest,hash(q.intent));
     const nodes={};for(const id of new Set(q.intent.parts.flatMap(p=>p.nodes)))nodes[id]=await get('node',id);
     return {q,nodes};
    }
    if(!this.enabled()||book.version!==WARMUP_EXECUTOR_V2)return {paused:true};
    if(book.controller.pending&&s.money.time>=book.controller.pending.to)return {close:true};
    return {intent:(await get('warmup-plan')).intent};
   };
   // Do not hold a state lease while waiting for remote worker receipts.
   const work=query.withLease?await query.withLease(root,gather):await gather(query);
   let action;
   if(work.q){
    const q=work.q,pid=book.pending.pid;
    if(s.money.time>q.intent.deadline)action={type:'EXPIRE',pid,request:q.digest};
    else {
     const receipts=await Promise.all(q.intent.parts.flatMap((p,index)=>p.nodes.map(async node=>{
      const r=await boundedReceipt(this.receipt,{pid,index,node});exact(r,['index','node','signature','profileSignature',...(r.attestation?['attestation']:[])]);
      assert.equal(r.index,index);assert.equal(r.node,node);
      assert(work.nodes[node]&&verify(receiptBody(q,index,node),r.signature,work.nodes[node].key),'invalid worker receipt');
      assert(verify({domain:PROFILE+'/WORK',configHash,request:q.digest,index,node,signature:r.signature},r.profileSignature,work.nodes[node].key),'invalid network-bound worker receipt');
      // The consensus verifier additionally checks the retained liability
      // assignment and its attestation before releasing collateral.
      return r;
     })));
     action={type:'FINALIZE',pid,request:q.digest,receipts};
    }
   }else if(work.close)action={type:'CLOSE_CENTURY_WARMUP_INTERVAL_V1',sequence:book.controller.pending.sequence};
   else if(work.intent){
    try{assertZeroStageAttemptTerms(s.centuryFunds?.zeroStage,work.intent,s.money.time);}
    catch(error){if(error.code!=='ERR_ASSERTION')throw error;return {waiting:true,reason:'pilot-terms',detail:error.message};}
    action={type:'RUN_CENTURY_WARMUP_V1',sequence:book.controller.pending.sequence,intentHash:hash(work.intent)};
   }
   else return work.paused?{paused:true}:{waiting:true,reason:'no-certified-work'};
   await this.broadcast(envelope(this.client.config,action,this.key));
   return {submitted:action.type,sequence:book.pending?.sequence??book.controller.pending?.sequence};
  }finally{this.busy=false;}
 }
}
