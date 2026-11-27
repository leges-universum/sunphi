import assert from 'node:assert/strict';
import {exact, hash, sign, verify} from './crypto.mjs';
import {bondBody, bondedAdmissionPolicy, checkBondRequest, validateBondTemplate} from './bond-request.mjs';
import {consentedVotingHold, preparedVotingMinimum} from './worker-collateral.mjs';
import {spendPolicy} from './spend-protection.mjs';

export const enrollmentRoute='DUEBYTE_VALIDATOR_ENROLLMENT_V1';
export const enrollmentPolicy=hash(bondedAdmissionPolicy);

// The worker attests its local consensus identity. The owner only signs the
// pinned network, node, validator, current minimum and approved penalty terms.
export function enrollmentReply(request,{state,network,worker,validator,binding}) {
  const {node,owner}=request;
  assert.equal(request.operation,enrollmentRoute);
  assert.equal(node,worker.node);
  assert.equal(state.money.nodes[node]?.key,worker.publicKey);
  const payouts=state.rewards?.nodes?.[node]?.payouts;
  assert(payouts?.length===1 && payouts[0].wallet===owner && payouts[0].weight===1,'Server wallet link changed.');
  const account=state.workerFunding?.accounts[node];
  assert(!account || account.owner===owner,'Server collateral owner changed.');
  const bond=preparedVotingMinimum(state);
  assert(bond,'Validator bond preparation is unavailable.');
  const template={network,configHash:state.configHash,node,validator:validator.publicKey,workerKey:worker.publicKey,
    owner,bond,policyHash:enrollmentPolicy};
  validateBondTemplate(template);
  if(request.phase==='offer'){
    exact(request,['operation','phase','node','owner']);
    const body={operation:enrollmentRoute,template,bound:Boolean(binding)};
    return {body,signature:sign(body,worker.privateKey)};
  }
  exact(request,['operation','phase','node','owner','packet']);
  assert.equal(request.phase,'bind');
  const {packet}=request;
  assert.deepEqual(packet.template,template,'Validator bond terms changed.');
  checkBondRequest(packet,state.money.time,['owner']);
  assert(!binding,'Validator bond already recorded.');
  const protection=spendPolicy(state,owner);
  assert(!protection?.enabled&&!protection?.pending,'Additional spending approval is required.');
  consentedVotingHold(state,node,bond);
  return {...packet,workerSignature:sign(packet.body,worker.privateKey),validatorSignature:sign(packet.body,validator.privateKey)};
}

export function verifyEnrollmentOffer(reply,state,node,owner,network){
  const worker=state.money.nodes[node];
  const b=reply.body;
  exact(b,['operation','template','bound']);
  assert.equal(b.operation,enrollmentRoute);
  assert.equal(typeof b.bound,'boolean');
  assert(verify(b,reply.signature,worker.key),'Unverified validator identity.');
  const t=b.template;
  validateBondTemplate(t);
  assert.deepEqual(t,{network,configHash:state.configHash,node,owner,workerKey:worker.key,validator:t.validator,
    policyHash:enrollmentPolicy,bond:preparedVotingMinimum(state)},'Validator terms do not match the verified network.');
  return b;
}

export function signEnrollment(template,time,key){
  assert.equal(key.publicKey,template.owner);
  const body=bondBody(template,time,time+600);
  return {template,body,ownerSignature:sign(body,key.privateKey)};
}
