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
import {policyFields} from './authority.mjs';
import {checkPolicyState} from './checkpoint-state.mjs';
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
 constructor({home,config,policy,genesisFile,binary,historyUrl}){mkdirSync(home,{recursive:true});this.home=home;this.config=config;this.policy=policy;this.genesisFile=genesisFile;this.binary=binary;if(historyUrl){const u=new URL(historyUrl);assert(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash,'invalid local history endpoint');this.historyUrl=u.origin;}const g=JSON.parse(readFileSync(genesisFile));assert.equal(hash(g),policy.genesisHash,'trusted genesis hash');assert.equal(g.chain_id,policy.network);assert.equal(hash(g.app_state),validateConfig(config));if(config.control)assert.equal(hash(config.control.policy),hash(policyFields(policy)),'genesis policy');this.book=new CheckpointBook(join(home,'trust.sqlite'),policy);this.book.db.exec('CREATE TABLE IF NOT EXISTS head(id INTEGER PRIMARY KEY,height INTEGER NOT NULL,hash TEXT NOT NULL)');}
 accept(doc,state,proofFile){const prev=this.book.current;verifyCheckpoint(doc,this.policy,{previous:prev,allowGap:true});const anchor=prev?.body??doc.body;const v=verifyHeaders(this.binary,this.genesisFile,proofFile,anchor);const proof=JSON.parse(readFileSync(proofFile));
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
 async syncOnce(doc,url,{window=256,onWindow=()=>{}}={}){
  const retained=this.book.current;
  if(retained&&retained.body.sequence>doc.body.sequence)doc=retained;
  if(retained&&retained.body.sequence===doc.body.sequence)assert.equal(hash(retained.body),hash(doc.body),'checkpoint equivocation');
  try{const q=await rpc(url,'abci_query',{path:'/checkpoint'});if(!q.response.code){const offered=JSON.parse(Buffer.from(q.response.value,'base64'));if(offered&&offered.body.sequence>=doc.body.sequence){verifyCheckpoint(offered,this.policy,{previous:retained,allowGap:true});if(offered.body.sequence===doc.body.sequence)assert.equal(hash(offered.body),hash(doc.body),'checkpoint equivocation');doc=offered;}}}catch(e){if(e.name==='AssertionError')throw e;}
  verifyCheckpoint(doc,this.policy,{previous:retained,allowGap:true});
  const db=this.book.db,old=db.prepare('SELECT * FROM head WHERE id=1').get();
  const alreadyPinned=retained&&hash(retained.body)===hash(doc.body);
  // The retained head already authenticates the path from the retained checkpoint.
  // Reuse it for routine checks; only a newly offered checkpoint behind it needs replay.
  const anchor=old&&retained&&(alreadyPinned||doc.body.height>=old.height)?{height:old.height,blockHash:old.hash}:retained?.body??doc.body;
  const requirements=alreadyPinned?[]:[{id:'checkpoint',height:doc.body.height,blockHash:doc.body.blockHash,appHash:doc.body.appHash}];
  if(old){assert(old.height>=anchor.height,'retained head precedes anchor');requirements.push({id:'head',height:old.height,blockHash:old.hash});}
  const context=hash({anchor,requirements,policy:hash(this.policy)});
  db.exec('CREATE TABLE IF NOT EXISTS recovery(id INTEGER PRIMARY KEY,context TEXT NOT NULL,body TEXT NOT NULL)');
  const row=db.prepare('SELECT * FROM recovery WHERE id=1').get();
  let progress=row?.context===context?JSON.parse(row.body):null;
  // Fetch the latest signed checkpoint above from the network; read the bulk
  // history from the local full node when available. It is only a transport:
  // the retained anchors, signatures, ancestry and state checks stay identical.
  const historyUrl=this.historyUrl??url;
  const commit=await rpc(historyUrl,'commit');
  assert(commit?.signed_header?.header,'local history is not ready yet');
  const latest=Number(commit.signed_header.header.height);
  assert(latest>=Math.max(doc.body.height,old?.height??0,progress?.cursor.height??0),'source behind retained history');
  const save=p=>db.prepare('INSERT INTO recovery VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET context=excluded.context,body=excluded.body').run(context,JSON.stringify(p));
  const result=await recoverPath({binary:this.binary,genesisFile:this.genesisFile,url:historyUrl,file:join(this.home,'candidate-headers.json'),anchor,target:latest,requirements,progress,save,window,onWindow});
  const v=result.verified,state=await snapshot(historyUrl,v.appHeight);
  assert.equal(state.height,v.appHeight);assert.equal(stateHash(state,this.config),v.appHash,'snapshot differs from certified state');
  if(state.height===doc.body.appHeight)assert.equal(hash(state),doc.body.snapshotHash);
  checkPolicyState(doc,state,this.config,this.policy);
  // No monetary view is exposed from a partially verified cursor.
  this.book.accept(doc,{linked:!!retained,commit:db=>{
   persistHead(db,v,old);
   db.prepare('DELETE FROM recovery WHERE id=1').run();
  }});
  return {state,certificate:v,checkpointId:hash(doc.body),recovery:{windows:result.windows,bytes:result.totalBytes}};
 }
 close(){this.book.close();}
}
