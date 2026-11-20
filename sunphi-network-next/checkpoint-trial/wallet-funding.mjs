// One durable, exact deposit at a time. A server reply is not ledger inclusion.
import assert from 'node:assert/strict';import {exact,hash,hex,verify} from './crypto.mjs';
import {outgoingStatus} from './wallet.mjs';
import {initializeFundingOutbox,pendingFunding} from './funding-outbox.mjs';
export {initializeFundingOutbox,pendingFunding} from './funding-outbox.mjs';
import {envelope} from './core.mjs';import {WalletCollateral,collateralOptions} from './wallet-collateral.mjs';
import {FUNDING_REQUEST,FUNDING_REPLY} from './funding-service.mjs';import {formatToken} from './token-units.mjs';
import {ensureWorkRoutes} from './wallet-work.mjs';
import {prepareCollateralReview,prepareReleaseReview} from './worker-collateral-plan.mjs';import {rpc} from './client.mjs';
import {QUEUE_RELEASE,EXECUTE_RELEASE} from './worker-collateral.mjs';
const terminal=new Set(['COMMITTED','REJECTED','CANCELLED','EXPIRED','CONFLICT']);
export class WalletFunding extends WalletCollateral{
 constructor(wallet,options={}){super(wallet,options);initializeFundingOutbox(wallet.db);this.request=options.request??(async(node,consent)=>{const url=wallet.routes[node]??wallet.url;assert(url,'Server connection unavailable');const r=await rpc(url,'abci_query',{path:'/work',data:Buffer.from(JSON.stringify({operation:FUNDING_REQUEST,consent})).toString('hex')});assert(!r.response.code,'Server approval unavailable');return JSON.parse(Buffer.from(r.response.value,'base64'));});}
 rows(){return this.wallet.db.prepare('SELECT record FROM collateral_outgoing WHERE owner=? ORDER BY rowid DESC LIMIT 100').all(this.wallet.key.publicKey).map(r=>JSON.parse(r.record));}
 save(r){this.wallet.db.prepare('INSERT INTO collateral_outgoing VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(r.id,this.wallet.key.publicKey,JSON.stringify(r));}
 options(s){const o=collateralOptions(s,this.wallet.key.publicKey);o.nodes=o.nodes.map(n=>({...n,connected:!!(this.wallet.routes[n.id]??this.wallet.url)}));return {...o,mode:'NETWORK',broadcastEnabled:true,pending:this.rows().some(r=>!terminal.has(r.status))};}
 async current(options){const v=await super.current(options);if(this.checkPayments){for(const row of this.wallet.db.prepare('SELECT body FROM outgoing').all()){const intent=JSON.parse(row.body).body.action.signed.intent;if(intent.sender!==this.wallet.key.publicKey||this.wallet.terminalRecords?.()[intent.pid])continue;assert(!['QUEUED','HISTORY_UNAVAILABLE','REVIEW_REQUIRED'].includes(outgoingStatus(v.state,intent)),'Resolve pending payments before contributing collateral');}}return v;}
 async review(q){this.checkPayments=true;assert(!pendingFunding(this.wallet.db),'Finish or cancel the pending contribution first');hex(q.node);if(!this.wallet.routes[q.node])await ensureWorkRoutes({parts:[{nodes:[q.node]}],routes:this.wallet.routes,gateway:this.wallet.url});return {...await super.review(q),mode:'NETWORK'};}
 async pay(q,valid){
  exact(q,['requestId','operation','node','amount','unitScale']);hex(q.requestId);assert(['deposit','withdraw'].includes(q.operation));
  const prior=this.wallet.db.prepare('SELECT record FROM collateral_outgoing WHERE owner=? AND json_extract(record,\'$.clientId\')=?').get(this.wallet.key.publicKey,q.requestId);
  if(prior){const r=JSON.parse(prior.record);assert.equal(r.terms,hash(q),'Payment reference already used');return this.present(r);}
  const review=await this.review({node:q.node,amount:q.amount,unitScale:q.unitScale,...(q.operation==='withdraw'?{operation:'withdraw'}:{})});
  assert(valid(),'Wallet session expired before signature');return this.confirm({id:review.id},valid,{clientId:q.requestId,terms:hash(q)});
 }
 async confirm(q,valid=()=>true,tracking={}){this.checkPayments=true;assert(!pendingFunding(this.wallet.db),'A contribution is already pending');const consent=await super.confirm(q),id=hash(consent.body);
  assert(valid(),'Wallet session expired before submission');
  assert(!pendingFunding(this.wallet.db),'A contribution is already pending');
  this.save({id,consent,...tracking,wire:null,status:'AWAITING_SERVER',createdAt:this.now(),verifiedHeight:null});return this.resume({id});
 }
 present(r){const b=r.consent.body;return {id:r.id,node:b.node,operation:r.consent.type===QUEUE_RELEASE?'withdraw':'deposit',amount:formatToken(b.valueMicro,b.unitScale??'1000000'),expires:b.expires,status:r.status,verifiedHeight:r.verifiedHeight,canCancel:!r.wire&&!terminal.has(r.status),canRetry:!terminal.has(r.status),message:r.message??null};}
 cancel(q){exact(q,['id']);const r=this.rows().find(r=>r.id===q.id);assert(r&&!r.wire&&!terminal.has(r.status),'Already submitted; verify the network result');r.status='CANCELLED';r.message=null;this.save(r);return this.present(r);}
 async resume(q){this.checkPayments=false;exact(q,['id']);hex(q.id);const r=this.rows().find(r=>r.id===q.id);assert(r,'Unknown contribution');if(terminal.has(r.status))return this.present(r);
  try{const {state:s,certificate}=await this.current({rewardIds:[r.consent.body.node]}),b=r.consent.body,a=s.workerFunding?.accounts[b.node];
   const withdrawal=r.consent.type===QUEUE_RELEASE;
   if(withdrawal&&a?.owner===b.owner&&a.lastRelease?.sequence===b.sequence){
    r.status='COMMITTED';r.verifiedHeight=certificate.appHeight;r.message='Returned to your wallet.';this.save(r);return this.present(r);
   }
   if(a?.owner===b.owner&&a.sequence===b.sequence&&a.lastBodyHash===r.id){
    if(withdrawal){
     assert(a.release?.sequence===b.sequence);r.status='COOLDOWN';r.readyAt=a.release.readyAt;
     r.message='Withdrawal queued. Earliest return: '+new Date(r.readyAt*1000).toISOString()+'. Home checks the return while unlocked.';
     if(s.money.time>=r.readyAt){
      await this.wallet.broadcast(envelope(this.wallet.client.config,{type:EXECUTE_RELEASE,node:b.node,sequence:b.sequence},this.wallet.key));
      r.message='Return submitted. Waiting for network confirmation.';
     }
    }else{r.status='COMMITTED';r.message=null;}
    r.verifiedHeight=certificate.appHeight;this.save(r);return this.present(r);
   }
   if((a?.sequence??0)>=b.sequence){r.status=a.sequence===b.sequence?'CONFLICT':'RECONCILE_REQUIRED';r.message='Another collateral operation was confirmed. Check the server balance before continuing.';this.save(r);return this.present(r);}
   if(s.money.time>=b.expires){r.status='EXPIRED';r.message='The request expired without a confirmed deposit. Review again to create a new contribution.';this.save(r);return this.present(r);}
   if(r.status==='RECONCILE_REQUIRED')return this.present(r);
   assert.equal(s.money.nodes[b.node]?.key,r.consent.expectedWorkerKey,'Server key changed');
   const review=withdrawal?prepareReleaseReview(s,b):prepareCollateralReview(s,{node:b.node,owner:b.owner,inputs:b.inputs,amount:formatToken(b.valueMicro,b.unitScale),unitScale:b.unitScale});assert.deepEqual({...review.body,issuedAt:b.issuedAt,expires:b.expires},b,'Funding terms changed');
   if(!r.wire){const reply=await this.request(b.node,r.consent);exact(reply,['body','signature','action']);const rb=reply.body;exact(rb,['domain','id','node','status','actionHash']);assert.equal(rb.domain,FUNDING_REPLY);assert.equal(rb.id,r.id);assert.equal(rb.node,b.node);assert(verify(rb,reply.signature,r.consent.expectedWorkerKey),'Unverified server response');
    assert(['pending','approved','rejected','committed'].includes(rb.status));assert.equal(rb.actionHash,reply.action?hash(reply.action):null);
    if(rb.status==='rejected'){r.status='REJECTED';r.message='The server operator declined this contribution.';this.save(r);return this.present(r);}
    if(rb.status!=='approved'){assert.equal(reply.action,null);r.status='AWAITING_SERVER';r.message=rb.status==='committed'?'Checking the confirmed network result.':'Awaiting approval in the server management interface.';this.save(r);return this.present(r);}
    const action=reply.action;exact(action,['type','body','ownerSignature','workerSignature']);assert.equal(action.type,r.consent.type);assert.deepEqual(action.body,b);assert.equal(action.ownerSignature,r.consent.ownerSignature);assert(verify(b,action.workerSignature,r.consent.expectedWorkerKey),'Invalid server approval');
    r.wire=envelope(this.wallet.client.config,action,this.wallet.key);r.status='SUBMITTING';r.message=null;this.save(r);
   }
   await this.wallet.broadcast(r.wire);r.status='AWAITING_NETWORK';r.message='Sent for confirmation. The deposit is not confirmed yet.';
  }catch(error){r.message='Request saved. '+String(error.message??'Network verification unavailable.').slice(0,220);}
  this.save(r);return this.present(r);
 }
 async sync(){const pending=this.rows().filter(r=>!terminal.has(r.status));
  const active=pending.find(r=>r.status!=='COOLDOWN')??pending.filter(r=>r.readyAt<=this.now()/1000).sort((a,b)=>a.readyAt-b.readyAt)[0];
  if(active)await this.resume({id:active.id});return {requests:this.rows().map(r=>this.present(r))};}
}
