import {exact,parseWire,canonical,fieldString} from './protocol.mjs';
import {stateIndexes,mapProof,verifyMember,verifyMapProof,verifyStateEnvelope} from './map-proof.mjs';
import {stateSummary} from './state-proof.mjs';

export function inventoryQuery(key){const q=JSON.parse(key);exact(q,['start','root']);if(!Number.isSafeInteger(q.start)||q.start<0||q.start>1000000||(q.root!==null&&!/^[a-f0-9]{64}$/.test(q.root)))throw Error('inventory query');return q;}
export function inventoryEnvelope(state,height,appHash,preimage,q,wireFor){
 const t=stateIndexes(state).notes;if(q.root!==null&&q.root!==t.root)throw Error('inventory changed; restart scan');if(q.start>t.keys.length)throw Error('inventory cursor');
 const entries=t.keys.slice(q.start,q.start+4).map(id=>mapProof(state.notes,t,id).entry),wires=[...new Set(entries.map(e=>e.value.createdBy))].map(wireFor);
 return {version:1,height,appHash,preimage,summary:stateSummary(state),start:q.start,count:t.keys.length,entries,wires};
}
// Every consecutive Merkle position is required, including the final position.
// A valid proof for selected entries alone must NEVER establish completeness.
export function verifyInventoryEnvelope(p,root,q){
 exact(p,['version','height','appHash','preimage','summary','start','count','entries','wires']);verifyStateEnvelope(p,root);
 if(p.version!==1||p.start!==q.start||!Number.isSafeInteger(p.count)||p.count<0||p.count>1000000||p.start>p.count||!Array.isArray(p.entries)||p.entries.length!==Math.min(4,p.count-p.start)||!Array.isArray(p.wires)||p.wires.length>4||q.root!==null&&q.root!==p.summary.notesRoot)throw Error('incomplete or changed inventory page');
 if(!p.count)verifyMapProof({kind:'absent',count:0,left:null,right:null},'0','notes-v1',p.summary.notesRoot);
 const wires=new Map();for(const wire of p.wires){const parsed=parseWire(wire);if(wires.has(parsed.txid))throw Error('duplicate inventory wire');wires.set(parsed.txid,parsed);}
 const used=new Set();let previous;
 for(let i=0;i<p.entries.length;i++){
  const e=p.entries[i],n=verifyMember(e,'notes-v1',p.summary.notesRoot);exact(n,['id','commitment','createdBy','index','spentBy']);fieldString(n.id);fieldString(n.commitment);
  if(e.index!==p.start+i||e.count!==p.count||e.key!==n.id||previous!==undefined&&previous>=e.key||![0,1].includes(n.index)||n.spentBy!==null&&!/^[a-f0-9]{64}$/.test(n.spentBy))throw Error('inventory position or note');previous=e.key;
  const wire=wires.get(n.createdBy);if(!wire||wire.ids[n.index]!==n.id||wire.o[`commitment${n.index}`].toString()!==n.commitment)throw Error('inventory ciphertext substitution');used.add(n.createdBy);
 }
 if(used.size!==wires.size||Buffer.byteLength(canonical(p))>768*1024)throw Error('inventory wire set or size');
 return {root:p.summary.notesRoot,appHash:p.appHash,count:p.count,next:p.start+p.entries.length,height:p.height,epoch:p.summary.epoch,entries:p.entries.map(e=>e.value),wires:p.wires};
}
