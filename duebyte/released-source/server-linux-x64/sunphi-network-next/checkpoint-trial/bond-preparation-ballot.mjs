import assert from 'node:assert/strict';
import {exact,hash,integer} from './crypto.mjs';
import {bondedAdmissionPolicy} from './bond-request.mjs';
import {verifyValidatorApprovals} from './validator-authority.mjs';

export const PREPARE_TYPE='PREPARE_POS_SLASHING_V1';
export const PREPARE_DOMAIN='DUEBYTE_POS_POLICY_V1/'+PREPARE_TYPE;
export function preparationPacket(state,network,start=1+80*Math.floor((state.height-1)/80)){
 integer(start,1);assert.equal((start-1)%80,0);assert(start<=state.height+1&&state.height<start+100,'Preparation window closed');
 const body={domain:PREPARE_DOMAIN,network,configHash:state.configHash,generation:state.authority.generation,
  notBefore:start,expires:start+100,policy:bondedAdmissionPolicy};
 return {body,document:preparationDocument(body),approvals:[]};
}
export function preparationDocument(body){
 return ['Prepare owner-funded validator bonds. This certificate opens the preparation phase.',
  'The initial voting bond is 100 DUBYT. A separate activation certificate is required for penalties and voting.',
  'Network '+body.network,'Configuration '+body.configHash,'Financial registry generation '+body.generation,
  'Inclusion window: blocks '+body.notBefore+' through '+body.expires,
  'Policy SHA-256 '+hash(body.policy),'Approved rule '+body.policy.ballot,JSON.stringify(body.policy,null,2)].join('\n');
}
export function reviewPreparation(packet,state,network,signer){
 exact(packet,['body','document','approvals']);const b=packet.body,a=state.authority;
 exact(b,['domain','network','configHash','generation','notBefore','expires','policy']);
 assert.equal(b.domain,PREPARE_DOMAIN);assert.equal(b.network,network);assert.equal(b.configHash,state.configHash);
 assert(a?.version===2&&a.generation===b.generation,'Financial registry changed');
 assert.deepEqual(b.policy,bondedAdmissionPolicy,'Unrecognized collateral or penalty terms');
 assert.equal(packet.document,preparationDocument(b),'Displayed terms differ from the certificate');
 integer(b.notBefore,1);integer(b.expires,b.notBefore);assert(b.expires-b.notBefore<=100);
 const tally=verifyValidatorApprovals(b,packet.approvals,a.validators);
 const member=a.validators.some(v=>v.key===signer),voted=packet.approvals.some(v=>v.key===signer);
 const approved=tally.power>=tally.threshold,expired=state.height>=b.expires;
 const open=state.height+1>=b.notBefore&&!a.posSlashing&&!a.rotatingSeat&&!a.archiveVoting&&!a.pending&&!a.posNext;
 return {proposal:hash(b),document:packet.document,network,height:state.height,closesAt:b.expires,
  weight:String(tally.power),required:String(tally.threshold),approved,expired,member,voted,
  kind:'preparation',canSign:open&&member&&!voted&&!approved&&!expired,canSubmit:open&&approved&&!expired};
}
