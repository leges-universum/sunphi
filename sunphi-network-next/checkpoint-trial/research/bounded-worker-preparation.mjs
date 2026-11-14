// Initial, unfunded payment workers. Registration grants neither collateral nor rewards.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer,publicKey,verify} from '../crypto.mjs';
import {validatorQuorum} from '../authority.mjs';
export const PREPARE_WORKERS='PREPARE_PAYMENT_WORKERS_V1';
export const WORKERS_DOMAIN='DUEBYTE_INITIAL_PAYMENT_WORKERS_V1';
export const paymentWorkerId=(configHash,key)=>hash({domain:WORKERS_DOMAIN,configHash,key});
export function prepareInitialWorkers(s,a,c,{anchor}){
 exact(a,['type','certificate','consents']);assert.equal(a.type,PREPARE_WORKERS);
 exact(a.certificate,['body','approvals']);const b=a.certificate.body;
 exact(b,['domain','network','configHash','generation','notBefore','expires','workers']);
 assert.equal(b.domain,WORKERS_DOMAIN);assert.equal(b.network,c.chainId);
 assert.equal(b.configHash,s.configHash);assert.equal(b.configHash,hash(c));
 assert.equal(b.generation,s.authority.generation);assert(!s.authority.pending,'validator transition pending');
 integer(b.notBefore,1);integer(b.expires,b.notBefore+1);
 assert(b.expires-b.notBefore<=600&&s.money.time>=b.notBefore&&s.money.time<b.expires,'worker UTC inclusion window');
 validatorQuorum(b,a.certificate.approvals,s.authority.validators);
 assert.equal(anchor.height,0);assert.equal(anchor.archive,null);assert.equal(anchor.issuance,false);
 assert.equal(c.initial.supply,'0');assert.equal(c.initial.fees,'0');
 for(const bucket of ['outputs','requests','nodes'])assert.deepEqual(c.initial[bucket],{});
 assert(s.networkReserves&&s.economicPreparation,'prepare custody and economic terms first');
 assert(!s.networkReserves.issued&&!s.rewards&&!s.centuryFees&&!s.centuryFunds&&!s.centurySubsidy&&!s.money.liability,'initial preparation only');
 assert.equal(s.money.supply,'0');assert.equal(s.money.fees,'0');
 assert.equal(s.economicPreparation.plan.issuanceEnabled,false);
 assert(Array.isArray(b.workers)&&b.workers.length>0&&b.workers.length<=64,'worker registration batch limit');
 assert(Array.isArray(a.consents)&&a.consents.length===b.workers.length,'worker possession consents');
 const access=s.networkReserves.development.access;
 assert(access&&!access.pending,'stable recovery custody required');
 const reserved=new Set([...s.authority.usedKeys,...s.authority.policy.members.map(m=>m.key),access.manager,...access.recovery.keys]);
 const ids=[],seenKeys=new Set(),records=[];
 for(let i=0;i<b.workers.length;i++){
  const w=b.workers[i],consent=a.consents[i];exact(w,['node','key','operator']);hex(w.node);hex(w.operator);publicKey(w.key);
  assert.equal(w.node,paymentWorkerId(s.configHash,w.key));assert(!seenKeys.has(w.key)&&!reserved.has(w.key),'separate work signing key');seenKeys.add(w.key);
  assert(i===0||ids[i-1]<w.node,'canonical unique worker order');ids.push(w.node);
  exact(consent,['node','signature']);assert.equal(consent.node,w.node);assert(verify(b,consent.signature,w.key),'worker possession');
  records.push({key:w.key,operator:w.operator,stake:'0',consensusHeld:'0',taskHeld:'0',tier:'0'});
 }
 // The wire bound is a batch size, not a cap on the network population.
 // Validate every existing record before adding anything; exact replay is safe.
 for(let i=0;i<ids.length;i++)if(s.money.nodes[ids[i]])assert.deepEqual(s.money.nodes[ids[i]],records[i],'initial worker changed');
 for(let i=0;i<ids.length;i++)if(!s.money.nodes[ids[i]])s.money.nodes[ids[i]]=records[i];
 return {state:s,workerIds:ids};
}
