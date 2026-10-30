import {canonical,digest,exact,parseWire} from './protocol.mjs';
import {verifyStateEnvelope} from './map-proof.mjs';
import {decodeWire} from './transport.mjs';
import {isRenewal} from './root-renewal.mjs';
import {isRotation} from './rotation.mjs';
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export function deltaQuery(text){const q=JSON.parse(text);exact(q,['height','appHash']);if(!Number.isSafeInteger(q.height)||q.height<1||!hash(q.appHash))throw Error('delta anchor');return q;}
// The current signed app hash commits to every predecessor and exact ordered
// transaction list. Empty blocks matter too: none may be omitted or replaced.
export function verifyDiscoveryDelta(p,root,anchor){
 exact(p,['version','height','appHash','preimage','summary','from','frames']);verifyStateEnvelope(p,root);
 if(p.version!==1||canonical(p.from)!==canonical(anchor)||!Array.isArray(p.frames)||p.height<anchor.height||p.height-anchor.height>64||p.frames.length!==p.height-anchor.height||Buffer.byteLength(canonical(p))>768*1024)throw Error('delta window or completeness');
 let parent=anchor.appHash,height=anchor.height;const wires=[],seen=new Set();
 for(const f of p.frames){
  exact(f,['preimage','txs']);const x=f.preimage;exact(x,['parent','height','blockHash','state','txs',...(Object.hasOwn(x,'governance')?['governance']:[]),...(Object.hasOwn(x,'witnessRoots')?['witnessRoots']:[])]);
  if(x.height!==++height||x.parent!==parent||!hash(x.state)||!Array.isArray(f.txs)||f.txs.length>16||canonical(x.txs)!==canonical(f.txs.map(digest)))throw Error('delta chain or transaction omission');
  parent=digest(x);
  for(const text of f.txs){if(typeof text!=='string'||text.length>140000)throw Error('delta transaction size');const raw=Buffer.from(text,'base64');if(raw.toString('base64')!==text)throw Error('delta encoding');if(isRenewal(raw)||isRotation(raw))continue;const wire=decodeWire(raw),p=parseWire(wire);if(seen.has(p.txid))throw Error('duplicate delta transaction');seen.add(p.txid);wires.push(wire);}
 }
 if(parent!==root)throw Error('delta does not reach authenticated root');
 return {height:p.height,appHash:root,root:p.summary.notesRoot,epoch:p.summary.epoch,wires,blocks:p.frames.length,bytes:Buffer.byteLength(canonical(p))};
}
