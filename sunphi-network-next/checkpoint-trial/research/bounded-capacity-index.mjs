// Root-authenticated routing accelerator. Selected workers still require the
// ordinary payment verifier; this index grants no monetary authority.
import assert from 'node:assert/strict';
import {canonical,hex} from '../crypto.mjs';
import {amount,policy} from '../payment-model.mjs';
import {plan} from '../payment-plan.mjs';
const prefix='routing/';
const key=(mode,path='')=>prefix+mode+'/'+(path||'root');
const min=(a,b)=>a<b?a:b;
const rank=(a,b)=>{const ac=min(BigInt(a.free),BigInt(a.tier)),bc=min(BigInt(b.free),BigInt(b.tier));return ac===bc?(a.free===b.free?a.id.localeCompare(b.id):BigInt(a.free)>BigInt(b.free)?-1:1):ac>bc?-1:1;};
const group=n=>n.founder?'founder/'+n.id:'owner/'+n.group;
function best(rows){const groups=new Set();return rows.flat().sort(rank).filter(n=>{const g=group(n);if(groups.has(g))return false;groups.add(g);return true;}).slice(0,3);}
function entry(m,id,n,mode){
 if(!n)return null;const free=amount(n.stake)-amount(n.consensusHeld)-amount(n.taskHeld);
 if(free<=0n||amount(n.tier)===0n||amount(n.consensusHeld)===0n)return null;
 const l=m.liability;if(mode==='liable'&&(!l?.consents[id]||l.discipline[id]?.suspended))return null;
 const founder=mode==='liable'&&l.policy.founderNodes.includes(id);
 return {id,group:founder?l.policy.founderGroup:n.operator,founder,free:String(free),tier:n.tier};
}
function change(tx,mode,id,value,path=''){
 assert(path.length<=64,'capacity index depth');
 const k=key(mode,path),old=tx.get(k);
 if(!old){if(value)tx.set(k,{id,top:[value]});return value?{id,top:[value]}:null;}
 const stem=old.id??old.prefix;let common=0;while(common<stem.length&&stem[common]===id[common])common++;
 if(common<stem.length){
  if(!value)return old;const p=stem.slice(0,common),a=stem[common],b=id[common],leaf={id,top:[value]};
  tx.set(key(mode,p+a),old);tx.set(key(mode,p+b),leaf);
  const next={prefix:p,children:[[a,old.top],[b,leaf.top]].sort(([a],[b])=>a.localeCompare(b)),top:best([old.top,leaf.top])};tx.set(k,next);return next;
 }
 if(old.id){assert.equal(old.id,id);if(!value){tx.delete(k);return null;}const next={id,top:[value]};if(canonical(next)!==canonical(old))tx.set(k,next);return next;}
 const digit=id[old.prefix.length],child=change(tx,mode,id,value,old.prefix+digit),children=old.children.filter(([d])=>d!==digit);
 if(child)children.push([digit,child.top]);children.sort(([a],[b])=>a.localeCompare(b));
 if(children.length===1){const childKey=key(mode,old.prefix+children[0][0]),only=tx.get(childKey);tx.set(k,only);tx.delete(childKey);return only;}
 const next={prefix:old.prefix,children,top:best(children.map(([,top])=>top))};if(canonical(next)!==canonical(old))tx.set(k,next);return next;
}
export function updateCapacityIndex(tx,before,after,touched){
 const ids=new Set([...touched].filter(([,r])=>r.bucket==='nodes').map(([k])=>k.slice(6)));
 const a=before.liability,b=after.liability;
 for(const field of ['consents','discipline'])for(const id of new Set([...Object.keys(a?.[field]??{}),...Object.keys(b?.[field]??{})]))if(canonical(a?.[field]?.[id]??null)!==canonical(b?.[field]?.[id]??null))ids.add(id);
 if(canonical(a?.policy??null)!==canonical(b?.policy??null))for(const id of new Set([...(a?.policy.founderNodes??[]),...(b?.policy.founderNodes??[])]))ids.add(id);
 for(const id of [...ids].sort()){const r=touched.get('nodes/'+id),n=r?r.value:tx.get('nodes/'+id);for(const mode of ['open','liable'])change(tx,mode,id,entry(after,id,n,mode));}
}
export function createCapacityIndex(tx,money){for(const id of Object.keys(money.nodes).sort()){hex(id);for(const mode of ['open','liable'])change(tx,mode,id,entry(money,id,money.nodes[id],mode));}}
export function auditCapacityIndex(records,money){const expected=new Map(),tx={get:k=>expected.get(k),set:(k,v)=>expected.set(k,v),delete:k=>expected.delete(k)};createCapacityIndex(tx,money);const sort=rows=>[...rows].sort(([a],[b])=>a.localeCompare(b));assert.deepEqual(sort([...records].filter(([k])=>k.startsWith(prefix))),sort(expected),'capacity routing index differs');}
export function warmupCapacity(get,money){
 const mode=money.liability&&money.liability.height>=money.liability.policy.activation?'liable':'open',overlay=new Map(),cache=new Map(),groups=new Set(),chosen=[];
 const tx={get:k=>{if(overlay.has(k))return overlay.get(k);if(!cache.has(k)){assert(cache.size<512,'warmup routing read budget');cache.set(k,get(k));}return cache.get(k);},set:(k,v)=>overlay.set(k,v),delete:k=>overlay.set(k,undefined)};
 for(let i=0;i<policy.copies;i++){const n=tx.get(key(mode))?.top.find(n=>n.founder||!groups.has(n.group));if(!n)return [];chosen.push(n.id);groups.add(n.group);change(tx,mode,n.id,null);}
 return chosen;
}
export function selectCapacity(get,money,value){
 let left=amount(value);assert(left>0n);const mode=money.liability&&money.liability.height>=money.liability.policy.activation?'liable':'open',cache=new Map(),overlay=new Map(),selected=new Set();
 const tx={get:k=>{if(overlay.has(k))return overlay.get(k);if(!cache.has(k)){assert(cache.size<16384,'routing read budget');cache.set(k,get(k));}return cache.get(k);},set:(k,v)=>overlay.set(k,v),delete:k=>overlay.set(k,undefined)};
 for(let part=0;left>0n;part++){
  assert(part<policy.maxParts,'route part limit');const chosen=[],groups=new Set();
  for(let i=0;i<policy.copies;i++){
   const n=tx.get(key(mode))?.top.find(n=>n.founder||!groups.has(n.group));assert(n,'not enough independent worker capacity');
   chosen.push(n);groups.add(n.group);selected.add(n.id);change(tx,mode,n.id,null);
  }
  let size=left;for(const n of chosen)size=min(size,min(BigInt(n.free),BigInt(n.tier)));assert(size>0n);left-=size;
  for(const n of chosen){const free=BigInt(n.free)-size;change(tx,mode,n.id,free>0n?{...n,free:String(free)}:null);}
 }
 const nodes={};for(const id of selected){nodes[id]=get('nodes/'+id);assert(nodes[id],'missing selected worker');}
 // Revalidate current records; a route summary cannot authorize spending.
 return [...new Set(plan({...money,nodes},value).flatMap(p=>p.nodes))].sort();
}
