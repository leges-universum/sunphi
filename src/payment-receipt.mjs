import { exact,parseWire,fieldString } from './protocol.mjs';
import { stateIndexes,mapProof,verifyMapProof,verifyStateEnvelope } from './map-proof.mjs';
import { stateSummary } from './state-proof.mjs';
export function receiptQuery(key){const q=JSON.parse(key);exact(q,['txid','inputs']);if(!/^[a-f0-9]{64}$/.test(q.txid)||!Array.isArray(q.inputs)||q.inputs.length>2||new Set(q.inputs).size!==q.inputs.length)throw new Error('receipt query');q.inputs.forEach(fieldString);return q;}
export function paymentEnvelope(state,height,appHash,preimage,query){const t=stateIndexes(state);return {version:1,height,appHash,preimage,summary:stateSummary(state),txid:query.txid,transaction:mapProof(state.txs,t.txs,query.txid),inputs:query.inputs.map(id=>({id,proof:mapProof(state.notes,t.notes,id)}))};}
// The signed application's tx map is append-only. Absence is final rejection
// ONLY if an input is irrevocably spent elsewhere or the monetary epoch expired.
export function verifyPaymentEnvelope(p,root,wire){
 exact(p,['version','height','appHash','preimage','summary','txid','transaction','inputs']);if(p.version!==1)throw new Error('receipt version');verifyStateEnvelope(p,root);
 const parsed=parseWire(wire),s=parsed.s,ids=s.kind.toBigint()===0n?[s.id0.toString(),...(s.second.toBoolean()?[s.id1.toString()]:[])]:[];
 if(p.txid!==parsed.txid||!Array.isArray(p.inputs)||p.inputs.length!==ids.length)throw new Error('receipt transaction mismatch');
 const tx=verifyMapProof(p.transaction,p.txid,'txs-v1',p.summary.txsRoot),inputs=p.inputs.map((q,i)=>{exact(q,['id','proof']);if(q.id!==ids[i])throw new Error('receipt input substitution');const r=verifyMapProof(q.proof,q.id,'notes-v1',p.summary.notesRoot);if(r.present){exact(r.value,['id','commitment','createdBy','index','spentBy']);if(r.value.id!==q.id||r.value.commitment!==s[`commitment${i}`].toString()||(r.value.spentBy!==null&&!/^[a-f0-9]{64}$/.test(r.value.spentBy)))throw new Error('receipt input mismatch');}return r;});
 if(tx.present){if(tx.value!==true)throw new Error('receipt transaction membership value');return {txid:p.txid,status:'confirmed',final:true,confirmed:true,height:p.height,appHash:root};}
 if(inputs.some(r=>r.present&&r.value.spentBy===p.txid))throw new Error('inconsistent transaction absence');
 const conflicting=inputs.find(r=>r.present&&r.value.spentBy!==null);
 const status=conflicting?'conflicted':p.summary.epoch>Number(s.expiry.toBigint())?'expired':'not-included-at-checkpoint';
 return {txid:p.txid,status,final:status!=='not-included-at-checkpoint',confirmed:false,height:p.height,appHash:root,...(conflicting?{spentBy:conflicting.value.spentBy}:{})};
}
