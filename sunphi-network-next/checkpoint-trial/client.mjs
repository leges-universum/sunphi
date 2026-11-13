// No balance is returned before both checkpoint authentication and consensus verification.
import assert from 'node:assert/strict';
import {spawnSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {hash} from './crypto.mjs';
import {CheckpointBook,verifyCheckpoint} from './checkpoint.mjs';
import {stateHash,validateConfig} from './core.mjs';
import {recoverPath} from './recovery.mjs';
import {selectHistorySource} from './history-source.mjs';
import {policyFields} from './authority.mjs';
import {checkPolicyState} from './checkpoint-state.mjs';
import {boundedHttpQuery,loadBoundedWalletView,loadBoundedServiceView,loadBoundedRewardPlan,loadBoundedHistoryPage,assertBoundedWalletView} from './research/bounded-wallet-view.mjs';
import {verifyBoundedQuery} from './research/bounded-query.mjs';
import {verifyBoundedTransitionTerms,verifyBoundedViewAnchor,indexedTrustAnchor} from './research/bounded-root-transition.mjs';
import {freshRootTerms} from './research/fresh-application.mjs';
import {indexedSchemaRootTerms,verifyIndexedSchemaPredecessor} from './research/indexed-schema-upgrade.mjs';
import {validateGenesisAuthority} from './genesis-authority.mjs';
export async function rpc(url,method,params={}){
 const u=new URL(url);assert.equal(u.hostname,'127.0.0.1','use authenticated SSH tunnel');assert.equal(u.protocol,'http:');
 const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(10000)});assert(r.ok,'RPC HTTP');let size=0,parts=[];for await(const b of r.body){size+=b.length;assert(size<=2*1048576,'RPC limit');parts.push(b);}const j=JSON.parse(Buffer.concat(parts));if(j.error)throw Error(JSON.stringify(j.error));return j.result;
}
export async function snapshot(url,height){const q=await rpc(url,'abci_query',{path:'/snapshot',data:Buffer.from(String(height)).toString('hex')});assert(!q.response.code,'snapshot unavailable');return JSON.parse(Buffer.from(q.response.value,'base64')).state;}
export function verifyHeaders(binary,genesisFile,proofFile,anchor,{historical=false}={}){const r=spawnSync(binary,['-verify-file',proofFile,'-genesis',genesisFile,'-anchor-height',String(anchor.height),'-anchor-hash',anchor.blockHash,...(historical?['-historical']:[])],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:10*1048576});assert.equal(r.status,0,r.stderr||'header verification failed');return JSON.parse(r.stdout);}
export function exportHeaders(binary,genesisFile,url,anchor,end,file){const r=spawnSync(binary,['-export',url,'-genesis',genesisFile,'-anchor-height',String(anchor.height),'-anchor-hash',anchor.blockHash,...(end?['-end',String(end)]:[])],{encoding:'utf8',windowsHide:true,timeout:40000,maxBuffer:10*1048576});assert.equal(r.status,0,r.stderr||'header fetch failed');writeFileSync(file,r.stdout);return file;}
export function persistHead(db,v,expected){
 const live=db.prepare('SELECT * FROM head WHERE id=1').get();
 assert.equal(hash(live?{height:live.height,hash:live.hash}:null),hash(expected?{height:expected.height,hash:expected.hash}:null),'another verifier advanced this wallet; retry');
 if(live){assert(v.height>=live.height,'head rollback');if(v.height===live.height)assert.equal(v.blockHash,live.hash,'head conflict');}
 db.prepare('INSERT INTO head VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET height=excluded.height,hash=excluded.hash').run(v.height,v.blockHash);
}
export class VerifiedClient{
 constructor({home,config,policy,genesisFile,binary,historyUrl,bounded}){mkdirSync(home,{recursive:true});this.home=home;this.config=config;this.policy=policy;this.bounded=bounded?structuredClone(bounded):null;this.genesisFile=genesisFile;this.binary=binary;if(historyUrl){const u=new URL(historyUrl);assert(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash,'invalid local history endpoint');this.historyUrl=u.origin;}const g=JSON.parse(readFileSync(genesisFile));assert.equal(hash(g),policy.genesisHash,'trusted genesis hash');assert.equal(g.chain_id,policy.network);assert.equal(hash(g.app_state),validateConfig(config));validateGenesisAuthority(g,config);if(config.control)assert.equal(hash(config.control.policy),hash(policyFields(policy)),'genesis policy');this.book=new CheckpointBook(join(home,'trust.sqlite'),policy);this.book.db.exec('CREATE TABLE IF NOT EXISTS head(id INTEGER PRIMARY KEY,height INTEGER NOT NULL,hash TEXT NOT NULL)');}
 accept(doc,state,proofFile){this.assertLegacyMode();const prev=this.book.current;verifyCheckpoint(doc,this.policy,{previous:prev,allowGap:true});const anchor=prev?.body??doc.body;const v=verifyHeaders(this.binary,this.genesisFile,proofFile,anchor);const proof=JSON.parse(readFileSync(proofFile));
  // The new checkpoint and the previous accepted head must occur in this same verified path.
  const headerAt=h=>proof.headers.find(s=>Number(s.header.height)===h);
  const cp=headerAt(doc.body.height);assert(cp,'checkpoint missing from verified path');assert.equal(cp.commit.block_id.hash.toLowerCase(),doc.body.blockHash);assert.equal(cp.header.app_hash.toLowerCase(),doc.body.appHash);
  const old=this.book.db.prepare('SELECT * FROM head WHERE id=1').get();if(old){assert(v.height>=old.height,'head rollback');if(old.height>=anchor.height){const retained=headerAt(old.height);assert(retained&&retained.commit.block_id.hash.toLowerCase()===old.hash,'head conflict');}else assert(prev&&doc.body.height>old.height,'head continuity');}
  assert.equal(state.height,v.appHeight);assert.equal(stateHash(state,this.config),v.appHash,'snapshot differs from certified state');if(state.height===doc.body.appHeight)assert.equal(hash(state),doc.body.snapshotHash);
  checkPolicyState(doc,state,this.config,this.policy);
  this.book.accept(doc,{linked:!!prev,commit:db=>persistHead(db,v,old)});
  return {state,certificate:v,checkpointId:hash(doc.body)};
 }
 async checkpointSnapshot(doc,url){
  this.assertLegacyMode();
  // Bridge evidence binds an exact checkpoint snapshot, whereas sync follows
  // the latest certified head. Never substitute that newer head in the packet.
  verifyCheckpoint(doc,this.policy);await this.sync(doc,url);
  const state=await snapshot(this.historyUrl??url,doc.body.appHeight);
  assert.equal(state.height,doc.body.appHeight);assert.equal(hash(state),doc.body.snapshotHash);
  assert.equal(stateHash(state,this.config),doc.body.appHash);checkPolicyState(doc,state,this.config,this.policy);
  return {state};
 }
 async sync(doc,url,options={}){
  assert(!this.syncing,'verification already running');this.syncing=true;
  try{return await this.syncOnce(doc,url,options);}finally{this.syncing=false;}
 }
 async syncOnce(doc,url,{window=256,onWindow=()=>{},owner,requestIds=[],service=false,rewardIds=[],payment=null}={}){
  assert(typeof service==='boolean');assert(!service||!owner,'service scope cannot claim a wallet');
  const retained=this.book.current;
  const supplied=doc;
  if(retained&&retained.body.sequence>doc.body.sequence)doc=retained;
  if(retained&&retained.body.sequence===doc.body.sequence)assert.equal(hash(retained.body),hash(doc.body),'checkpoint equivocation');
  try{const q=await rpc(url,'abci_query',{path:'/checkpoint'});if(!q.response.code){const offered=JSON.parse(Buffer.from(q.response.value,'base64'));if(offered&&offered.body.sequence>=doc.body.sequence){verifyCheckpoint(offered,this.policy,{previous:retained,allowGap:true});if(offered.body.sequence===doc.body.sequence)assert.equal(hash(offered.body),hash(doc.body),'checkpoint equivocation');doc=offered;}}}catch(e){if(e.name==='AssertionError')throw e;}
  verifyCheckpoint(doc,this.policy,{previous:retained,allowGap:true});
  const db=this.book.db,old=db.prepare('SELECT * FROM head WHERE id=1').get();
  let transition=null,transitionCheckpoint=null;
  db.exec('CREATE TABLE IF NOT EXISTS indexed_transition(id INTEGER PRIMARY KEY,terms TEXT NOT NULL)');
  const pinnedTransition=db.prepare('SELECT terms FROM indexed_transition WHERE id=1').get();
  assert(!pinnedTransition||this.bounded,'indexed trust cannot fall back to a legacy snapshot');
  if(this.bounded){
   assert(owner||service,'indexed wallet owner or service scope required');
   const {certificate,source,fresh,schemaUpgrade}=this.bounded;
   assert.equal(Number(!!fresh)+Number(!!schemaUpgrade)+Number(!!(certificate||source)),1,'ambiguous wallet state authority');
   transition=schemaUpgrade?indexedSchemaRootTerms(this.config,schemaUpgrade):fresh?freshRootTerms(this.config,fresh):verifyBoundedTransitionTerms(certificate,source,this.config,hash(source));
   if(schemaUpgrade){
    const genesis=JSON.parse(readFileSync(this.genesisFile));if(genesis.app_hash)assert.equal(genesis.app_hash.toLowerCase(),transition.genesisRoot,'schema upgrade genesis conflict');
   }
   if(pinnedTransition)verifyIndexedSchemaPredecessor(JSON.parse(pinnedTransition.terms),transition);
   else if(!fresh&&!schemaUpgrade){
    transitionCheckpoint=indexedTrustAnchor(doc,transition,[retained,supplied,doc],this.policy,this.config);
   }
  }
  const alreadyPinned=retained&&hash(retained.body)===hash(doc.body);
  // The retained head already authenticates the path from the retained checkpoint.
  // Reuse it for routine checks; only a newly offered checkpoint behind it needs replay.
  let anchor=old&&retained&&(alreadyPinned||doc.body.height>=old.height)?{height:old.height,blockHash:old.hash}:retained?.body??doc.body;
  if(transitionCheckpoint&&transitionCheckpoint.body.height<anchor.height)anchor=transitionCheckpoint.body;
  const requirements=alreadyPinned?[]:[{id:'checkpoint',height:doc.body.height,blockHash:doc.body.blockHash,appHash:doc.body.appHash}];
  if(transitionCheckpoint)requirements.push({id:'transition-source',height:transitionCheckpoint.body.height,blockHash:transitionCheckpoint.body.blockHash,appHash:transition.sourceRoot});
  if(transition?.kind==='indexed-schema-upgrade'&&anchor.height<=transition.activationHeight){
   const {boundary}=await selectHistorySource({local:this.historyUrl,remote:url,anchor,minHeight:Math.max(doc.body.height,transition.activationHeight),request:rpc,boundary:{height:transition.activationHeight,appHash:transition.sourceRoot}});
   requirements.push({id:'schema-source',height:transition.activationHeight,blockHash:boundary.block_id.hash.toLowerCase(),appHash:transition.sourceRoot});
  }
  if(old){assert(old.height>=anchor.height,'retained head precedes anchor');requirements.push({id:'head',height:old.height,blockHash:old.hash});}
  const context=hash({anchor,requirements,policy:hash(this.policy)});
  db.exec('CREATE TABLE IF NOT EXISTS recovery(id INTEGER PRIMARY KEY,context TEXT NOT NULL,body TEXT NOT NULL)');
  const row=db.prepare('SELECT * FROM recovery WHERE id=1').get();
  let progress=row?.context===context?JSON.parse(row.body):null;
  // Fetch the latest signed checkpoint above from the network; read the bulk
  // history from the local full node when available. It is only a transport:
  // the retained anchors, signatures, ancestry and state checks stay identical.
  const selected=this.bounded?await selectHistorySource({local:this.historyUrl,remote:url,anchor:progress?.cursor??anchor,minHeight:Math.max(doc.body.height,old?.height??0,progress?.cursor.height??0),request:rpc}):null;
  const historyUrl=selected?.url??this.historyUrl??url;
  const commit=selected?{signed_header:{header:{height:selected.latest}}}:await rpc(historyUrl,'commit');
  assert(commit?.signed_header?.header,'local history is not ready yet');
  const latest=Number(commit.signed_header.header.height);
  assert(latest>=Math.max(doc.body.height,old?.height??0,progress?.cursor.height??0),'source behind retained history');
  const save=p=>db.prepare('INSERT INTO recovery VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET context=excluded.context,body=excluded.body').run(context,JSON.stringify(p));
  const result=await recoverPath({binary:this.binary,genesisFile:this.genesisFile,url:historyUrl,file:join(this.home,'candidate-headers.json'),anchor,target:latest,requirements,progress,save,window,onWindow});
  const v=result.verified;let state,history;
  if(transition){
   assert(v.appHeight>=transition.activationHeight,'indexed activation not yet certified');
   const view=await boundedHttpQuery(this.bounded.url).withLease(v.appHash,query=>(service?loadBoundedServiceView:loadBoundedWalletView)(query,{root:v.appHash,height:v.appHeight,configHash:hash(this.config),owner,requestIds,rewardIds,payment}));
   verifyBoundedViewAnchor(view.anchor,transition);state=view.state;history=view.history;
  }else{
   state=await snapshot(historyUrl,v.appHeight);
   assert.equal(state.height,v.appHeight);assert.equal(stateHash(state,this.config),v.appHash,'snapshot differs from certified state');
   if(state.height===doc.body.appHeight)assert.equal(hash(state),doc.body.snapshotHash);
  }
  checkPolicyState(doc,state,this.config,this.policy);
  // No monetary view is exposed from a partially verified cursor.
  this.book.accept(doc,{linked:!!retained,commit:db=>{
   persistHead(db,v,old);
   if(transition){
    const current=db.prepare('SELECT terms FROM indexed_transition WHERE id=1').get();
    assert.equal(current?.terms,pinnedTransition?.terms,'another verifier changed indexed authority; retry');
    db.prepare('INSERT INTO indexed_transition VALUES(1,?) ON CONFLICT(id) DO UPDATE SET terms=excluded.terms').run(JSON.stringify(transition));
   }
   db.prepare('DELETE FROM recovery WHERE id=1').run();
  }});
  return {state,certificate:v,checkpointId:hash(doc.body),...(history?{history}:{}),recovery:{windows:result.windows,bytes:result.totalBytes}};
 }
 async historyPage(view,owner,offset=0,limit=32,through=null){
  assert(this.bounded);assertBoundedWalletView(view.state,view.certificate,this.config,owner);
  return boundedHttpQuery(this.bounded.url).withLease(view.certificate.appHash,query=>loadBoundedHistoryPage(query,{root:view.certificate.appHash,height:view.certificate.appHeight,configHash:hash(this.config),owner,offset,limit,through}));
 }
 async homeRecordProof(root,key){
  assert(this.bounded&&/^nodes\/[a-f0-9]{64}$/.test(key));const request={type:'node',id:key.slice(6)};
  return boundedHttpQuery(this.bounded.url).withLease(root,async query=>{const response=await query(request,root);verifyBoundedQuery(response,request,root,hash(this.config));const proof=response.proofs.find(p=>p.key===key);assert(proof?.found);return proof;});
 }
 async approvalEvidence(doc,url,owner,pid=null){
  assert(this.bounded);await this.sync(doc,url,{owner,requestIds:pid?[pid]:[]});
  const checkpoint=this.book.current;verifyCheckpoint(checkpoint,this.policy,{configHash:hash(this.config)});
  const request={type:'approval-context',id:{owner,pid}},root=checkpoint.body.appHash;
  const proof=await boundedHttpQuery(this.bounded.url).withLease(root,query=>query(request,root));
  const result=verifyBoundedQuery(proof,request,root,hash(this.config));assert.equal(result.height,checkpoint.body.appHeight);assert(!result.isolatedIssuance);
  const terms=JSON.parse(this.book.db.prepare('SELECT terms FROM indexed_transition WHERE id=1').get().terms);
  verifyBoundedViewAnchor(result.data.anchor,terms);checkPolicyState(checkpoint,result.data.state,this.config,this.policy);
  return {state:result.data.state,checkpoint,proof};
 }
 async rewardPlanningEvidence(doc,url,offset=0){
  assert(this.bounded);await this.sync(doc,url,{service:true});
  // sync may replace an offered checkpoint with a newer verified one. In that
  // case require a new proposal instead of signing a root outside that path.
  assert.equal(hash(this.book.current?.body),hash(doc.body),'planning checkpoint advanced; retry with current checkpoint');
  verifyCheckpoint(doc,this.policy,{configHash:hash(this.config)});
  const root=doc.body.appHash,view=await boundedHttpQuery(this.bounded.url).withLease(root,query=>loadBoundedRewardPlan(query,{root,height:doc.body.appHeight,configHash:hash(this.config),offset}));
  const terms=JSON.parse(this.book.db.prepare('SELECT terms FROM indexed_transition WHERE id=1').get().terms);
  verifyBoundedViewAnchor(view.anchor,terms);checkPolicyState(doc,view.state,this.config,this.policy);
  return {...view,checkpoint:doc};
 }
 async nodeAlertEvidence(doc,url,node){
  assert(this.bounded&&/^[a-f0-9]{64}$/.test(node));await this.sync(doc,url,{service:true});
  const checkpoint=this.book.current;verifyCheckpoint(checkpoint,this.policy,{configHash:hash(this.config)});
  const root=checkpoint.body.appHash,proofs=await boundedHttpQuery(this.bounded.url).withLease(root,async query=>({
   meta:await query({type:'wallet-meta',id:null},root),worker:await query({type:'node',id:node},root),reward:await query({type:'reward-account',id:node},root)
  }));
  for(const [name,request] of [['meta',{type:'wallet-meta',id:null}],['worker',{type:'node',id:node}],['reward',{type:'reward-account',id:node}]]){const r=verifyBoundedQuery(proofs[name],request,root,hash(this.config));assert.equal(r.height,checkpoint.body.appHeight);assert(!r.isolatedIssuance);}
  const terms=JSON.parse(this.book.db.prepare('SELECT terms FROM indexed_transition WHERE id=1').get().terms);
  verifyBoundedViewAnchor(proofs.meta.result.data.anchor,terms);return {checkpoint,...proofs};
 }
 assertLegacyMode(){
  assert(!this.bounded,'indexed clients require verified page synchronization');
  const db=this.book.db;if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='indexed_transition'").get())assert(!db.prepare('SELECT 1 FROM indexed_transition WHERE id=1').get(),'indexed trust cannot fall back to a legacy snapshot');
 }
 close(){this.book.close();}
}
