// Shared authenticated counted radix tree for bounded seek and pagination.
import assert from 'node:assert/strict';
import {exact,hex,integer} from '../crypto.mjs';
const indexKey=(kind,path)=>kind+'/'+(path||'root');
const count=n=>n.id?1:n.count;
function checked(n,path){
 assert(n,'missing radix index');
 if(Object.hasOwn(n,'id')){exact(n,['id']);hex(n.id);assert(n.id.startsWith(path));}
 else{
  exact(n,['prefix','count','children']);assert(typeof n.prefix==='string'&&/^[a-f0-9]*$/.test(n.prefix)&&n.prefix.length<64&&n.prefix.startsWith(path));
  integer(n.count,2);assert(Array.isArray(n.children)&&n.children.length>=2&&n.children.length<=16);
  let sum=0,last='';for(const pair of n.children){assert(Array.isArray(pair)&&pair.length===2);const [c,size]=pair;assert(/^[a-f0-9]$/.test(c)&&c>last);integer(size,1);sum+=size;last=c;}assert.equal(sum,n.count);
 }return n;
}
export function changeRadix(tx,kind,id,insert,path=''){
 hex(id);assert.equal(typeof insert,'boolean');assert(path.length<=64,'radix depth');
 const key=indexKey(kind,path),old=tx.get(key);
 if(!old){assert(insert,'missing radix index member');tx.set(key,{id});return 1;}
 const n=checked(old,path),prefix=n.id??n.prefix;
 let common=0;while(common<prefix.length&&id[common]===prefix[common])common++;
 if(common<prefix.length){
  assert(insert,'missing radix index member');const stem=prefix.slice(0,common),a=prefix[common],b=id[common];
  tx.set(indexKey(kind,stem+a),n);tx.set(indexKey(kind,stem+b),{id});
  tx.set(key,{prefix:stem,count:count(n)+1,children:[[a,count(n)],[b,1]].sort(([a],[b])=>a<b?-1:1)});return count(n)+1;
 }
 if(n.id){assert.equal(n.id,id);assert(!insert,'duplicate radix index member');tx.delete(key);return 0;}
 const digit=id[n.prefix.length],children=n.children.map(x=>[...x]),at=children.findIndex(([c])=>c===digit);
 assert(insert||at>=0,'missing radix index member');
 const size=changeRadix(tx,kind,id,insert,n.prefix+digit);
 if(at>=0){if(size)children[at][1]=size;else children.splice(at,1);}else children.push([digit,size]);
 children.sort(([a],[b])=>a<b?-1:1);
 if(children.length===1){const childKey=indexKey(kind,n.prefix+children[0][0]),child=checked(tx.get(childKey),n.prefix+children[0][0]);assert.equal(count(child),children[0][1]);tx.set(key,child);tx.delete(childKey);}
 else tx.set(key,{prefix:n.prefix,count:n.count+(insert?1:-1),children});
 return n.count+(insert?1:-1);
}
export function radixCount(get,kind){const n=get(indexKey(kind,''));return n?count(checked(n,'')):0;}
export function* radixIds(get,kind,{offset=0,limit=Number.MAX_SAFE_INTEGER,after=null}={}){
 if(after!==null){hex(after);assert.equal(offset,0);}integer(offset);integer(limit,1);const root=get(indexKey(kind,''));if(!root){assert.equal(offset,0);return;}
 const n=checked(root,'');assert(offset<=count(n),'radix index offset');
 let skip=offset,left=limit;
 function* walk(node,path){
  if(!left)return;checked(node,path);
  if(node.id){if(after!==null&&node.id<=after)return;if(skip)skip--;else{left--;yield node.id;}return;}
  for(const [digit,size]of node.children){if(!left)return;if(skip>=size){skip-=size;continue;}
   const childPath=node.prefix+digit;if(after!==null&&childPath.padEnd(64,'f')<=after)continue;
   const child=checked(get(indexKey(kind,childPath)),childPath);assert.equal(count(child),size,'radix index child count');yield* walk(child,childPath);
  }
 }
 yield* walk(n,'');
}

