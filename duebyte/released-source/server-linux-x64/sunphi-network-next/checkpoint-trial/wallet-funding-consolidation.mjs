import assert from 'node:assert/strict';
import {hash,sign,verify} from './crypto.mjs';
import {envelope} from './core.mjs';
import {consolidatedOutput,MERGE_OWNED,outsideCollateralPilot} from './worker-collateral.mjs';
import {consolidationEnabled,LEGACY_INPUTS} from './payment-input-policy.mjs';
import {prepareCollateralReview} from './worker-collateral-plan.mjs';
import {formatToken} from './token-units.mjs';

// Build a deterministic tree from only the coins covered by the user's approval.
// The final deposit consumes at most eight roots. Each intermediate transaction
// has a single possible recipient, the wallet that already owns every input.
export function consolidationTree(plan){
 let roots=plan.inputs.slice();const branches=new Map();
 while(roots.length>LEGACY_INPUTS){
  const next=[];
  let start=0;
  while(next.length+roots.length-start>LEGACY_INPUTS){
   const count=Math.min(LEGACY_INPUTS,roots.length-start,next.length+roots.length-start-LEGACY_INPUTS+1);
   if(count<2)break;
   const ids=roots.slice(start,start+count).sort();
   start+=count;
   const output=consolidatedOutput(plan.configHash,plan.owner,ids);
   branches.set(output,ids);next.push(output);
  }
  roots=next.concat(roots.slice(start));
 }
 return {roots,branches};
}

export async function advanceConsolidation(record,wallet,state,save,active,now){
 const plan=record.preparation;
 assert.equal(record.id,hash(plan));assert.equal(plan.owner,wallet.key.publicKey);
 assert.equal(plan.configHash,state.configHash);assert(verify(plan,record.authorization,plan.owner),'Invalid deposit authorization.');
 const fail=(status,message)=>{record.status=status;record.message=message;save(record);};
 if(state.money.time<plan.created)return;
 if(state.money.time>=plan.expires)return fail('EXPIRED','Preparation expired. All consolidated funds remain in your wallet.');
 const prior=state.workerFunding?.accounts[plan.node];
 if(!consolidationEnabled(state)||outsideCollateralPilot(state,plan.node)||state.money.nodes[plan.node]?.key!==plan.worker||
    (prior?.sequence??0)+1!==plan.sequence||prior?.release||(prior&&prior.owner!==plan.owner)){
  return fail('CONFLICT','Server funding terms changed. The deposit requires a new confirmation.');
 }
 const {roots,branches}=consolidationTree(plan),ready=[];
 let missing=false,unconfirmed=0;
 function available(id){
  const o=state.money.outputs[id];
  if(o?.owner===plan.owner&&o.unlock<=state.money.time&&BigInt(o.value)>0n){
   if(branches.has(id))record.verifiedMergeOutput=id;
   return true;
  }
  const inputs=branches.get(id);
  if(!inputs){missing=true;return false;}
  unconfirmed++;
  const children=inputs.map(available);
  if(children.every(Boolean)&&ready.length<8)ready.push(inputs);
  return false;
 }
 const complete=roots.map(available).every(Boolean);
 if(missing)return fail('CONFLICT','A selected input is no longer spendable. The deposit was not submitted.');
 record.mergeTotal=branches.size;record.mergeConfirmed=branches.size-unconfirmed;
 record.mergeVerifiedHeight=state.height;
 if(!complete){
  record.message='Free consolidation: '+record.mergeConfirmed+' of '+record.mergeTotal+' confirmed. Your coins remain in this wallet.';
  const batch=hash(ready),at=now();
  if(record.mergeAttempt?.batch===batch&&at>=record.mergeAttempt.at&&at-record.mergeAttempt.at<20000){save(record);return;}
  record.mergeAttempt={batch,at};save(record);
  for(const inputs of ready){
   if(!active())return;
   await wallet.broadcast(envelope(wallet.client.config,{type:MERGE_OWNED,inputs},wallet.key));
  }
  return;
 }
 const reviewed=prepareCollateralReview(state,{node:plan.node,owner:plan.owner,unitScale:plan.unitScale,
  ...(plan.votingValidator?{votingValidator:plan.votingValidator}:{}),inputs:roots,amount:formatToken(plan.valueMicro,plan.unitScale)});
 assert.equal(reviewed.body.sequence,plan.sequence);assert.equal(reviewed.body.valueMicro,plan.valueMicro);
 reviewed.body.expires=Math.min(reviewed.body.expires,plan.expires);
 if(!active())return;
 record.consent={format:'DUEBYTE_COLLATERAL_OWNER_CONSENT_V1',type:reviewed.type,body:reviewed.body,
  ownerSignature:sign(reviewed.body,wallet.key.privateKey),expectedWorkerKey:plan.worker,workerSignatureRequired:true,submitted:false};
 record.status='AWAITING_SERVER';record.message='Funds consolidated. Waiting for the server signature on one deposit.';
 save(record);
}
