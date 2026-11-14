// Isolated purchase services: untrusted query payloads require verified consensus.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {hash,hex,integer,sign,exact} from '../crypto.mjs';
import {exportHeaders,verifyHeaders} from '../client.mjs';
import {verifyBoundedQuery} from './bounded-query.mjs';
import {PURCHASE,purchasePolicy,orderId} from './purchase-contract.mjs';
import {observeExternal,localRpc} from './purchase-observer.mjs';
import {RefundOutbox} from './purchase-refund-worker.mjs';

export function serviceRpc(spec,options={}){
 // Bitcoin rotates its local RPC credential on daemon restart. Never retain
 // an old cookie; a temporarily missing file must reject, not bypass auth.
 return localRpc(spec.url,{...options,headers:()=>spec.cookieFile?{Authorization:'Basic '+Buffer.from(fs.readFileSync(spec.cookieFile,'utf8')).toString('base64')}:{}});
}

export class CommittedPurchaseReader {
 constructor({home,binary,genesisFile,genesisHash,anchor,historyUrl,configHash,policy}){
  purchasePolicy(policy);hex(configHash);hex(genesisHash);hex(anchor.blockHash);
  assert.equal(anchor.height,1,'bootstrap must start at the genesis validator set');
  const genesis=JSON.parse(fs.readFileSync(genesisFile));assert.equal(hash(genesis),genesisHash);
  assert.equal(hash(genesis.app_state),configHash);assert.deepEqual(genesis.app_state.purchaseLab.policy,policy);
  assert(/^duebyte-trial-purchase-lab-/.test(genesis.chain_id));
  const url=new URL(historyUrl);assert(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&!url.username&&!url.password);
  Object.assign(this,{home,binary,genesisFile,anchor,historyUrl,configHash,policy});
  this.db=new DatabaseSync(join(home,'verified-head.sqlite'));
  this.db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS head(id INTEGER PRIMARY KEY,config TEXT NOT NULL,height INTEGER NOT NULL,hash TEXT NOT NULL)');
  const row=this.db.prepare('SELECT * FROM head WHERE id=1').get();if(row){assert.equal(row.config,configHash);this.anchor={height:row.height,blockHash:row.hash};}
 }
 read(response,id){
  hex(id);const end=response?.result?.height+1;integer(end,2);assert(end>=this.anchor.height,'committed head rollback');assert(end-this.anchor.height<512,'bounded header batch required');
  // Fetch the node's current committed head ourselves. A valid old proof is not
  // sufficient authority to spend after the order may have changed or closed.
  const file=join(this.home,'candidate-headers.json');exportHeaders(this.binary,this.genesisFile,this.historyUrl,this.anchor,null,file);
  const v=verifyHeaders(this.binary,this.genesisFile,file,this.anchor);assert.equal(v.height,end,'stale committed order proof; refresh');assert(v.verified);
  const result=verifyBoundedQuery(response,{type:'purchase-order',id},v.appHash,this.configHash);
  assert.equal(result.height,v.appHeight);assert(result.data&&orderId(result.data.offer)===id,'committed order required');
  assert.equal(result.data.offer.policyHash,hash(this.policy));
  this.db.prepare('INSERT INTO head VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET height=excluded.height,hash=excluded.hash').run(this.configHash,v.height,v.blockHash);
  this.anchor={height:v.height,blockHash:v.blockHash};return result.data;
 }
 close(){this.db.close();}
}
export function freshObservationTime(now,clock=Math.floor(Date.now()/1000)){
 integer(now,1);assert(now<=clock&&clock-now<=30,'fresh observation request required');return now;
}
// Event references are only hints: every value is independently read from RPC.
export async function checkRefundDeposits({order,refs,rpc,policy,now}){
 freshObservationTime(now);assert(Array.isArray(refs)&&refs.length>0&&refs.length<=16);
 assert.equal(refs.length,order.received.length,'complete deposit references required');const seen=new Set();
 for(const ref of refs){exact(ref,['txid','index']);hex(ref.txid);integer(ref.index);const body=await observeExternal({rpc,policy,offer:order.offer,txid:ref.txid,index:ref.index,pins:policy.rpcPins[order.offer.route],now});
  const event=hash({network:body.externalNetwork,txid:body.txid,index:body.index});assert(!seen.has(event),'duplicate deposit reference');seen.add(event);
  const record=order.received.find(x=>x.event===event);assert(record,'foreign deposit');assert.equal(body.amountAtomic,record.amountAtomic);assert.equal(body.paidAt,record.paidAt);
  assert(body.confirmations>=policy.routes[order.offer.route].confirmations,'deposit lost confirmation');
 }
 return [...seen].sort();
}
export async function observeCommitted({reader,key,rpcs,request}){
 const {proof,id,now}=request;freshObservationTime(now);const order=reader.read(proof,id),policy=reader.policy;assert(policy.attesters.includes(key.publicKey));
 let body;
 if(request.kind==='REFUND_INTENT'){
  assert(['PAYMENT_REVIEW','LATE_PAYMENT_REVIEW'].includes(order.status),'review order required');
  const refunds=await checkRefundDeposits({order,refs:request.deposits,rpc:rpcs[order.offer.route],policy,now});
  body={domain:PURCHASE+'/REFUND_INTENT',policyHash:hash(policy),network:policy.network,orderId:id,kind:'REFUND_INTENT',observedAt:now,destination:order.offer.refundDestination,amountAtomic:String(order.received.reduce((n,x)=>n+BigInt(x.amountAtomic),0n)),refunds};
 }else{
  assert(['PAYMENT','REFUND'].includes(request.kind));
  if(request.kind==='REFUND')assert(order.refundIntent,'committed refund intent required');
  body=await observeExternal({rpc:rpcs[order.offer.route],policy,offer:order.offer,txid:request.txid,index:request.index,pins:policy.rpcPins[order.offer.route],now,kind:request.kind,refunds:request.kind==='REFUND'?order.refundIntent.refunds:[]});
  // Independent nodes can have different tips. Once depth is sufficient, sign
  // the policy's required depth rather than disagreeing on surplus confirmations.
  body.confirmations=Math.min(body.confirmations,policy.routes[order.offer.route].confirmations);
 }
 return {body,approval:{key:key.publicKey,signature:sign(body,key.privateKey)}};
}
export class ProtectedRefundExecutor {
 constructor({home,reader,rpcs,adapters,maxAtomic}){
  // A separate SQLite exclusive lock is held for the entire executor lifetime.
  // OS releases it on process death; a second process cannot race the signer.
  this.lease=new DatabaseSync(join(home,'executor-lease.sqlite'));
  try{this.lease.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');this.box=new RefundOutbox(join(home,'refund-outbox.sqlite'));}
  catch(e){this.lease.close();throw e;}
  Object.assign(this,{reader,rpcs,adapters,maxAtomic});this.busy=false;
 }
 async execute(request){
  assert(!this.busy,'refund executor busy');this.busy=true;
  try{
   const order=this.reader.read(request.proof,request.id),policy=this.reader.policy,route=order.offer.route;
   assert(order.refundIntent,'committed refund intent required');assert(BigInt(order.refundIntent.amountAtomic)<=BigInt(this.maxAtomic[route]),'refund spending limit');
   await checkRefundDeposits({order,refs:request.deposits,rpc:this.rpcs[route],policy,now:Math.floor(Date.now()/1000)});
   return await this.box.execute({configHash:this.reader.configHash,order,adapter:this.adapters[route](),policy});
  }finally{this.busy=false;}
 }
 close(){this.box.close();this.lease.exec('ROLLBACK');this.lease.close();}
}
