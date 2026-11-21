import assert from 'node:assert/strict';
import {exact,hash,integer,sign,verify} from './crypto.mjs';
import {validatorApprovalBody,validatorQuorum,validatorSet} from './validator-authority.mjs';
import {bondedReadyBody,ENABLE_POS} from './research/pos-policy-actions.mjs';
import {normalizedVotingSet} from './research/pos-authority-transition.mjs';
import {signingKey} from './research/bounded-pos-records.mjs';
import {consensusAddress} from './consensus-context.mjs';
import {envelope} from './core.mjs';
import {RULE_VOTE,requestRuleVote} from './home-rule-route.mjs';

// One production transition approved by the operator of the initial roster.
export const cutoverOwner='H4HoFRvZ_2D_M45E5_rWgS8gEOvTYahBJw10HbZExpM';
const chain='duebyte-trial-fresh-20261109-v45';
const config='5a6af5048049049bee003078f845ccea883140f291897f950007c5ba113a807c';
const policy='da86e32f57d52ce67d7ac4b8fd7e3ad4425ca8fa6e90e16a85455d27d2eeb0c3';
const registry='107ec8dca448dcbd79200ef898aa5c7626e3acb0e89e480602841f7d308d76d2';
const consentDomain='DUEBYTE_HOME_BONDED_CUTOVER_V1';
export function cutoverOpen(s,network,owner){
 const a=s.authority;
 return owner===cutoverOwner&&network===chain&&s.configHash===config&&a?.generation===1&&
  a.posSlashing?.policyHash===policy&&a.posSlashing.activation===null&&
  !a.pending&&!a.posNext&&!a.rotatingSeat&&!a.archiveVoting&&validatorSet(a.validators).hash===registry;
}
export function cutoverBody(start){
 integer(start,1);
 return {domain:'DUEBYTE_POS_POLICY_V1/'+ENABLE_POS,network:chain,configHash:config,generation:1,
  policyHash:policy,notBefore:start,expires:start+99,activation:start+103};
}
function consent(body,node){return {domain:consentDomain,owner:cutoverOwner,node,proposal:hash(body)};}
export function signCutoverRequest(q,{state,network,worker,payouts,get,key}){
 exact(q,['operation','cutoverStart','intent','ownerSignature']);
 assert.equal(q.operation,RULE_VOTE);
 assert(payouts?.length===1&&payouts[0].wallet===cutoverOwner&&payouts[0].weight===1,'Operator wallet link changed.');
 assert(cutoverOpen(state,network,cutoverOwner),'The activation proposal is closed.');
 const body=cutoverBody(q.cutoverStart);
 assert(state.height>=body.notBefore&&state.height<body.expires,'The activation window has closed.');
 assert.deepEqual(q.intent,consent(body,worker.node));
 assert(verify(q.intent,q.ownerSignature,cutoverOwner),'The operator must approve activation in Home.');
 const members=state.authority.validators,next=normalizedVotingSet(members);
 const rows=members.map(v=>{
  const address=consensusAddress(v.key),r=get(signingKey(address));
  assert(r?.owner===cutoverOwner&&r.signing.key===v.key&&r.signing.bond==='100000000'&&!r.signing.jailed&&!r.signing.tombstoned&&r.signing.removedHeight===null&&r.signing.sequence===0,'An incumbent validator is not ready.');
  assert(get('pos/bonds/'+r.node)?.address===address,'Validator bond missing.');
  return r;
 });
 const local=rows.find(r=>r.node===worker.node);
 assert(local,'Validator does not belong to the reviewed roster.');
 const signer=key();assert.equal(signer.publicKey,local.signing.key);
 const endorse=(terms,roster)=>({key:signer.publicKey,signature:sign(validatorApprovalBody(terms,roster),signer.privateKey)});
 return {proposal:hash(body),approval:endorse(body,members),readiness:endorse(bondedReadyBody(body,next),next)};
}
export async function submitCutover(wallet,body,valid,request=requestRuleVote){
 const load=async()=>{
  assert(valid(),'Wallet session changed.');
  const {state}=await wallet.view();
  assert(cutoverOpen(state,wallet.client.config.chainId,wallet.key.publicKey),'The activation proposal is closed.');
  assert(state.height>=body.notBefore&&state.height<body.expires,'Review the new activation window.');
  return state;
 };
 assert.deepEqual(body,cutoverBody(body.notBefore));
 const state=await load(),members=state.authority.validators,next=normalizedVotingSet(members);
 const slots=Object.keys(state.workerFunding.accounts).filter(node=>state.workerFunding.accounts[node].owner===cutoverOwner&&
  state.money.nodes[node]?.consensusHeld==='100000000'&&state.rewards?.nodes[node]?.payouts?.some(p=>p.wallet===cutoverOwner));
 assert.equal(slots.length,10,'All ten original validator bonds must be ready.');
 const ready= bondedReadyBody(body,next),approvals=[],readiness=[];
 for(const node of slots.sort()){
  assert(valid(),'Wallet session changed.');
  const intent=consent(body,node);
  let reply;
  try{reply=await request(wallet,node,{operation:RULE_VOTE,cutoverStart:body.notBefore,intent,ownerSignature:sign(intent,wallet.key.privateKey)});}
  catch{continue;}
  assert.equal(reply.proposal,hash(body));
  assert.equal(reply.approval.key,reply.readiness.key);
  const member=members.find(v=>v.key===reply.approval.key);
  assert(member&&verify(validatorApprovalBody(body,members),reply.approval.signature,member.key)&&
   verify(validatorApprovalBody(ready,next),reply.readiness.signature,member.key),'Invalid validator approval.');
  if(!approvals.some(a=>a.key===member.key)){approvals.push(reply.approval);readiness.push(reply.readiness);}
  if(approvals.length>=7)break;
 }
 assert(approvals.length>=7,'Fewer than seven validators confirmed readiness. The certificate has not been submitted.');
 validatorQuorum(body,approvals,members);validatorQuorum(ready,readiness,next);
 await load();assert(valid(),'Wallet session changed.');
 const wire=envelope(wallet.client.config,{type:ENABLE_POS,certificate:{body,approvals,readiness}},wallet.key);
 await wallet.broadcast(wire);
 return {activation:body.activation,submitted:true};
}
