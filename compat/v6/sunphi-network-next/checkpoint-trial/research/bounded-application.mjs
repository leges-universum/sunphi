// Explicit ABCI adapter. Migration and fresh-genesis openers verify their own anchors.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {sqlitePath} from '../sqlite-path.mjs';
import {hash} from '../crypto.mjs';
import {validateConfig,workReceipt} from '../core.mjs';
import {BoundedNetworkInterpreter} from './bounded-network-interpreter.mjs';
import {BoundedBlockStore} from './bounded-block-store.mjs';
import {verifyBoundedTransitionTerms,verifyBoundedViewAnchor,verifyBoundedRootTransition} from './bounded-root-transition.mjs';
import {queryBounded} from './bounded-query.mjs';
import {verifyBoundedArchive} from './bounded-archive-migration.mjs';

export function openBoundedApplication(file,source,config,certificate){
 const terms=verifyBoundedTransitionTerms(certificate,source,config,hash(source));
 const reader=new DatabaseSync(sqlitePath(file),{readOnly:true});let root;
 try{root=reader.prepare('SELECT rootHash FROM meta WHERE id=1').get().rootHash;}finally{reader.close();}
 const handler=BoundedNetworkInterpreter.open(file,config,root);
 try{
  verifyBoundedViewAnchor(handler.store.proof('meta/anchor',root).value,terms);
  if(handler.networkHeader().height===terms.sourceHeight)verifyBoundedRootTransition(certificate,source,config,handler,hash(source));
  else {
   verifyBoundedArchive(handler);
   // Local durability checks, not a substitute for the consensus replay handshake.
   let previous=null,height=terms.sourceHeight;
   for(const row of handler.store.db.prepare('SELECT * FROM journal WHERE sequence>=1 ORDER BY sequence').iterate()){
    const body=JSON.parse(row.body);assert.equal(hash(body),row.digest);assert.equal(body.root,row.root);assert.equal(body.parent,row.parent);assert.equal(body.sequence,row.sequence);
    if(!previous){assert.equal(row.sequence,1);assert.equal(row.root,terms.targetRoot);}
    else{assert.equal(row.parent,previous.root);assert.equal(body.previousJournal,previous.digest);assert.equal(row.sequence,previous.sequence+1);assert.equal(body.event.height,++height);assert.equal(body.event.filter,false);}
    previous=row;
   }
   const m=handler.store.meta;assert(previous&&previous.root===root&&previous.digest===m.journalHash&&previous.sequence===m.sequence);assert.equal(handler.networkHeader().height,height);
  }
  return new BoundedApplication(handler,terms);
 }catch(e){handler.close();throw e;}
}

export class BoundedApplication{
 constructor(handler,terms){this.blocks=new BoundedBlockStore(handler);this.handler=handler;this.terms=terms;}
 dispatch(q,{work=null,publication=()=>null}={}){
  const txs=(q.txs??[]).map(x=>Buffer.from(x,'base64'));
  // Fault admission already authenticates its committed context. Do not walk
  // the same header path again for every mempool recheck.
  if(q.method==='check'){try{
   if(!this.handler.checkFaultAdmission(txs[0])){const root=this.blocks.root,s=this.blocks.header,m=queryBounded(this.handler,{type:'wallet-meta',id:null},root).result.data.money;this.handler.checkBlockAdmission({height:s.height+1,blockHash:'0'.repeat(64),time:m.time,txs:[txs[0]]});}
   return {code:0};
  }catch{return {code:1};}}
  const s=this.blocks.header,root=this.blocks.root,config=this.handler.config,b64=h=>Buffer.from(h,'hex').toString('base64');
  // CometBFT still knows the legacy root at the migration boundary. The first
  // indexed root is certified by the next committed block, never by Info alone.
  const appHash=this.terms.kind!=='fresh-genesis'&&s.height===this.terms.sourceHeight?this.terms.sourceRoot:root,response={height:s.height,hash:b64(appHash)};
  const request={height:q.height,blockHash:q.hash?Buffer.from(q.hash,'base64').toString('hex'):'0'.repeat(64),time:q.time,txs};
  switch(q.method){
   case 'info':return response;
   case 'init':assert.equal(q.chain,config.chainId);assert.equal(hash(JSON.parse(Buffer.from(q.state,'base64'))),validateConfig(config));return response;
   case 'prepare':{const selected=txs.slice(0,64),r=this.blocks.preview({...request,txs:selected},{filter:true});return {txs:selected.filter((_,i)=>r.codes[i]===0).map(x=>x.toString('base64'))};}
   case 'process':try{this.blocks.preview(request);return {accept:true};}catch{return {accept:false};}
   case 'finalize':{const r=this.blocks.finalize(request);return {hash:b64(r.root),codes:r.codes,updates:r.updates};}
   case 'commit':this.blocks.commit();return {};
   case 'runtime':return {value:{memory:process.memoryUsage(),cpu:process.cpuUsage(),height:s.height}};
   case 'publicCheckpoint':return {value:publication()};
   case 'status':return {...response,value:{profile:config.profile,chain:config.chainId,height:s.height,appHash,indexed:true,queryDomain:'DUEBYTE_BOUNDED_QUERY_V5',trialOnly:true}};
   case 'work':case 'publicWork':{
    assert(work,'no worker');const qwork=q.method==='publicWork'?JSON.parse(q.key):q;
    const read=(type,id)=>queryBounded(this.handler,{type,id},root).result.data,meta=read('wallet-meta',null),pid=qwork.pid;
    const state={...meta.network,money:{...meta.money,requests:{[pid]:read('request',pid)},nodes:{[work.node]:read('node',work.node)}}};
    return {value:workReceipt(state,pid,qwork.index,work.node,work)};
   }
   case 'listSnapshots':return {snapshots:[]};
   default:throw Error('Indexed method unavailable; legacy snapshot fallback is forbidden');
  }
 }
 close(){this.blocks.close();}
}
