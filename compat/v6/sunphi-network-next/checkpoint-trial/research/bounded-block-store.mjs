// Finalize computes and rolls back a candidate. Only Commit persists it.
import assert from 'node:assert/strict';
import {hash,canonical} from '../crypto.mjs';
import {validatorUpdates} from '../authority.mjs';
const copyRequest=request=>{assert(Array.isArray(request.txs)&&request.txs.length<=64);let bytes=0;return {...request,txs:request.txs.map(b=>{assert(b instanceof Uint8Array&&b.length>0&&b.length<=65536);bytes+=b.length;assert(bytes<=1048576,'block byte budget');return Buffer.from(b);})};};
const requestDigest=request=>hash({...request,txs:request.txs.map(b=>b.toString('base64'))});
const version=value=>value===undefined?{present:false}:{present:true,value};
export class BoundedBlockStore{
 #candidate=null;#pending=null;
 constructor(handler){assert(!handler.isolatedIssuance,'live block adapter forbids isolated issuance');this.handler=handler;}
 get root(){return this.handler.root;}
 get header(){return this.handler.networkHeader();}
 preview(request,{filter=false}={}){
  assert(typeof filter==='boolean');const copy=copyRequest(request),digest=requestDigest(copy),parent={...this.handler.store.meta},cached=this.#candidate;
  if(!filter&&cached&&cached.digest===digest&&canonical(cached.parent)===canonical(parent))return structuredClone(cached.result);
  const reads=new Map();let header,plan;const out=this.handler.commitBlock(copy,parent.rootHash,{filter,dryRun:true,observeRead:filter?undefined:(key,value)=>{if(!reads.has(key))reads.set(key,hash(version(value)));},beforeCommit:()=>{
   header=this.header;
   if(!filter){const row=this.handler.store.db.prepare('SELECT body,digest FROM journal WHERE sequence=?').get(parent.sequence+1);
    // Private, bounded, process-local plan. Never accepted from disk or RPC.
    // Larger candidates keep the existing execute-again Commit path.
    if(row&&Buffer.byteLength(row.body)<=16*1024*1024)plan={body:JSON.parse(row.body),digest:row.digest};
   }
  }});
  header??=this.header;const result={root:out.root,codes:out.value.codes,header,updates:validatorUpdates(header,copy.height)};
  if(!filter)this.#candidate={parent,digest,result:structuredClone(result),plan,reads,value:structuredClone(out.value)};
  return result;
 }
 finalize(request){
  const copy=copyRequest(request),digest=requestDigest(copy);
  if(this.#pending){assert.equal(this.root,this.#pending.parent,'stale finalized parent');assert.equal(digest,this.#pending.digest,'pending block conflict');return structuredClone(this.#pending.result);}
  const parent=this.root,result=this.preview(copy);
  if(copy.height===this.header.height)return result;
  this.#pending={parent,request:copy,digest,result,candidate:this.#candidate};return structuredClone(result);
 }
 commit({beforeCommit}={}){
  if(!this.#pending)return {root:this.root,duplicate:true};const p=this.#pending,c=p.candidate;
  const check=()=>{assert.equal(this.root,p.result.root,'finalize/commit root mismatch');beforeCommit?.();};let out;
  if(c?.plan){
   // Reapply only the locally validated write set, under a fresh atomic writer
   // transaction. Authenticate opening values and reproduce the exact journal.
   // Losing this process simply loses the plan; recovery revalidates the block.
   out=this.handler.store.transact(p.parent,c.plan.body.event,tx=>{
    assert.equal(c.digest,p.digest);assert.equal(canonical({...this.handler.store.meta}),canonical(c.parent),'stale prepared journal');
    for(const [key,digest]of c.reads)assert.equal(hash(version(tx.get(key))),digest,'prepared read value mismatch');
    for(const change of c.plan.body.changes){assert.equal(canonical(version(tx.get(change.key))),canonical(change.before),'prepared opening value mismatch');if(change.after.present)tx.set(change.key,change.after.value);else tx.delete(change.key);}
    return structuredClone(c.value);
   },{recordLimit:8192,eventLimit:2*1024*1024,beforeCommit:()=>{assert.equal(this.handler.store.meta.journalHash,c.plan.digest,'prepared journal mismatch');check();}});
  }else out=this.handler.commitBlock(p.request,p.parent,{beforeCommit:check});
  assert.equal(out.root,p.result.root);this.#pending=null;this.#candidate=null;return out;
 }
 close(){this.#pending=null;this.#candidate=null;this.handler.close();}
}
