import { digest,exact } from './protocol.mjs';
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const snapshots=new WeakMap();
// Only immutable ledger snapshots are accepted here, never mutable maps.
// One tree serves summaries, passports and receipts throughout empty blocks.
export function stateIndexes(state){if(!snapshots.has(state))snapshots.set(state,{txs:mapTree(state.txs,'txs-v1'),notes:mapTree(state.notes,'notes-v1')});return snapshots.get(state);}
export function mapTree(map,domain){
 const keys=Object.keys(map).sort(),levels=[keys.map(key=>digest({domain,key,value:map[key]}))];
 if(!keys.length)levels[0]=[digest({domain,empty:true})];
 while(levels.at(-1).length>1){const a=levels.at(-1),b=[];for(let i=0;i<a.length;i+=2)b.push(digest({domain,left:a[i],right:a[i+1]??a[i]}));levels.push(b);}
 return {keys,levels,root:digest({domain,count:keys.length,root:levels.at(-1)[0]})};
}
function position(keys,key){let lo=0,hi=keys.length;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(keys[mid]<key)lo=mid+1;else hi=mid;}return lo;}
function member(map,tree,index){let at=index;const siblings=[];for(let n=0;n<tree.levels.length-1;n++){const a=tree.levels[n];siblings.push(a[at^1]??a[at]);at=Math.floor(at/2);}const key=tree.keys[index];return {key,value:structuredClone(map[key]),index,count:tree.keys.length,siblings};}
export function mapProof(map,tree,key){const i=position(tree.keys,key);return tree.keys[i]===key?{kind:'present',entry:member(map,tree,i)}:{kind:'absent',count:tree.keys.length,left:i?member(map,tree,i-1):null,right:i<tree.keys.length?member(map,tree,i):null};}
export function verifyMember(q,domain,root){
 exact(q,['key','value','index','count','siblings']);
 if(typeof q.key!=='string'||!hex(root)||!Number.isSafeInteger(q.count)||q.count<1||!Number.isSafeInteger(q.index)||q.index<0||q.index>=q.count||!Array.isArray(q.siblings)||q.siblings.length!==Math.ceil(Math.log2(q.count))||q.siblings.some(x=>!hex(x)))throw new Error('invalid map inclusion');
 let hash=digest({domain,key:q.key,value:q.value}),at=q.index,width=q.count;
 for(const s of q.siblings){if(at%2===0&&at+1>=width&&s!==hash)throw new Error('odd leaf mismatch');hash=at%2?digest({domain,left:s,right:hash}):digest({domain,left:hash,right:s});at=Math.floor(at/2);width=Math.ceil(width/2);}
 if(digest({domain,count:q.count,root:hash})!==root)throw new Error('map inclusion root');return q.value;
}
export function verifyMapProof(p,key,domain,root){
 if(p?.kind==='present'){exact(p,['kind','entry']);if(p.entry.key!==key)throw new Error('map key substitution');return {present:true,value:verifyMember(p.entry,domain,root)};}
 exact(p,['kind','count','left','right']);if(p.kind!=='absent'||!Number.isSafeInteger(p.count)||p.count<0)throw new Error('absence shape');
 if(p.count===0){if(p.left!==null||p.right!==null||root!==digest({domain,count:0,root:digest({domain,empty:true})}))throw new Error('empty map root');return {present:false};}
 for(const q of [p.left,p.right])if(q){verifyMember(q,domain,root);if(q.count!==p.count)throw new Error('absence count');}
 if(p.left===null){if(!p.right||p.right.index!==0||!(key<p.right.key))throw new Error('absence lower boundary');}
 else if(p.right===null){if(p.left.index!==p.count-1||!(p.left.key<key))throw new Error('absence upper boundary');}
 else if(!(p.left.key<key&&key<p.right.key)||p.left.index+1!==p.right.index)throw new Error('absence adjacency');
 return {present:false};
}
export function verifyStateEnvelope(p,root){
 exact(p.preimage,['parent','height','blockHash','state','txs',...(Object.hasOwn(p.preimage,'governance')?['governance']:[]),...(Object.hasOwn(p.preimage,'witnessRoots')?['witnessRoots']:[])]);
 exact(p.summary,['epoch','supply','fees','minted','notesRoot','txsRoot']);
 if(!hex(root)||p.appHash!==root||!Number.isSafeInteger(p.height)||p.height<1||p.height!==p.preimage.height||digest(p.preimage)!==root||digest(p.summary)!==p.preimage.state)throw new Error('untrusted receipt state');
 if(!Number.isInteger(p.summary.epoch)||p.summary.epoch<0)throw new Error('receipt epoch');
}
