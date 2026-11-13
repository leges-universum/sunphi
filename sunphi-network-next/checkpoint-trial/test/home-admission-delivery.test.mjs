import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,dirname} from 'node:path';
import {keys,hash,sign} from '../crypto.mjs';
import {issuanceFixture} from './century-issuance.test.mjs';
import {rig} from './bounded-century.test.mjs';
import {prepareRewardIdentity,homeAdmissionRequest,homeAdmissionAction} from '../reward-identity.mjs';
import {validateHomeRequest,homeAdmissionProposal,HOME_DELIVERY} from '../home-admission-protocol.mjs';
import {HomeAdmissionQueue,startHomeAdmissionHTTP,homeAdmissionClient} from '../home-admission-service.mjs';
import {RewardWorker} from '../reward-worker.mjs';
import {WalletStore} from '../wallet-store.mjs';
import {loadBoundedServiceView,loadBoundedWalletView} from '../research/bounded-wallet-view.mjs';
import {queryBounded} from '../research/bounded-query.mjs';
import {validateConsumerProfile,consumerConnections} from '../consumer-profile.mjs';
import {cleanConfig,createFreshChain} from '../research/fresh-chain-preparation.mjs';
import {CHECKPOINT} from '../checkpoint.mjs';

function device(x,base,name='device'){
 const home=join(base,name),peer=keys();fs.mkdirSync(join(home,'node/config'),{recursive:true});
 fs.writeFileSync(join(home,'node/config/node_key.json'),JSON.stringify({priv_key:{type:'tendermint/PrivKeyEd25519',value:Buffer.concat([Buffer.from(peer.privateKey,'base64url').subarray(-32),Buffer.from(peer.publicKey,'base64url')]).toString('base64')}}));
 return {home,identity:prepareRewardIdentity(home,x.c)};
}
function setup(capacity=4096){
 const x=issuanceFixture(),r=rig(x,x.s,false,false),d=device(x,dirname(r.file)),file=join(dirname(r.file),'queue.sqlite');
 const queue=new HomeAdmissionQueue({file,config:x.c,capacity});
 const view=async(owner=null)=>{const args={root:r.db.root,height:r.s.height,configHash:hash(x.c),rewardIds:[d.identity.node]},query=(q,root)=>queryBounded(r.db,q,root);return {...await(owner?loadBoundedWalletView(query,{...args,owner}):loadBoundedServiceView(query,args)),certificate:{appHash:r.db.root,appHeight:r.s.height}};};
 const request=()=>homeAdmissionRequest(d.home,d.identity,x.c,r.s.money.time);
 const offer=()=>{const body=homeAdmissionProposal(request(),r.s,x.c);return {certificate:{body,approvals:x.approvals(body)},founderConsent:sign(body,x.founder.privateKey)};};
 return {x,r,d,file,queue,view,request,offer,close(){queue.close();r.db.close();}};
}
const post=(port,route,body,headers={})=>fetch('http://127.0.0.1:'+port+'/home-admission/'+route,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});

test('Home delivery: automatic locked registration, lost broadcast reply, restart and wallet binding',async()=>{
 const z=setup(),{x,r,d,queue}=z,server=await startHomeAdmissionHTTP({queue,view:z.view,port:0,now:()=>r.s.money.time}),store=new WalletStore(join(d.home,'wallet'),x.c.chainId),sent=[],before=structuredClone(r.s.money);
 const options={home:join(d.home,'wallet'),config:x.c,store,url:'isolated',admissionTransport:homeAdmissionClient(['http://127.0.0.1:'+server.port]),broadcast:async w=>{sent.push(w);throw Error('lost broadcast acknowledgement');}};
 try{
  let worker=new RewardWorker(options);assert.match((await worker.tick(await z.view())).message,/awaiting network registration/);assert.equal(sent.length,0);assert.equal(queue.pending().length,1);
  assert.equal((await post(server.port,'offer',z.offer())).status,200);
  await assert.rejects(async()=>worker.tick(await z.view()),/lost broadcast/);const first=sent[0];assert.equal(first.body.action.type,'REGISTER_HOME_KEYS_V1');
  worker=new RewardWorker({...options,broadcast:async w=>sent.push(w)});await worker.tick(await z.view(x.f.bob.publicKey));assert.deepEqual(sent[1],first);
  r.step([first]);await worker.tick(await z.view());assert.equal(store.db.prepare('SELECT count(*) AS n FROM reward_outbox').get().n,0);assert.equal(r.s.rewards.homeRegistry.count,1);
  for(const key of ['supply','outputs','fees','nodes','requests'])assert.deepEqual(r.s.money[key],before[key]);assert.equal(r.s.rewards.nodes[d.identity.node].earned,'0');assert(!r.s.economicPreparation.paidAdmission);
  store.create('isolated-home-password','Isolated payout wallet');await worker.tick(await z.view());const binding=sent.at(-1);assert.equal(binding.body.action.type,'BIND_REWARD_WALLETS_V1');r.step([binding]);await worker.tick(await z.view());assert.equal(r.s.rewards.nodes[d.identity.node].payouts.length,1);r.reopen();assert.equal(r.s.rewards.nodes[d.identity.node].sequence,1);
 }finally{store.close();await server.close();z.close();}
});

test('Home delivery: reject foreign network, key replacement, false founder and quorum before signing',()=>{
 const z=setup(),{x,r,d,queue}=z;
 try{const request=z.request();queue.accept(request,r.s);const good=z.offer();
  for(const change of [o=>o.founderConsent=sign(o.certificate.body,keys().privateKey),o=>o.certificate.approvals.pop(),o=>o.certificate.body.network='foreign',o=>o.certificate.body.homes[0].management=keys().publicKey,o=>o.certificate.body.domain='TRANSFER']){const bad=structuredClone(good);change(bad);assert.throws(()=>homeAdmissionAction(d.home,d.identity,x.c,r.s,bad));assert.throws(()=>queue.publish(bad,r.s));}
  for(const change of [q=>q.body.home.work=keys().publicKey,q=>q.body.network='foreign',q=>q.consents.identity=sign(q.body,keys().privateKey),q=>q.body.expires+=1000]){const bad=structuredClone(request);change(bad);assert.throws(()=>validateHomeRequest(bad,x.c,r.s.money.time));}
  const action=homeAdmissionAction(d.home,d.identity,x.c,r.s,good);assert(!JSON.stringify({request,good,action}).includes(d.identity.work.privateKey));assert(!JSON.stringify({request,good,action}).includes(d.identity.management.privateKey));
 }finally{z.close();}
});

test('Home delivery: expired outbox renews authorization and never sends a legacy registration',async()=>{
 const z=setup(),{x,r,d}=z,store=new WalletStore(join(d.home,'wallet'),x.c.chainId),sent=[];let offer=z.offer();
 const opts={home:join(d.home,'wallet'),config:x.c,store,url:'isolated',admissionTransport:async()=>offer,broadcast:async w=>sent.push(w)};
 try{let worker=new RewardWorker(opts);await worker.tick(await z.view());const first=sent[0];r.step([],r.s.money.time+601);offer=z.offer();worker=new RewardWorker(opts);await worker.tick(await z.view());assert.notDeepEqual(sent[1],first);assert.equal(sent[1].body.action.type,'REGISTER_HOME_KEYS_V1');r.step([sent[1]]);await worker.tick(await z.view());assert.equal(r.s.rewards.homeRegistry.count,1);
 }finally{store.close();z.close();}
});

test('Home delivery: queue restart, indexed pages above 128, capacity and expiration',()=>{
 const z=setup(132),{x,r}=z;let q=z.queue;
 try{for(let i=0;i<132;i++){const d=device(x,dirname(r.file),'d'+i);q.accept(homeAdmissionRequest(d.home,d.identity,x.c,r.s.money.time),r.s);}
  let after='',count=0;for(;;){const page=q.pending({after,limit:32});if(!page.length)break;assert(page.every(v=>v.node>after));count+=page.length;after=page.at(-1).node;}assert.equal(count,132);
  assert.throws(()=>q.accept(z.request(),r.s),/busy/);q.close();q=new HomeAdmissionQueue({file:z.file,config:x.c,capacity:132});assert.equal(q.pending().length,32);assert.throws(()=>new HomeAdmissionQueue({file:z.file,config:{...x.c,chainId:'foreign'}}),/binding/);
  r.step([],r.s.money.time+601);assert.equal(q.accept(z.request(),r.s).status,'pending');assert.equal(q.db.prepare('SELECT count(*) AS n FROM requests').get().n,69);assert.throws(()=>q.pending({limit:33}));
 }finally{q.close();r.db.close();}
});

test('Home delivery: changed authority, expired offer, duplicate peer and unavailable route fail closed',async()=>{
 const z=setup(),{x,r,d,queue}=z,store=new WalletStore(join(d.home,'wallet'),x.c.chainId);let broadcasts=0;
 try{queue.accept(z.request(),r.s);queue.publish(z.offer(),r.s);const changed=structuredClone(r.s);changed.authority.generation++;assert.equal(queue.accept(z.request(),changed).status,'pending');
  const other=device(x,dirname(r.file),'other');fs.copyFileSync(join(d.home,'node/config/node_key.json'),join(other.home,'node/config/node_key.json'));assert.throws(()=>queue.accept(homeAdmissionRequest(other.home,other.identity,x.c,r.s.money.time),r.s),/UNIQUE/);
  const w=new RewardWorker({home:join(d.home,'wallet'),config:x.c,store,url:'isolated',broadcast:async()=>broadcasts++});await w.tick(await z.view());assert.equal(broadcasts,0);
  assert.throws(()=>homeAdmissionClient(['https://example.org']));assert.throws(()=>homeAdmissionClient(['http://127.0.0.1:1234/redirect']));
 }finally{store.close();z.close();}
});

test('Home delivery: HTTP rejects stale state, unverified views, browser writes and oversized messages',async()=>{
 const z=setup();let v=await z.view(),clock=z.r.s.money.time;const server=await startHomeAdmissionHTTP({queue:z.queue,view:async()=>v,port:0,now:()=>clock});
 try{assert.equal((await post(server.port,'request',z.request(),{origin:'http://evil.invalid'})).status,400);clock+=121;assert.equal((await post(server.port,'request',z.request())).status,422);clock-=121;v=structuredClone(v);assert.equal((await post(server.port,'request',z.request())).status,422);v=await z.view();
  const large=await post(server.port,'request',{data:'x'.repeat(70000)}).catch(()=>null);assert(!large||large.status===413);
  assert.equal((await post(server.port,'request',z.request())).status,200);
  const client=homeAdmissionClient(['http://127.0.0.1:1','http://127.0.0.1:'+server.port]);assert.equal(await client(z.request()),null);
 }finally{await server.close();z.close();}
});

test('Home delivery: pinned installation profile carries admission routes and refuses unpinned endpoints',()=>{
 const z=setup();
 try{const time=z.r.s.money.time,validators=Array.from({length:4},keys),members=Array.from({length:4},keys),config=cleanConfig({chainId:'duebyte-trial-admission-profile',previousChainId:'old',time,control:{version:2,validators:validators.map(k=>({key:k.publicKey,group:hash(k.publicKey),power:10})),policy:{version:1,members:members.map(k=>({key:k.publicKey,group:hash(k.publicKey)})),threshold:3,maxAge:3600,notAfter:time+86400}}});
  const fresh=createFreshChain(join(dirname(z.file),'profile.sqlite'),config);fresh.handler.close();const genesis={chain_id:config.chainId,app_state:config,validators:validators.map(k=>({pub_key:{type:'tendermint/PubKeyEd25519',value:Buffer.from(k.publicKey,'base64url').toString('base64')},power:'10'}))};
  const pin='ssh-ed25519 '+Buffer.concat([Buffer.from('0000000b7373682d6564323535313900000020','hex'),Buffer.alloc(32,1)]).toString('base64');
  const p={version:1,config,genesis,policy:{domain:CHECKPOINT+'/POLICY',network:config.chainId,genesisHash:hash(genesis),...config.control.policy},basePort:28000,walletPort:28010,hosts:[{ip:'192.0.2.1',port:2244,user:'duebytefollower',pin,forwards:[[28100,26000],[28101,26001],[28105,26005],[28106,26006]]},{ip:'192.0.2.2',port:2244,user:'duebytefollower',pin,forwards:[[28110,26010],[28111,26011]]}],peers:[{id:'a'.repeat(40),port:28100},{id:'b'.repeat(40),port:28110}],rpcServers:['http://127.0.0.1:28101','http://127.0.0.1:28111'],workers:{},fresh:{manifest:fresh.manifest,manifestHash:hash(fresh.manifest),readPort:28005,url:'http://127.0.0.1:28105'},homeAdmission:{version:1,urls:['http://127.0.0.1:28106']}};
  validateConsumerProfile(p,hash(p));assert.deepEqual(consumerConnections(p).homeAdmission,p.homeAdmission);
  for(const edit of [q=>q.homeAdmission.urls=['http://127.0.0.1:28107'],q=>q.homeAdmission.urls=['https://evil.invalid'],q=>q.homeAdmission.urls.push(q.homeAdmission.urls[0]),q=>q.homeAdmission.version=2,q=>q.homeAdmission.extra=true]){const bad=structuredClone(p);edit(bad);assert.throws(()=>validateConsumerProfile(bad,hash(bad)));}
  const old=structuredClone(p);delete old.homeAdmission;validateConsumerProfile(old,hash(old));assert(!Object.hasOwn(consumerConnections(old),'homeAdmission'));assert.throws(()=>validateConsumerProfile(p,hash(old)),/fingerprint/);
 }finally{z.close();}
});

test('Home delivery: request replay cannot shorten renewal and malformed offer cannot replace a valid one',()=>{
 const z=setup();try{const old=z.request();z.queue.accept(old,z.r.s);z.queue.publish(z.offer(),z.r.s);z.r.step([],z.r.s.money.time+10);const next=z.request();z.queue.accept(next,z.r.s);z.queue.accept(old,z.r.s);assert.deepEqual(z.queue.pending()[0].request,next);
  const bad=z.offer();bad.founderConsent='invalid';assert.throws(()=>z.queue.publish(bad,z.r.s));assert.equal(z.queue.accept(next,z.r.s).status,'authorized');
 }finally{z.close();}
});
