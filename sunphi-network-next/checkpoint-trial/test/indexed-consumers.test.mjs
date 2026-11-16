import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fixture} from '../../research/transition-core-20261103/fixture.mjs';
import {keys,hash,sign} from '../crypto.mjs';
import {PROFILE,origin} from '../core.mjs';
import {Wallet} from '../wallet.mjs';
import {SunPhiApproval} from '../sunphi-approval.mjs';
import {verifyApprovalRequest} from '../approval-transport.mjs';
import {createDevice,deviceDecision} from '../../sunphi-wallet/frontend/approval-device.mjs';
import {createWalletBridge} from '../../sunphi-wallet/edge.mjs';
import {indexedApprovalEvidence} from '../../sunphi-wallet/indexed-approval.mjs';
import {BoundedNetworkInterpreter,BOUNDED_DOMAIN} from '../research/bounded-network-interpreter.mjs';
import {queryBounded,verifyBoundedQuery} from '../research/bounded-query.mjs';
import {loadBoundedWalletView,loadBoundedServiceView,loadBoundedHistoryPage,assertBoundedWalletView,assertBoundedServiceView,boundedHttpQuery} from '../research/bounded-wallet-view.mjs';
import {createBoundedApi} from '../research/bounded-api.mjs';
import {RewardWorker} from '../reward-worker.mjs';
import {WalletStore} from '../wallet-store.mjs';
import {rewardNodeId} from '../node-rewards.mjs';
import {createHash} from 'node:crypto';
import {envelope,workReceipt} from '../core.mjs';

export function rig(){
 const f=fixture(),validators=Array.from({length:10},keys),members=Array.from({length:4},keys),now=Math.floor(Date.now()/1000);f.state.time=now;
 const c={profile:PROFILE,chainId:'duebyte-trial-indexed-consumers',initial:f.state,trialOnly:true,control:{validators:validators.map((k,i)=>({key:k.publicKey,group:hash(i)})),policy:{version:1,members:members.map((k,i)=>({key:k.publicKey,group:hash(i)})),threshold:3,maxAge:3600,notAfter:now+86400}}};
 const s=origin(c);s.authority.spendProtection={activation:1};s.height=1;s.money.height=1;s.blockHash=hash('initial');
 const home=fs.mkdtempSync(join(tmpdir(),'indexed-consumers-')),file=join(home,'state.sqlite'),db=BoundedNetworkInterpreter.create(file,s,c,hash(s));
 const rootPolicy={...c.control.policy,network:c.chainId,genesisHash:hash('genesis')},anchor=db.store.proof('meta/anchor',db.root).value;
 const terms={network:c.chainId,configHash:hash(c),targetSchema:BOUNDED_DOMAIN,sourceHeight:s.height,sourceRoot:hash(s),archive:anchor.archive,activationHeight:1,issuance:false};
 const pins={root:rootPolicy,configHash:hash(c),indexedTransition:terms},query=(q,r)=>queryBounded(db,q,r);
 const view=async(owner,options={})=>({...await loadBoundedWalletView(query,{root:db.root,height:db.networkHeader().height,configHash:hash(c),owner,...options}),certificate:{appHash:db.root,appHeight:db.networkHeader().height}});
 const checkpoint=()=>{const height=db.networkHeader().height,b={domain:'DUEBYTE_CHECKPOINT_TRIAL_V1',policyHash:hash(rootPolicy),network:c.chainId,genesisHash:rootPolicy.genesisHash,sequence:height,height:height+1,blockHash:hash(['block',height+1]),appHeight:height,appHash:db.root,snapshotHash:hash('manifest'),previous:null,issuedAt:now,expiresAt:now+120};return {body:b,signatures:members.slice(0,3).map(k=>({key:k.publicKey,signature:sign(b,k.privateKey)}))};};
 const evidence=(owner,pid=null)=>{const request={type:'approval-context',id:{owner,pid}},proof=query(request,db.root);return {checkpoint:checkpoint(),proof,state:verifyBoundedQuery(proof,request,db.root,hash(c)).data.state};};
 const commit=wire=>{const h=db.networkHeader().height+1;db.commitBlock({height:h,time:now,blockHash:hash(['block',h]),txs:wire?[Buffer.from(JSON.stringify(wire))]:[]},db.root);};
 return {f,c,db,file,home,now,pins,query,view,evidence,commit,validators};
}

test('indexed approval signs exact device decisions, retries lost replies and rejects forged or unconfigured proofs',async()=>{
 const r=rig(),{c,f,db,now,pins}=r,rows=new Map();let lost=true,broadcasts=0;
 const client={config:c,bounded:true,sync:async(_doc,_url,o)=>r.view(o.owner,o),approvalEvidence:async(_doc,_url,owner,pid)=>r.evidence(owner,pid)};
 const wallet=new Wallet({client,key:f.alice,home:r.home,routes:Object.fromEntries(Object.keys(r.c.initial.nodes).map(id=>[id,'http://127.0.0.1:1'])),url:'isolated',checkpoint:{}});
 wallet.broadcast=async wire=>{broadcasts++;r.commit(wire);};
 const connection={refresh:async()=>{},signed:(_key,action,{id})=>({action,id}),call:async q=>{
  if(q.action==='approval_open'){
   assert(!q.state);const state=await indexedApprovalEvidence(q.checkpoint,q.proof,q.packet,pins,now),context=verifyApprovalRequest(q.packet,state,pins,now);
   if(!rows.has(context.id))rows.set(context.id,{id:context.id,context,status:'pending'});if(lost){lost=false;throw Error('lost reply');}return rows.get(context.id);
  }return rows.get(q.id);
 }};
 const options={connection,wallet,store:{sunphiLink:()=>({status:'linked'})},walletId:'test',checkpoint:async()=>({}),now:()=>now};let approval=new SunPhiApproval(options);
 try{
  await assert.rejects(()=>approval.policy(true),/lost reply/);approval=new SunPhiApproval(options);await approval.sync();assert.equal(rows.size,1);
  const row=[...rows.values()][0],packet=row.context.request,ev=r.evidence(f.alice.publicKey);
  const bridge=createWalletBridge({pins,approvals:true,now:()=>now,db:async()=>({ok:true})});
  const send=q=>bridge(new Request('https://test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(q)}));
  assert.equal((await send({action:'approval_open',packet,checkpoint:ev.checkpoint,proof:ev.proof})).status,200);
  assert.equal((await send({action:'approval_open',packet,checkpoint:ev.checkpoint,state:ev.state})).status,400);
  for(const mutate of [e=>e.proof.proofs.pop(),e=>e.checkpoint.signatures.pop(),e=>e.proof.result.height++,e=>e.proof.result.data.state.money.outputs={},e=>e.proof.request.id.owner=keys().publicKey,e=>e.checkpoint.body.expiresAt=now-1]){
   const bad=structuredClone(ev);mutate(bad);await assert.rejects(()=>indexedApprovalEvidence(bad.checkpoint,bad.proof,packet,pins,now));
  }
  await assert.rejects(()=>indexedApprovalEvidence(ev.checkpoint,ev.proof,packet,{...pins,indexedTransition:null},now));
  const device=await createDevice(row.context,'isolated-indexed-password');row.response=await deviceDecision(row.context,device.material,{recovery:device.recovery});row.status='approved';
  await approval.sync();await approval.sync();assert.equal(broadcasts,1);assert.equal(db.networkHeader().spendPolicies[f.alice.publicKey].enabled,true);
  const payment=await wallet.prepare(f.bob.publicKey,'1');assert.equal((await wallet.resume(payment.pid)).status,'AWAITING_APPROVAL');
  const opened=await approval.payment(payment.pid),p=rows.get(opened.id);p.response=await deviceDecision(p.context,device.material);p.status='approved';
  await approval.sync();await approval.sync();assert.equal(broadcasts,2);assert.equal(db.snapshotForAudit().money.requests[payment.pid].status,'RESERVED');
  const stale=r.evidence(f.alice.publicKey,payment.pid);assert.throws(()=>verifyApprovalRequest(p.context.request,stale.state,pins,now),/already submitted/);
  assert.equal(db.snapshotForAudit().money.supply,c.initial.supply);
 }finally{wallet.close();db.close();}
});

test('history pages remain stable across new arrivals, include completed incoming payments and reject gaps',async()=>{
 const r=rig(),owner=r.f.alice.publicKey,other=r.f.bob.publicKey;
 // Populate a deterministic index using committed requests; the UI must not
 // depend on a local outbox to discover incoming history.
 const wallet=new Wallet({client:{config:r.c,bounded:true,sync:async(_d,_u,o)=>r.view(o.owner,o)},key:r.f.alice,home:r.home,routes:Object.fromEntries(Object.keys(r.c.initial.nodes).map(id=>[id,'http://127.0.0.1:1'])),url:'isolated',checkpoint:{}});
 let server;
 try{
  const p=await wallet.prepare(other,'1'),wire=JSON.parse(wallet.db.prepare('SELECT body FROM outgoing WHERE pid=?').get(p.pid).body);r.commit(wire);
  const page=await loadBoundedHistoryPage(r.query,{root:r.db.root,height:r.db.networkHeader().height,configHash:hash(r.c),owner:other});assert.equal(page.items[0].id,p.pid);
  const {workReceipt,envelope}=await import('../core.mjs'),s=r.db.snapshotForAudit(),i=s.money.requests[p.pid].intent;
  r.commit(envelope(r.c,{type:'FINALIZE',pid:i.pid,request:hash(i),receipts:i.parts.flatMap((part,index)=>part.nodes.map(node=>workReceipt(s,i.pid,index,node,{publicKey:s.money.nodes[node].key,privateKey:r.f.nodeKeys[node]})))},r.f.alice));
  const received=await r.view(other);assert.equal(received.state.money.requests[p.pid].status,'SETTLED');assert.equal(received.history.total,1);
  const next=await wallet.prepare(other,'1');r.commit(JSON.parse(wallet.db.prepare('SELECT body FROM outgoing WHERE pid=?').get(next.pid).body));
  server=createBoundedApi(r.db);await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const http=boundedHttpQuery('http://127.0.0.1:'+server.address().port);
  const args={root:r.db.root,height:r.db.networkHeader().height,configHash:hash(r.c),owner:other,through:page.total};
  const fixed=await loadBoundedHistoryPage(http,args);assert.equal(fixed.total,1);assert.equal(fixed.available,2);assert.equal(fixed.items[0].id,p.pid);
  const latest=await loadBoundedHistoryPage(http,{...args,through:null});assert.equal(latest.items[0].id,next.pid);
  await assert.rejects(()=>loadBoundedHistoryPage(http,{...args,through:3}));await assert.rejects(()=>loadBoundedHistoryPage(http,{...args,offset:2}));
  assert.equal((await loadBoundedHistoryPage(http,{...args,owner:keys().publicKey,through:null})).total,0);
  const query={type:'wallet-page',id:{owner:other,kind:'history',offset:0,limit:1}},proof=queryBounded(r.db,query,r.db.root);proof.result.data.total--;assert.throws(()=>verifyBoundedQuery(proof,query,r.db.root,hash(r.c)));
  const reopened=BoundedNetworkInterpreter.open(r.file,r.c,r.db.root);try{assert.equal(queryBounded(reopened,query,reopened.root).result.data.total,2);}finally{reopened.close();}
  const pending=r.db.snapshotForAudit(),ni=pending.money.requests[next.pid].intent;
  r.commit(envelope(r.c,{type:'FINALIZE',pid:ni.pid,request:hash(ni),receipts:ni.parts.flatMap((part,index)=>part.nodes.map(node=>workReceipt(pending,ni.pid,index,node,{publicKey:pending.money.nodes[node].key,privateKey:r.f.nodeKeys[node]})))},r.f.alice));
  for(let n=0;n<34;n++){
   const p=await wallet.prepare(other,'1'),wire=JSON.parse(wallet.db.prepare('SELECT body FROM outgoing WHERE pid=?').get(p.pid).body);r.commit(wire);
   const state=r.db.snapshotForAudit(),i=state.money.requests[p.pid].intent;
   r.commit(envelope(r.c,{type:'FINALIZE',pid:i.pid,request:hash(i),receipts:i.parts.flatMap((part,index)=>part.nodes.map(node=>workReceipt(state,i.pid,index,node,{publicKey:state.money.nodes[node].key,privateKey:r.f.nodeKeys[node]})))},r.f.alice));
  }
  const all=[];for(let offset=0;offset<36;offset+=12){const part=await loadBoundedHistoryPage(http,{...args,root:r.db.root,height:r.db.networkHeader().height,through:36,offset,limit:12});assert.equal(part.total,36);all.push(...part.items.map(i=>i.id));}
  assert.equal(new Set(all).size,36);assert(all.includes(p.pid));
  assert.equal(r.db.snapshotForAudit().money.supply,r.c.initial.supply);
 }finally{if(server){server.closeAllConnections();await new Promise(ok=>server.close(ok));}wallet.close();r.db.close();}
});

test('indexed background enrollment and consent binding retry without wallet unlock or unsupported paid witnesses',async()=>{
 const r=rig(),work=keys(),management=keys(),identity=keys(),peer=createHash('sha256').update(Buffer.from(identity.publicKey,'base64url')).digest('hex').slice(0,40),home=join(r.home,'wallet');
 fs.mkdirSync(join(r.home,'node/config'),{recursive:true});fs.writeFileSync(join(r.home,'reward-identity.json'),JSON.stringify({version:1,network:r.c.chainId,configHash:hash(r.c),work,management}));
 fs.writeFileSync(join(r.home,'node/config/node_key.json'),JSON.stringify({priv_key:{type:'tendermint/PrivKeyEd25519',value:Buffer.concat([Buffer.from(identity.privateKey,'base64url').subarray(-32),Buffer.from(identity.publicKey,'base64url')]).toString('base64')}}));
 const store=new WalletStore(home,r.c.chainId),sent=[],node=rewardNodeId(hash(r.c),work.publicKey);
 // The fixture retains the validator keys solely for synthetic governance.
 try{
  const state=r.db.snapshotForAudit(),body={domain:'DUEBYTE_NODE_REWARDS_V1/ENABLE_NODE_REWARDS_V1',network:r.c.chainId,configHash:hash(r.c),generation:0,notBefore:2,expires:3,activation:5,coefficients:{version:1,periodBlocks:10,workerWeight:1,witnessWeight:1,alphaPPM:0,periodMintLimit:'0',lifetimeMintLimit:'0'},allowedPeers:[peer]};
  const {REWARDS}=await import('../node-rewards.mjs');body.domain=REWARDS+'/ENABLE_NODE_REWARDS_V1';
  r.commit(envelope(r.c,{type:'ENABLE_NODE_REWARDS_V1',certificate:{body,approvals:r.validators.slice(0,7).map(k=>({key:k.publicKey,signature:sign(body,k.privateKey)}))}},r.f.alice));while(!r.db.networkHeader().rewards)r.commit();
  const view=async()=>({...await loadBoundedServiceView(r.query,{root:r.db.root,height:r.db.networkHeader().height,configHash:hash(r.c),rewardIds:[node]}),certificate:{appHash:r.db.root,appHeight:r.db.networkHeader().height}}),options={home,config:r.c,store,url:'isolated',historyUrl:'isolated',snapshotReader:async()=>{throw Error('legacy history must not be read');},broadcast:async w=>sent.push(w)};
  let worker=new RewardWorker(options);
  const incomplete={...await loadBoundedServiceView(r.query,{root:r.db.root,height:r.db.networkHeader().height,configHash:hash(r.c)}),certificate:{appHash:r.db.root,appHeight:r.db.networkHeader().height}};
  await assert.rejects(()=>worker.tick(incomplete),/membership was not queried/);assert.equal(sent.length,0);
  await worker.tick(await view());assert.equal(sent[0].body.action.type,'REGISTER_REWARD_NODE_V1');r.commit(sent.pop());await worker.tick(await view());assert.equal(sent.length,0);
  store.create('isolated-background-consent','Reward wallet');await worker.tick(await view());const first=sent.pop();assert.equal(first.body.action.type,'BIND_REWARD_WALLETS_V1');worker=new RewardWorker(options);await worker.tick(await view());assert.equal(hash(sent.pop()),hash(first));r.commit(first);await worker.tick(await view());assert.equal(sent.length,0);assert.equal((await view()).state.rewards.nodes[node].sequence,1);
  while(r.db.networkHeader().rewards.period.index<2)r.commit();await worker.tick(await view());assert.equal(sent.length,0);assert.equal(r.db.snapshotForAudit().money.supply,state.money.supply);assert.equal(r.db.networkHeader().rewards.minted,'0');
 }finally{store.close();r.db.close();}
});

test('locked reward reader verifies accounting without wallet authority or manufactured work',async()=>{
 const r=rig(),home=join(r.home,'wallet');fs.mkdirSync(home);const work=keys(),management=keys();fs.writeFileSync(join(r.home,'reward-identity.json'),JSON.stringify({version:1,network:r.c.chainId,configHash:hash(r.c),work,management}));
 const store=new WalletStore(home,r.c.chainId),sent=[],worker=new RewardWorker({home,config:r.c,store,url:'isolated',historyUrl:'isolated',broadcast:async w=>sent.push(w)});
 try{
  const options={root:r.db.root,height:r.db.networkHeader().height,configHash:hash(r.c)},v={...await loadBoundedServiceView(r.query,options),certificate:{appHash:r.db.root,appHeight:options.height}};
  assertBoundedServiceView(v.state,v.certificate,r.c);assert.throws(()=>assertBoundedWalletView(v.state,v.certificate,r.c,r.f.alice.publicKey),/owner/);
  const summary=await worker.tick(v);assert.equal(summary.node,rewardNodeId(hash(r.c),work.publicKey));assert.match(summary.message,/awaiting network activation/);assert.equal(sent.length,0);
  await assert.rejects(()=>worker.tick({...v,state:structuredClone(v.state)}));v.state.money.supply='0';await assert.rejects(()=>worker.tick(v),/modified/);assert.equal(sent.length,0);
 }finally{store.close();r.db.close();}
});
