import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {rig} from './indexed-consumers.test.mjs';
import {homeFixture} from './century-home-funds.test.mjs';
import {settleProgramme} from './century-subsidy.test.mjs';
import {compactJournalBatch,decodeJournalText} from '../research/journal-codec.mjs';
import {hash,sign,keys} from '../crypto.mjs';
import {envelope,workReceipt} from '../core.mjs';
import {Wallet} from '../wallet.mjs';
import {WalletStore} from '../wallet-store.mjs';
import {RewardWorker} from '../reward-worker.mjs';
import {VerifiedClient} from '../client.mjs';
import {BoundedNetworkInterpreter} from '../research/bounded-network-interpreter.mjs';
import {queryBounded} from '../research/bounded-query.mjs';
import {createBoundedApi} from '../research/bounded-api.mjs';
import {boundedHttpQuery,loadBoundedServiceView} from '../research/bounded-wallet-view.mjs';
import {centuryHomeBody,INDEXED_HOME,INDEXED_HOME_ACTION} from '../century-home.mjs';
import {REWARDS,walletConsent} from '../node-rewards.mjs';
import {createWalletBridge} from '../../sunphi-wallet/edge.mjs';
import {indexedNotificationEvidence} from '../../sunphi-wallet/indexed-notifications.mjs';
import {observeIndexedPage} from '../../sunphi-wallet/indexed-observer.mjs';

test('indexed notification journal preserves intermediate states, retries and authenticates every page',async()=>{
 const r=rig(),wallet=new Wallet({client:{config:r.c,bounded:true,sync:async(_d,_u,o)=>r.view(o.owner,o)},key:r.f.alice,home:r.home,routes:{},url:'isolated',checkpoint:{}});
 let server;try{
  for(let n=0;n<6;n++){
   const p=await wallet.prepare(r.f.bob.publicKey,'1');r.commit(JSON.parse(wallet.db.prepare('SELECT body FROM outgoing WHERE pid=?').get(p.pid).body));
   const s=r.db.snapshotForAudit(),i=s.money.requests[p.pid].intent;r.commit(envelope(r.c,{type:'FINALIZE',pid:p.pid,request:hash(i),receipts:i.parts.flatMap((part,index)=>part.nodes.map(node=>workReceipt(s,i.pid,index,node,{publicKey:s.money.nodes[node].key,privateKey:r.f.nodeKeys[node]})))},r.f.alice));
  }
  const checkpoint=r.evidence(r.f.alice.publicKey).checkpoint,proof=r.query({type:'payment-events',id:{offset:0,limit:8}},r.db.root),page=await indexedNotificationEvidence(checkpoint,proof,r.pins,null,r.now);
  assert.equal(page.total,12);assert.equal(page.events.length,8);assert.deepEqual(page.events.slice(0,2).map(x=>x.event.status),['RESERVED','SETTLED']);
  for(const mutate of [x=>x.proofs.pop(),x=>x.result.data.items[0].value.intent.value='999',x=>x.request.id.offset=1,x=>x.result.data.total++]){const bad=structuredClone(proof);mutate(bad);await assert.rejects(()=>indexedNotificationEvidence(checkpoint,bad,r.pins,null,r.now));}
  const minority=structuredClone(checkpoint);minority.signatures.pop();await assert.rejects(()=>indexedNotificationEvidence(minority,proof,r.pins,null,r.now));
  await assert.rejects(()=>indexedNotificationEvidence(checkpoint,proof,{...r.pins,indexedTransition:null},null,r.now));
  let cursor=0,lost=true;const events=new Map(),writes=[];
  const bridge=createWalletBridge({pins:r.pins,notifications:true,now:()=>r.now,db:async(path,options)=>{
   if(!options)return [];const body=JSON.parse(options.body);writes.push(path);
   if(path.endsWith('duebyte_indexed_payment_observe_v1')){const p=body.p;assert(p.offset<=cursor);for(const e of p.events)events.set(e.event.id,e.event);cursor=Math.max(cursor,p.end);return {cursor};}
   assert.equal(body.p_action,'deliver');return {delivered:0};
  }});
  const send=async packet=>{const response=await bridge(new Request('https://isolated',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(packet)}));assert.equal(response.status,200);if(lost){lost=false;throw Error('lost receipt');}return response.json();};
  server=createBoundedApi(r.db);await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const query=boundedHttpQuery('http://127.0.0.1:'+server.address().port);
  const args={checkpoint,query,pins:r.pins,send,now:r.now};await assert.rejects(()=>observeIndexedPage(args),/lost receipt/);assert.equal(cursor,8);
  const first=await observeIndexedPage(args);assert.equal(first.receipt.cursor,8);assert(first.backlog);const second=await observeIndexedPage({...args,previous:first});assert.equal(second.receipt.cursor,12);assert.equal(second.backlog,false);assert.equal(events.size,12);
  const raw=await bridge(new Request('https://isolated',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'observe_payments',checkpoint,state:r.db.snapshotForAudit()})}));assert.equal(raw.status,400);
  assert.equal(r.db.snapshotForAudit().money.supply,r.c.initial.supply);const root=r.db.root;r.db.close();r.db=BoundedNetworkInterpreter.open(r.file,r.c,root);assert.equal(queryBounded(r.db,{type:'payment-events',id:{offset:8,limit:8}},root).result.data.items.length,4);
 }finally{if(server){server.closeAllConnections();await new Promise(ok=>server.close(ok));}wallet.close();r.db.close();}
});

test('assigned record proof earns once; wrong record, signer, root, omission and expiry earn nothing',async()=>{
 const x=homeFixture(2,{nodeCapMicro:'15000',groupCapMicro:'15000'}),initial=structuredClone(x.s);initial.centurySubsidy.policy.home.version=INDEXED_HOME;initial.centurySubsidy.pending.home.sample=null;initial.centurySubsidy.pending.home.jobs={};
 const dir=fs.mkdtempSync(join(tmpdir(),'indexed-work-')),file=join(dir,'state.sqlite');let db=BoundedNetworkInterpreter.create(file,initial,x.c,hash(initial),{isolatedIssuance:true});
 const step=(wires=[],time=db.snapshotForAudit().money.time)=>{const height=db.networkHeader().height+1;return db.commitBlock({height,time,blockHash:hash(['sample',height]),txs:wires.map(w=>Buffer.from(JSON.stringify(w)))},db.root);};
 const reject=wire=>{const root=db.root;assert.throws(()=>step([wire]));assert.equal(db.root,root);};let server,store;
 try{
  server=createBoundedApi(db);await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const url='http://127.0.0.1:'+server.address().port;
  step();const assigned=db.snapshotForAudit(),sample=assigned.centurySubsidy.pending.home.sample;
  const proofs=new Map();for(const h of x.homes){const key=assigned.centurySubsidy.pending.home.jobs[h.node].key;proofs.set(h.node,await VerifiedClient.prototype.homeRecordProof.call({bounded:{url},config:x.c},sample.root,key));}
  for(let n=0;n<12;n++)step();assert(await VerifiedClient.prototype.homeRecordProof.call({bounded:{url},config:x.c},sample.root,assigned.centurySubsidy.pending.home.jobs[x.homes[0].node].key));
  const make=h=>{const proof=proofs.get(h.node),body=centuryHomeBody(db.snapshotForAudit(),h.node,hash(proof.value));return {type:INDEXED_HOME_ACTION,body,proof,signature:sign(body,h.work.privateKey)};};
  const h=x.homes[0],a=make(h);reject(x.wire(a,keys()));
  for(const mutate of [a=>delete a.proof,a=>a.proof.value.key=keys().publicKey,a=>a.body.root=hash('bad'),a=>a.proof.key='nodes/'+hash('wrong')]){const bad=structuredClone(a);mutate(bad);bad.signature=sign(bad.body,h.work.privateKey);reject(x.wire(bad,h.work));}
  const walletHome=join(dir,'wallet');fs.writeFileSync(join(dir,'reward-identity.json'),JSON.stringify({version:1,network:x.c.chainId,configHash:hash(x.c),work:h.work,management:h.management}));store=new WalletStore(walletHome,x.c.chainId);
  let lost=true,sends=0;const options={home:walletHome,config:x.c,store,url:'isolated',historyUrl:'isolated',recordProofReader:async(root,key)=>{assert.equal(root,sample.root);return proofs.get(h.node);},broadcast:async wire=>{sends++;if(lost){lost=false;throw Error('lost response');}step([wire]);}};
  const view=async()=>({...await loadBoundedServiceView((q,r)=>queryBounded(db,q,r),{root:db.root,height:db.networkHeader().height,configHash:hash(x.c),allowIsolated:true,rewardIds:[h.node]}),certificate:{appHash:db.root,appHeight:db.networkHeader().height}});
  await assert.rejects(async()=>new RewardWorker(options).tick(await view()),/lost response/);
  const savedRoot=db.root;server.closeAllConnections();await new Promise(ok=>server.close(ok));server=null;db.close();db=BoundedNetworkInterpreter.open(file,x.c,savedRoot,{isolatedIssuance:true});
  await new RewardWorker({...options,recordProofReader:async()=>{throw Error('retry should use persisted proof');}}).tick(await view());assert.equal(sends,2);
  await new RewardWorker(options).tick(await view());assert.equal(store.db.prepare('SELECT COUNT(*) n FROM reward_outbox').get().n,0);
  step([x.wire(a,h.work)]);const before=db.snapshotForAudit().rewards.nodes[h.node].witnessJobs;step([x.wire(a,h.work)]);assert.equal(db.snapshotForAudit().rewards.nodes[h.node].witnessJobs,before);
  const other=x.homes[1],late=make(other);step([],sample.deadline+1);reject(x.wire(late,other.work));
  const bind={domain:REWARDS+'/BIND',configHash:hash(x.c),node:h.node,sequence:1,payouts:[{wallet:x.f.bob.publicKey,weight:1}]};
  step([x.wire({type:'BIND_REWARD_WALLETS_V1',body:bind,signature:sign(bind,h.management.privateKey),consents:[sign(walletConsent(hash(x.c),h.node,x.f.bob.publicKey),x.f.bob.privateKey)]},h.management)]);
  const balance=s=>Object.values(s.money.outputs).filter(o=>o.owner===x.f.bob.publicKey).reduce((a,o)=>a+BigInt(o.value),0n),beforeBalance=balance(db.snapshotForAudit());
  step([],initial.centurySubsidy.pending.to);const final=db.snapshotForAudit();assert.equal(final.centurySubsidy.last.home.accepted,1);assert.equal(final.rewards.nodes[h.node].earned,'10000');assert.equal(final.rewards.nodes[other.node].earned,'0');assert.equal(final.centurySubsidy.totalMintedMicro,'10000');
  assert.equal(final.rewards.nodes[h.node].paid,'10000');assert.equal(balance(final)-beforeBalance,10000n);
  const root=db.root;db.close();db=BoundedNetworkInterpreter.open(file,x.c,root,{isolatedIssuance:true});assert.deepEqual(db.snapshotForAudit(),final);
 }finally{if(server){server.closeAllConnections();await new Promise(ok=>server.close(ok));}store?.close();db.close();}
});

test('journal storage formats preserve server and Home rewards through interrupted payout and replay',()=>{
 const x=homeFixture(2),initial=structuredClone(settleProgramme(x,x.s).s);
 initial.centurySubsidy.policy.home.version=INDEXED_HOME;
 initial.centurySubsidy.pending.home.sample=null;initial.centurySubsidy.pending.home.jobs={};
 const prefix=join(fs.realpathSync(tmpdir()),'indexed-reward-storage-'),dir=fs.mkdtempSync(prefix);
 const files=['plain.sqlite','compressed.sqlite'].map(n=>join(dir,n));
 let stores=files.map(file=>BoundedNetworkInterpreter.create(file,initial,x.c,hash(initial),{isolatedIssuance:true}));
 const equal=()=>{assert.deepEqual(stores[1].snapshotForAudit(),stores[0].snapshotForAudit());assert.deepEqual({...stores[1].store.meta},{...stores[0].store.meta});};
 const request=(wires=[],time=stores[0].snapshotForAudit().money.time)=>{const height=stores[0].networkHeader().height+1;return {height,time,blockHash:hash(['reward-storage',height]),txs:wires.map(w=>Buffer.from(JSON.stringify(w)))};};
 const step=(wires=[],time)=>{const r=request(wires,time);for(const db of stores)db.commitBlock(r,db.root);equal();return r;};
 const reopen=()=>{stores=stores.map((db,i)=>{const root=db.root;db.close();const next=BoundedNetworkInterpreter.open(files[i],x.c,root,{isolatedIssuance:true});next.store.compressJournal=i===1;return next;});equal();};
 try{
  stores[1].store.compressJournal=true;
  const proofs=new Map(Object.keys(initial.money.nodes).map(id=>{const key='nodes/'+id;return [key,stores[0].store.proof(key,stores[0].root)];}));
  step();const assigned=stores[0].snapshotForAudit(),h=x.homes[0],proof=proofs.get(assigned.centurySubsidy.pending.home.jobs[h.node].key);
  const body=centuryHomeBody(assigned,h.node,hash(proof.value)),wire=x.wire({type:INDEXED_HOME_ACTION,body,proof,signature:sign(body,h.work.privateKey)},h.work);
  step([wire]);const jobs=stores[0].snapshotForAudit().rewards.nodes[h.node].witnessJobs;
  step([wire]);assert.equal(stores[0].snapshotForAudit().rewards.nodes[h.node].witnessJobs,jobs);
  const bind={domain:REWARDS+'/BIND',configHash:hash(x.c),node:h.node,sequence:1,payouts:[{wallet:x.f.bob.publicKey,weight:1}]};
  step([x.wire({type:'BIND_REWARD_WALLETS_V1',body:bind,signature:sign(bind,h.management.privateKey),consents:[sign(walletConsent(hash(x.c),h.node,x.f.bob.publicKey),x.f.bob.privateKey)]},h.management)]);
  compactJournalBatch(stores[1].store.db);reopen();
  const before=stores[0].snapshotForAudit(),close=request([],initial.centurySubsidy.pending.to);
  for(const db of stores){assert.throws(()=>db.commitBlock(close,db.root,{beforeCommit:()=>{throw Error('interrupted reward commit');}}),/interrupted reward commit/);assert.deepEqual(db.snapshotForAudit(),before);}
  reopen();for(const db of stores)db.commitBlock(close,db.root);equal();
  const paid=stores[0].snapshotForAudit();
  assert.equal(paid.rewards.nodes[h.node].earned,'10000');assert.equal(paid.rewards.nodes[h.node].paid,'10000');
  assert.equal(paid.rewards.nodes[x.homes[1].node].earned,'0');
  const serverEarned=Object.entries(paid.centurySubsidy.earned).filter(([id])=>initial.money.nodes[id]).reduce((sum,[,value])=>sum+BigInt(value),0n);
  assert(serverEarned>0n,'server service rewards exercised');
  assert.equal(BigInt(paid.money.supply)-BigInt(initial.money.supply),BigInt(paid.centurySubsidy.totalMintedMicro)-BigInt(initial.centurySubsidy.totalMintedMicro));
  assert.deepEqual(paid.centurySubsidy.policy,initial.centurySubsidy.policy);
  assert.equal(paid.economicPreparation.planHash,initial.economicPreparation.planHash);
  reopen();for(const db of stores){const meta={...db.store.meta};assert(db.commitBlock(close,db.root).value.duplicate);assert.deepEqual({...db.store.meta},meta);assert.deepEqual(db.snapshotForAudit(),paid);}
  const rows=db=>[...db.store.db.prepare('SELECT * FROM journal ORDER BY sequence').iterate()].map(r=>({...r,body:decodeJournalText(r.body)}));
  assert.deepEqual(rows(stores[1]),rows(stores[0]));
  assert(stores[1].store.db.prepare('SELECT body FROM journal').all().some(r=>r.body.startsWith('{"encoding":')));
 }finally{for(const db of stores)db.close();assert(fs.realpathSync(dir).startsWith(prefix));fs.rmSync(dir,{recursive:true,force:true});}
});

test('offline Home drains obsolete proof retries in bounded pages while preserving the current signed job',async()=>{
 const x=homeFixture(1),h=x.homes[0],initial=structuredClone(x.s);
 initial.centurySubsidy.policy.home.version=INDEXED_HOME;initial.centurySubsidy.sequence=1001;
 initial.centurySubsidy.pending.home.sample=null;initial.centurySubsidy.pending.home.jobs={};
 const dir=fs.mkdtempSync(join(tmpdir(),'indexed-home-retention-')),file=join(dir,'state.sqlite'),home=join(dir,'wallet');
 const db=BoundedNetworkInterpreter.create(file,initial,x.c,hash(initial),{isolatedIssuance:true});let store;
 try{
  const parent=db.root,height=db.networkHeader().height+1;
  const proofs=new Map();for(const id of Object.keys(initial.money.nodes))proofs.set('nodes/'+id,db.store.proof('nodes/'+id,parent));
  db.commitBlock({height,time:initial.money.time,blockHash:hash(['retention',height]),txs:[]},parent);
  fs.writeFileSync(join(dir,'reward-identity.json'),JSON.stringify({version:1,network:x.c.chainId,configHash:hash(x.c),work:h.work,management:h.management}));
  store=new WalletStore(home,x.c.chainId);
  // A restored local backlog: expired signed jobs, never accepted as new work.
  const state=db.snapshotForAudit(),job=state.centurySubsidy.pending.home.jobs[h.node],proof=proofs.get(job.key);
  for(let sequence=1;sequence<=1000;sequence++){
   const old=structuredClone(state);old.centurySubsidy.sequence=sequence;const body=centuryHomeBody(old,h.node,hash(proof.value));
   const wire=envelope(x.c,{type:INDEXED_HOME_ACTION,body,proof,signature:sign(body,h.work.privateKey)},h.work);
   store.db.prepare('INSERT INTO reward_outbox VALUES(?,?)').run('indexed-home:'+sequence,JSON.stringify(wire));
  }
  const view=await loadBoundedServiceView((q,r)=>queryBounded(db,q,r),{root:db.root,height,configHash:hash(x.c),allowIsolated:true,rewardIds:[h.node]});
  view.certificate={appHash:db.root,appHeight:height};let saved=null,reads=0,sends=0;
  const pages=store.db.prepare('PRAGMA page_count').get().page_count;
  for(let attempt=0;attempt<18;attempt++){
   const worker=new RewardWorker({home,config:x.c,store,url:'isolated',recordProofReader:async(root,key)=>{reads++;assert.equal(root,parent);assert.equal(key,job.key);return proof;},broadcast:async wire=>{sends++;if(saved)assert.deepEqual(wire,saved);else saved=wire;throw Error('offline');}});
   const before=store.db.prepare('SELECT count(*) n FROM reward_outbox').get().n;
   await assert.rejects(()=>worker.tick(view),/offline/);
   const count=store.db.prepare('SELECT count(*) n FROM reward_outbox').get().n;
   assert(count>=Math.max(1,before-64));assert(count<=Math.max(1,before-63));
   store.close();store=new WalletStore(home,x.c.chainId);
  }
  assert.equal(reads,1);assert.equal(sends,18);assert.deepEqual(store.db.prepare('SELECT id FROM reward_outbox').all().map(r=>r.id),['indexed-home:1001']);
  assert(store.db.prepare('PRAGMA page_count').get().page_count<=pages+32);assert(store.db.prepare('PRAGMA freelist_count').get().freelist_count>0,'obsolete proofs release reusable database pages');
  assert.deepEqual(db.snapshotForAudit(),state,'cleanup neither earns a reward nor changes network state');
 }finally{store?.close();db.close();}
});

test('read transport retries one reset only, never retries stale roots or changes proof parameters',async()=>{
 let calls=0,mode='reset',urls=[];const server=createServer((req,res)=>{calls++;urls.push(req.url);if(mode==='always-reset'||(mode==='reset'&&calls===1)){req.socket.destroy();return;}res.writeHead(mode==='stale'?409:200,{'content-type':'application/json'});res.end(JSON.stringify({synthetic:true}));});
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const q=boundedHttpQuery('http://127.0.0.1:'+server.address().port),root=hash('same root'),request={type:'node',id:hash('node')};
 try{assert.deepEqual(await q(request,root),{synthetic:true});assert.equal(calls,2);assert.equal(urls[0],urls[1]);mode='stale';calls=0;await assert.rejects(()=>q(request,root),/root advanced/);assert.equal(calls,1);mode='always-reset';calls=0;await assert.rejects(()=>q(request,root));assert.equal(calls,2);}
 finally{server.closeAllConnections();await new Promise(ok=>server.close(ok));}
});
