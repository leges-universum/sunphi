import assert from 'node:assert/strict';
import {exact,hash,hex,integer,publicKey,verify} from '../crypto.mjs';
import {validatorQuorum} from '../validator-authority.mjs';
import {ensureRewardWorker,rewardsEnabled,REWARDS,applyRewardAction} from '../node-rewards.mjs';
import {paymentWorkerId} from './bounded-worker-preparation.mjs';

export const OPEN_SERVER_ENROLLMENT='OPEN_SERVER_REWARD_ENROLLMENT_V1';
export const REGISTER_SERVER='REGISTER_SERVER_REWARD_ACCOUNT_V1';
export const ENROLLMENT_HEAD='server-enrollment/head';
export const NOMINATE_RECIPIENT='NOMINATE_SERVER_REWARD_RECIPIENT_V1';
export const ACCEPT_RECIPIENT='ACCEPT_SERVER_REWARD_RECIPIENT_V1';
export const RENEW_ENROLLMENT='RENEW_SERVER_REWARD_ENROLLMENT_V1';
export function checkEnrollmentRenewal(terms){
 exact(terms,['previous','blocks','limit']);
 hex(terms.previous);integer(terms.blocks,1);integer(terms.limit,1);
 assert(terms.blocks<=10001 && terms.limit<=1024,'Registration window bounds.');
}
export function renewReviewedEnrollment(s,config,terms,tx){
 checkEnrollmentRenewal(terms);
 const head=tx.get(ENROLLMENT_HEAD);
 assert(head && head.id===terms.previous,'Registration policy has changed.');
 assert(rewardsEnabled(s) && s.rewards && !s.authority.pending,'Registration authority is unavailable.');
 assert(s.height>head.policy.expires || head.count===head.policy.limit,'The current registration window still has space.');
 const policy={domain:OPEN_SERVER_ENROLLMENT,network:config.chainId,configHash:s.configHash,
  generation:s.authority.generation,sequence:head.policy.sequence+1,notBefore:s.height,
  expires:s.height+terms.blocks-1,limit:terms.limit};
 tx.set(ENROLLMENT_HEAD,{policy,id:hash(policy),count:0});
 return s;
}
export const offerKey=id=>'server-enrollment/recipient/'+hex(id);
export const initialPayout=(configHash,node,wallet,sequence)=>({domain:REWARDS+'/BIND',configHash,node,sequence,payouts:[{wallet,weight:1}]});
export function auditServerRegistration(records,s,config){
 const head=records.get(ENROLLMENT_HEAD);
 if(head){
  exact(head,['policy','id','count']);const b=head.policy;
  exact(b,['domain','network','configHash','generation','sequence','notBefore','expires','limit']);
  assert.equal(head.id,hash(b));assert.equal(b.network,config.chainId);assert.equal(b.configHash,s.configHash);assert.equal(b.domain,OPEN_SERVER_ENROLLMENT);
  integer(b.sequence,1);integer(b.generation);integer(b.notBefore,1);integer(b.expires,b.notBefore);integer(b.limit,1);integer(head.count);
  assert(b.expires-b.notBefore<=10000&&b.limit<=1024&&head.count<=b.limit);
 }
 for(const [key,offer] of records){
  if(!key.startsWith('server-enrollment/recipient/'))continue;
  const id=key.slice('server-enrollment/recipient/'.length);hex(id);assert(s.rewards?.nodes[id]?.kind==='worker');
  exact(offer,['wallet','management','sequence','previous','signature']);publicKey(offer.wallet);integer(offer.sequence,1);
  if(offer.previous!==null)hex(offer.previous);
  assert(verify(initialPayout(s.configHash,id,offer.wallet,offer.sequence),offer.signature,offer.management));
 }
}
export function serverRecipient(s,a,author,c,tx,context){
 assert(tx.get(ENROLLMENT_HEAD),'Server reward pairing has not been activated.');
 hex(a.node);const account=s.rewards?.nodes[a.node],key=offerKey(a.node);
 assert(rewardsEnabled(s)&&account?.kind==='worker'&&account.payouts.length===0,'An unbound registered server is required.');
 if(a.type===NOMINATE_RECIPIENT){
  exact(a,['type','node','wallet','sequence','previous','signature']);publicKey(a.wallet);
  assert.equal(author,account.management);assert.equal(a.sequence,account.sequence+1);
  const body=initialPayout(s.configHash,a.node,a.wallet,a.sequence);
  assert(verify(body,a.signature,author),'Server approval is invalid.');
  const old=tx.get(key);
  assert.equal(a.previous,old?hash(old):null,'The server invitation has changed.');
  tx.set(key,{wallet:a.wallet,management:author,sequence:a.sequence,previous:a.previous,signature:a.signature});return s;
 }
 exact(a,['type','node','sequence','consent']);assert.equal(a.type,ACCEPT_RECIPIENT);
 const offer=tx.get(key);assert(offer&&offer.wallet===author&&offer.management===account.management,'A matching server invitation is required.');
 assert.equal(offer.sequence,a.sequence);assert.equal(a.sequence,account.sequence+1);
 const bind={type:'BIND_REWARD_WALLETS_V1',body:initialPayout(s.configHash,a.node,author,a.sequence),signature:offer.signature,consents:[a.consent]};
 const next=applyRewardAction(s,bind,account.management,c,context);tx.delete(key);return next;
}

// A quorum authorizes a bounded public window once. Work selection, funding
// and consensus membership retain their separate existing authorization paths.
export function serverRewardRegistration(s,action,author,config,tx){
 const head=tx.get(ENROLLMENT_HEAD);
 assert(rewardsEnabled(s)&&s.rewards,'Server rewards are not active.');
 if(action.type===OPEN_SERVER_ENROLLMENT){
  exact(action,['type','body','approvals']);const b=action.body;
  exact(b,['domain','network','configHash','generation','sequence','notBefore','expires','limit']);
  assert.equal(b.domain,OPEN_SERVER_ENROLLMENT);assert.equal(b.network,config.chainId);
  assert.equal(b.configHash,s.configHash);assert.equal(b.generation,s.authority.generation);
  assert(!s.authority.pending,'Validator transition pending.');
  integer(b.sequence,1);assert.equal(b.sequence,(head?.policy.sequence??0)+1);
  integer(b.notBefore,1);integer(b.expires,b.notBefore);integer(b.limit,1);
  assert(s.height>=b.notBefore&&s.height<=b.expires&&b.expires-b.notBefore<=10000&&b.limit<=1024,'Registration window bounds.');
  validatorQuorum(b,action.approvals,s.authority.validators);
  tx.set(ENROLLMENT_HEAD,{policy:b,id:hash(b),count:0});return s;
 }
 assert.equal(action.type,REGISTER_SERVER);exact(action,['type','window']);
 hex(action.window);publicKey(author);
 assert(head,'No active registration window.');
 const id=paymentWorkerId(s.configHash,author),existing=s.money.nodes[id];
 if(existing){assert.equal(existing.key,author);ensureRewardWorker(s,id);return s;}
 assert(head&&head.id===action.window&&head.policy.generation===s.authority.generation&&!s.authority.pending,'No active registration window.');
 assert(s.height>=head.policy.notBefore&&s.height<=head.policy.expires&&head.count<head.policy.limit,'Registration window closed.');
 const access=s.networkReserves?.development?.access;
 assert(![...(s.authority.usedKeys??[]),...(s.authority.policy?.members??[]).map(v=>v.key),access?.manager,...(access?.recovery?.keys??[])].includes(author),'Use a dedicated work key.');
 assert(!s.rewards.nodes[id],'Reward identity already exists.');
 s.money.nodes[id]={key:author,operator:hash(['DUEBYTE_SERVER_OPERATOR_V1',author]),stake:'0',consensusHeld:'0',taskHeld:'0',tier:'0'};
 ensureRewardWorker(s,id);tx.set(ENROLLMENT_HEAD,{...head,count:head.count+1});return s;
}
