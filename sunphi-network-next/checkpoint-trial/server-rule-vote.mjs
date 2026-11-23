import assert from 'node:assert/strict';
import {readFileSync,existsSync,writeFileSync,linkSync,unlinkSync,mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {exact,hash,hex,integer,publicKey,sign,verify} from './crypto.mjs';
import {validatorKey} from './local-validator-key.mjs';
import {validatorApprovalBody,verifyValidatorApprovals} from './validator-authority.mjs';
import {reviewRuleText} from './wallet-rule-review.mjs';

import {checkRuleGrant,RULE_ROUTE,RULE_VOTE} from './home-rule-route.mjs';
import {preparationPacket} from './bond-preparation-ballot.mjs';
import {mandateId} from './ordinary-issuance-ballot.mjs';
import {reserveMandateDomain} from './research/closed-network-reserve.mjs';

// The operator pairs a wallet on the server. The public RPC cannot create a
// grant, choose a signing domain or install a proposal. Revocation is immediate.
export function serveRuleVote(q,{grant,packet,state,network,worker,endorse}){
 checkRuleGrant(grant,state,network,worker.node);
 const id=hash(grant);
 if(q.operation===RULE_ROUTE){
  exact(q,['operation','node','owner']);assert.equal(q.node,grant.node);assert.equal(q.owner,grant.owner);
  const body={operation:RULE_ROUTE,grant,id};
  return {body,signature:sign(body,worker.privateKey)};
 }
 exact(q,['operation','intent','ownerSignature']);assert.equal(q.operation,RULE_VOTE);
 const i=q.intent;
 exact(i,['domain','network','configHash','node','controller','owner','grant','proposal','height','expiresHeight']);
 assert.equal(i.domain,RULE_VOTE);assert.equal(i.grant,id);assert.equal(i.proposal,hash(packet.body));
 assert.equal(packet.body.domain,grant.domain,'Permission does not cover this domain');
 for(const name of ['network','configHash','node','controller','owner'])assert.equal(i[name],grant[name]);
 integer(i.height,1);integer(i.expiresHeight,i.height);assert(i.expiresHeight-i.height<=12);
 assert(state.height>=i.height&&state.height<=i.expiresHeight,'Vote request expired');
 assert(verify(i,q.ownerSignature,grant.owner),'Wallet authorization required');
 const review=reviewRuleText(packet,state,network,grant.controller);
 assert(!review.expired,'Proposal has closed');
 let approval=packet.approvals.find(a=>a.key===grant.controller);
 if(!approval){
  assert(review.canSign,'Proposal already reached quorum');
  approval={key:grant.controller,signature:endorse(validatorApprovalBody(packet.body,state.authority.validators))};
 }
 verifyValidatorApprovals(packet.body,[approval],state.authority.validators);
 return {proposal:i.proposal,approval};
}

export function localRuleVote(q,{home,state,network,worker,payouts}){
 const read=file=>JSON.parse(readFileSync(file,'utf8'));
 const directory=join(home,'home-governance');
 assert(Array.isArray(payouts)&&payouts.length===1&&payouts[0].weight===1,'An exclusive verified payout link is required');
 const owner=payouts[0].wallet;publicKey(owner);
 let grant,packet;
 if(Object.hasOwn(q,'reserveMandate')){
  const {reserveMandate,...rest}=q;q=rest;
  const digest=hex(reserveMandate);
  grant=read(join(directory,digest+'.grant.json'));
  assert(reserveMandateDomain(grant.domain));assert.equal(grant.proposal,digest);
 }else if(Object.hasOwn(q,'issuanceMandate')){
  const {issuanceMandate,...rest}=q;q=rest;assert.equal(issuanceMandate,mandateId);
  grant=read(join(directory,mandateId+'.grant.json'));
  assert.equal(grant.domain,'SEAL_ORDINARY_EMISSION_CURVE_V1');assert.equal(grant.proposal,mandateId);
 }else if(Object.hasOwn(q,'preparationStart')){
  const {preparationStart,...rest}=q;q=rest;
  assert.equal(q.operation===RULE_ROUTE?q.owner:q.intent?.owner,owner,'Current operator wallet link required');
  const pub=read(join(home,'config/priv_validator_key.json')).pub_key;
  assert.equal(pub.type,'tendermint/PubKeyEd25519');
  const controller=Buffer.from(pub.value,'base64').toString('base64url');publicKey(controller);
  const identity={network,configHash:state.configHash,node:worker.node,controller,owner};
  packet=preparationPacket(state,network,preparationStart);
  grant={...identity,generation:state.authority.generation,domain:packet.body.domain,expiresHeight:packet.body.expires,
   proposal:hash(packet.body),nonce:hash({identity,proposal:hash(packet.body),generation:state.authority.generation})};
 }else grant=read(join(directory,'operator.json'));
 assert.equal(grant.owner,owner,'Current operator wallet link required');
 // No network-controlled path components other than a validated digest.
 const proposal=q.operation===RULE_VOTE?hex(q.intent.proposal):null;
 if(proposal!==null)assert.equal(proposal,grant.proposal,'Proposal outside this pairing');
 packet??=proposal?read(join(directory,proposal+'.json')):null;
 const receipt=proposal?join(directory,proposal+'.endorsement.json'):null;
 if(receipt&&existsSync(receipt)){
  const previous=read(receipt);assert.equal(previous.key,grant.controller);
  if(!packet.approvals.some(a=>a.key===previous.key))packet.approvals.push(previous);
 }
 const reply=serveRuleVote(q,{grant,packet,state,network,worker,endorse:body=>{
  const key=validatorKey(home);assert.equal(key.publicKey,grant.controller);
  return sign(body,key.privateKey);
 }});
 if(receipt&&!existsSync(receipt)){
  mkdirSync(directory,{recursive:true,mode:0o700});
  const tmp=receipt+'.'+randomUUID();
  writeFileSync(tmp,JSON.stringify(reply.approval),{flag:'wx',mode:0o600,flush:true});
  try{linkSync(tmp,receipt);}catch(e){if(e.code!=='EEXIST')throw e;assert.deepEqual(read(receipt),reply.approval);}
  finally{unlinkSync(tmp);}
 }
 return reply;
}
