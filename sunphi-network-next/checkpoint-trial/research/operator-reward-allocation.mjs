// Redistribution is a SECOND pass over the legacy result. Home keeps every
// micro-token, including the original global largest-remainder tie decisions.
import assert from 'node:assert/strict';
import {exact,integer} from '../crypto.mjs';
import {changeRadix,radixCount,radixIds} from './bounded-radix-index.mjs';
export const adjustmentKey=(day,node)=>'service-rewards/adjust/'+day+'/'+node;
const ri=d=>'service-rewards/adjust-rank/'+d;
const mi=(d,r)=>'service-rewards/adjust-members/'+d+'/'+r;
const MAX=(1n<<256n)-1n,rank=r=>(MAX-r).toString(16).padStart(64,'0');
const legacy=c=>BigInt(c.baseMicro)+(c.bonus?1n:0n);
export const finalServiceCredit=(get,day,node,c)=>{const a=get(adjustmentKey(day,node));return a?BigInt(a.baseMicro)+(a.bonus?1n:0n):legacy(c);};
export const newAdjustment=()=>({phase:'COUNT',after:null,pool:'0',weight:'0',count:0,base:'0',left:0,rankAfter:null,memberAfter:null,factor:null,mixed:false});
export function advanceAdjustment(tx,day,a,{ids,work,credit},batch=32){
 if(a.phase==='COUNT'){
  const ns=ids(a.after,batch);
  for(const n of ns){const w=work(n);if(w.factor!==undefined){assert([2,3,4].includes(w.factor));a.pool=String(BigInt(a.pool)+legacy(credit(n)));a.weight=String(BigInt(a.weight)+BigInt(w.units)*BigInt(w.factor));a.count++;if(a.factor===null)a.factor=w.factor;else if(a.factor!==w.factor)a.mixed=true;}a.after=n;}
  if(ns.length<batch||!ids(a.after,1).length){a.after=null;a.phase=a.mixed?'BASE':'DONE';}return a.phase==='DONE';
 }
 if(a.phase==='BASE'){
  const ns=ids(a.after,batch);
  for(const n of ns){const w=work(n);if(w.factor!==undefined){const v=BigInt(a.pool)*BigInt(w.units)*BigInt(w.factor),base=v/BigInt(a.weight),rem=v%BigInt(a.weight),r=rank(rem);
   if(!radixCount(tx.get,mi(day,r)))changeRadix(tx,ri(day),r,true);changeRadix(tx,mi(day,r),n,true);
   tx.set(adjustmentKey(day,n),{baseMicro:String(base),remainder:String(rem),bonus:false});a.base=String(BigInt(a.base)+base);
  }a.after=n;}
  if(ns.length<batch||!ids(a.after,1).length){a.phase='BONUS';a.after=null;a.left=Number(BigInt(a.pool)-BigInt(a.base));assert(a.left>=0&&a.left<a.count);}return false;
 }
 assert.equal(a.phase,'BONUS');let left=batch;
 while(left&&a.left){const r=a.memberAfter!==null?a.rankAfter:[...radixIds(tx.get,ri(day),{after:a.rankAfter,limit:1})][0];assert(r);
  const ns=[...radixIds(tx.get,mi(day,r),{after:a.memberAfter,limit:Math.min(left,a.left)})];assert(ns.length);
  for(const n of ns){const c=tx.get(adjustmentKey(day,n));assert(!c.bonus);c.bonus=true;tx.set(adjustmentKey(day,n),c);a.left--;left--;a.memberAfter=n;}
  a.rankAfter=r;if(![...radixIds(tx.get,mi(day,r),{after:a.memberAfter,limit:1})].length)a.memberAfter=null;
 }
 if(!a.left)a.phase='DONE';return a.phase==='DONE';
}
export function removeAdjustment(tx,day,node,remove){const c=tx.get(adjustmentKey(day,node));if(!c)return;const r=rank(BigInt(c.remainder));remove(adjustmentKey(day,node));changeRadix(tx,mi(day,r),node,false);if(!radixCount(tx.get,mi(day,r)))changeRadix(tx,ri(day),r,false);}
export function isAdjustmentRecord(k){return /^service-rewards\/(adjust\/[1-9][0-9]*\/[a-f0-9]{64}|adjust-rank\/[1-9][0-9]*\/(root|[a-f0-9]{1,64})|adjust-members\/[1-9][0-9]*\/[a-f0-9]{64}\/(root|[a-f0-9]{1,64}))$/.test(k);}
export function auditAdjustment(get,expected,day,a,nodes,work,credit,pruned=false){
 exact(a,Object.keys(newAdjustment()));assert(['COUNT','BASE','BONUS','DONE'].includes(a.phase));integer(a.count);integer(a.left);assert.equal(typeof a.mixed,'boolean');assert(a.factor===null||[2,3,4].includes(a.factor));
 for(const k of ['pool','weight','base'])assert(typeof a[k]==='string'&&/^(0|[1-9][0-9]*)$/.test(a[k]));
 const linux=nodes.filter(n=>work(n).factor!==undefined);
 if(!pruned){const counted=a.phase==='COUNT'?linux.filter(n=>a.after!==null&&n<=a.after):linux;
  assert.equal(a.count,counted.length);assert.equal(BigInt(a.pool),counted.reduce((v,n)=>v+legacy(credit(n)),0n));assert.equal(BigInt(a.weight),counted.reduce((v,n)=>v+BigInt(work(n).units)*BigInt(work(n).factor),0n));
  const factors=new Set(counted.map(n=>work(n).factor));assert.equal(a.mixed,factors.size>1);assert.equal(a.factor,counted.length?work(counted[0]).factor:null);
 }
 if(!a.mixed||a.phase==='COUNT')return;
 const selected=a.phase==='BASE'?linux.filter(n=>a.after!==null&&n<=a.after):linux;let bases=0n,bonuses=0;
 for(const n of selected){const v=BigInt(a.pool)*BigInt(work(n).units)*BigInt(work(n).factor),base=v/BigInt(a.weight),rem=v%BigInt(a.weight),r=rank(rem),c=get(adjustmentKey(day,n));exact(c,['baseMicro','remainder','bonus']);assert.equal(c.baseMicro,String(base));assert.equal(c.remainder,String(rem));
  assert.equal(c.bonus,a.rankAfter!==null&&(r<a.rankAfter||r===a.rankAfter&&(a.memberAfter===null||n<=a.memberAfter)));bases+=base;bonuses+=Number(c.bonus);
  expected.set(adjustmentKey(day,n),c);if(!radixCount(expected.get,mi(day,r)))changeRadix(expected,ri(day),r,true);changeRadix(expected,mi(day,r),n,true);
 }
 if(!pruned){assert.equal(a.base,String(bases));if(['BONUS','DONE'].includes(a.phase))assert.equal(BigInt(a.left+bonuses)+bases,BigInt(a.pool));}
 if(a.phase==='DONE')assert.equal(a.left,0);
}
// Offline oracle: same two-stage policy, deliberately not used by hot paths.
export function redistributeLinux(pool,rows){
 const allocate=(value,items)=>{const total=items.reduce((v,r)=>v+r.weight,0n);if(!total){assert.equal(value,0n);return new Map();}const rs=items.map(r=>({...r,amount:value*r.weight/total,remainder:value*r.weight%total})).sort((a,b)=>a.remainder===b.remainder?(a.node<b.node?-1:1):a.remainder>b.remainder?-1:1);let left=value-rs.reduce((v,r)=>v+r.amount,0n);for(const r of rs)if(left>0n){r.amount++;left--;}return new Map(rs.map(r=>[r.node,r.amount]));};
 assert(typeof pool==='bigint'&&pool>=0n&&pool<=MAX);assert(new Set(rows.map(r=>r.node)).size===rows.length);
 for(const r of rows){assert(/^[a-f0-9]{64}$/.test(r.node));assert(typeof r.units==='bigint'&&r.units>0n&&r.units<=MAX);assert(['worker','witness'].includes(r.kind));assert([2,3,4].includes(r.factor));}
 const baseline=allocate(pool,rows.map(r=>({...r,weight:r.units}))),linux=rows.filter(r=>r.kind==='worker');
 if(new Set(linux.map(r=>r.factor)).size<2)return baseline;
 const budget=linux.reduce((v,r)=>v+baseline.get(r.node),0n),out=allocate(budget,linux.map(r=>({...r,weight:r.units*BigInt(r.factor)})));
 for(const r of rows)if(r.kind==='witness')out.set(r.node,baseline.get(r.node));return out;
}
