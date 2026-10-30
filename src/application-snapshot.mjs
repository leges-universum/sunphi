import {canonical,digest,exact,fieldString} from './protocol.mjs';
import {stateSummary} from './state-proof.mjs';
import {verifyStateEnvelope} from './map-proof.mjs';
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
// The anchor MUST come from independently authenticated history, never from
// the downloaded snapshot or its sidecar. No automatic disk-cache trust.
export function verifyApplicationSnapshot(snapshot,config,anchor){
 exact(anchor,['genesis','height','appHash']);exact(snapshot,['version','genesis','height','appHash','preimage','state','governance','witnessRoots']);
 if(snapshot.version!==1||anchor.genesis!==digest(config)||snapshot.genesis!==anchor.genesis||snapshot.height!==anchor.height||snapshot.appHash!==anchor.appHash||Buffer.byteLength(canonical(snapshot))>64*1024*1024)throw Error('snapshot external anchor or bound');
 const s=snapshot.state;exact(s,['epoch','supply','fees','minted','notes','txs','head','seq']);
 if(s.head!==digest(config.money)||s.seq!==0||!s.notes||!s.txs||Object.getPrototypeOf(s.notes)!==Object.prototype||Object.getPrototypeOf(s.txs)!==Object.prototype)throw Error('snapshot auxiliary state');
 for(const [id,n] of Object.entries(s.notes)){exact(n,['id','commitment','createdBy','index','spentBy']);fieldString(id);fieldString(n.commitment);if(n.id!==id||!hash(n.createdBy)||![0,1].includes(n.index)||(n.spentBy!==null&&!hash(n.spentBy)))throw Error('snapshot note');}
 for(const [id,value] of Object.entries(s.txs))if(!hash(id)||value!==true)throw Error('snapshot transaction map');
 const p=snapshot.preimage;verifyStateEnvelope({...snapshot,summary:stateSummary(s)},anchor.appHash);
 if((snapshot.governance===null?undefined:digest(snapshot.governance))!==p.governance||(snapshot.witnessRoots===null?undefined:digest(snapshot.witnessRoots))!==p.witnessRoots)throw Error('snapshot authority state');
 return structuredClone(snapshot);
}
