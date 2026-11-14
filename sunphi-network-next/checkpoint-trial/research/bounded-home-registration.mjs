// Indexed Home enrollment. Possession and network authorization are separate;
// enrollment itself grants neither a subsidy nor validator voting power.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {exact,hash,hex,integer,publicKey,verify} from '../crypto.mjs';
import {validatorQuorum} from '../authority.mjs';
import {developmentManager} from '../reserve-recovery.mjs';
import {rewardNodeId} from '../node-rewards.mjs';
import {changeRadix,radixCount,radixIds} from './bounded-radix-index.mjs';
export const REGISTER_HOMES='REGISTER_HOME_KEYS_V1',HOME_REGISTRY='DUEBYTE_HOME_REGISTRY_V1';
export const homePeer=key=>createHash('sha256').update(Buffer.from(key,'base64url')).digest('hex').slice(0,40);
export const homeRegistrationKey=id=>'home-registration/nodes/'+hex(id);
export const homePeerKey=peer=>{assert(/^[a-f0-9]{40}$/.test(peer));return 'home-registration/peers/'+peer;};
export const homeRegistrationCount=get=>radixCount(get,'home-registration/index');
export const homeRegistrationIds=(get,options)=>radixIds(get,'home-registration/index',options);
export function validateHomeAuthorization(s,certificate,founderConsent,c){
 exact(certificate,['body','approvals']);const b=certificate.body;
 exact(b,['domain','network','configHash','generation','managementEpoch','notBefore','expires','homes']);
 assert.equal(b.domain,REGISTER_HOMES);assert.equal(b.network,c.chainId);assert.equal(b.configHash,hash(c));assert.equal(b.configHash,s.configHash);assert.equal(b.generation,s.authority.generation);
 const access=s.networkReserves?.development?.access;assert(s.centuryFees&&s.rewards&&access&&!access.pending&&!s.authority.pending,'stable prepared Home registration required');assert.equal(b.managementEpoch,access.epoch);
 integer(b.notBefore,1);integer(b.expires,b.notBefore+1);assert(b.expires-b.notBefore<=600&&s.money.time>=b.notBefore&&s.money.time<b.expires,'Home UTC inclusion window');
 validatorQuorum(b,certificate.approvals,s.authority.validators);assert(verify(b,founderConsent,developmentManager(s.networkReserves)),'founder Home consent');
 assert(Array.isArray(b.homes)&&b.homes.length>0&&b.homes.length<=32,'Home registration batch');return b;
}
export function registerHomeKeys(s,a,c,tx){
 exact(a,['type','certificate','founderConsent','consents']);assert.equal(a.type,REGISTER_HOMES);const b=validateHomeAuthorization(s,a.certificate,a.founderConsent,c);
 assert(Array.isArray(a.consents)&&a.consents.length===b.homes.length);
 let last='';const peers=new Set(),edits=[];
 for(let i=0;i<b.homes.length;i++){
  const h=b.homes[i],proof=a.consents[i];exact(h,['node','identity','work','management']);hex(h.node);assert(h.node>last,'canonical unique Home order');last=h.node;
  for(const key of [h.identity,h.work,h.management])publicKey(key);assert.equal(new Set([h.identity,h.work,h.management]).size,3,'separate Home keys');assert.equal(h.node,rewardNodeId(s.configHash,h.work));
  exact(proof,['identity','work','management']);for(const key of ['identity','work','management'])assert(verify(b,proof[key],h[key]),'Home key possession');
  const peer=homePeer(h.identity);assert(!peers.has(peer),'duplicate Home installation');peers.add(peer);
  const old=tx.get(homeRegistrationKey(h.node)),mapped=tx.get(homePeerKey(peer)),legacy=s.rewards.enrolled[peer],account=s.rewards.nodes[h.node];
  if(old){assert.deepEqual(old,h,'Home registration changed');assert.equal(mapped?.node,h.node);assert(account?.kind==='witness'&&account.key===h.work);continue;}
  assert(!mapped&&!legacy&&!account,'Home identity already registered');edits.push([h,peer]);
 }
 for(const [h,peer]of edits){tx.set(homeRegistrationKey(h.node),h);tx.set(homePeerKey(peer),{node:h.node});changeRadix(tx,'home-registration/index',h.node,true);s.rewards.nodes[h.node]={key:h.work,management:h.management,kind:'witness',payouts:[],sequence:0,earned:'0',paid:'0',workerJobs:'0',witnessJobs:'0'};}
 s.rewards.homeRegistry={version:HOME_REGISTRY,count:homeRegistrationCount(tx.get)};return s;
}
export function auditHomeRegistration(records,s){
 const rows=[...records].filter(([k])=>k.startsWith('home-registration/')),marker=s.rewards?.homeRegistry;
 if(!marker){assert.equal(rows.length,0);return;}exact(marker,['version','count']);assert.equal(marker.version,HOME_REGISTRY);integer(marker.count,1);
 const expected=new Map(),tx={get:k=>expected.get(k),set:(k,v)=>expected.set(k,v),delete:k=>expected.delete(k)};let count=0;
 for(const [key,h]of rows)if(key.startsWith('home-registration/nodes/')){
  exact(h,['node','identity','work','management']);assert.equal(key,homeRegistrationKey(h.node));assert.equal(h.node,rewardNodeId(s.configHash,h.work));for(const k of [h.identity,h.work,h.management])publicKey(k);assert.equal(new Set([h.identity,h.work,h.management]).size,3);
  const peer=homePeer(h.identity),pk=homePeerKey(peer);assert(!expected.has(pk)&&!s.rewards.enrolled[peer],'duplicate Home installation');assert(s.rewards.nodes[h.node]?.kind==='witness'&&s.rewards.nodes[h.node].key===h.work);
  expected.set(key,h);expected.set(pk,{node:h.node});changeRadix(tx,'home-registration/index',h.node,true);count++;
 }
 assert.equal(marker.count,count);const sorted=m=>[...m].sort(([a],[b])=>a<b?-1:a>b?1:0);assert.deepEqual(sorted(expected),sorted(rows),'Home registry/index mismatch');
}
