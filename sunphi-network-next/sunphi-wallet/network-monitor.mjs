import assert from 'node:assert/strict';
import {hash,exact} from '../checkpoint-trial/crypto.mjs';
import {checkpointCertificate} from '../operator-registry/checkpoint-evidence.mjs';
import {verifyBoundedQuery} from '../checkpoint-trial/research/bounded-query.mjs';
import {verifyServiceAnchor} from './indexed-anchor.mjs';
export async function networkObservation(packet,pins,previous,now){
 exact(packet,['checkpoint','meta','workers','rewards']);const {checkpoint,meta,workers,rewards}=packet,t=pins.indexedTransition;
 assert(t&&t.network===pins.root.network&&t.configHash===pins.configHash);
 const maxAge=Math.min(900,pins.root.maxAge);
 const {policy,renewals}=await checkpointCertificate(checkpoint,pins,previous,now,{maxObservationAge:maxAge});
 assert(checkpoint.body.appHeight>=t.activationHeight);
 const v=verifyBoundedQuery(meta,{type:'wallet-meta',id:null},checkpoint.body.appHash,pins.configHash);
 assert.equal(v.height,checkpoint.body.appHeight);assert.equal(v.isolatedIssuance,false);
 const m=v.data;verifyServiceAnchor(m.anchor,t);
 assert.equal(hash(m.network.authority.policy),hash(policy));assert.equal(hash(m.network.authority.renewals),hash(renewals));
 const page=(proof,type)=>{const id=proof.request?.id;exact(id,['offset','limit']);assert(Number.isSafeInteger(id.offset)&&id.offset>=0);assert.equal(id.limit,8);const p=verifyBoundedQuery(proof,{type,id},checkpoint.body.appHash,pins.configHash);assert.equal(p.height,v.height);assert.equal(p.isolatedIssuance,false);return p.data;};
 const w=page(workers,'worker-page'),r=page(rewards,'reward-page');
 const stamp={height:v.height,root:checkpoint.body.appHash,issuedAt:checkpoint.body.issuedAt,unitScale:m.money.unitScale??'1'};
 // Keep only bounded, authenticated public accounting fields. No extra node queries.
 const workerRows=w.items.map(({id,value:n})=>({node:id,worker:{...stamp,stake:n.stake,consensusHeld:n.consensusHeld,taskHeld:n.taskHeld,free:String(BigInt(n.stake)-BigInt(n.consensusHeld)-BigInt(n.taskHeld))}}));
 const rewardRows=r.items.map(({id,value:n})=>({node:id,reward:{...stamp,kind:n.kind,earned:n.earned,paid:n.paid,pending:String(BigInt(n.earned)-BigInt(n.paid)),workerUnits:n.workerJobs,witnessUnits:n.witnessJobs,payoutCount:n.payouts.length}}));
 const accounting=m.network.rewards;
 return {network:pins.root.network,height:v.height,root:checkpoint.body.appHash,issuedAt:checkpoint.body.issuedAt,expiresAt:checkpoint.body.expiresAt,maxAge,
  policySigners:checkpoint.signatures.length,policyThreshold:policy.threshold,policyMembers:policy.members.length,logicalValidators:m.network.authority.validators.length,
  registeredWorkers:w.total,registeredRewardNodes:r.total,
  supply:m.money.supply,fees:m.money.fees,unitScale:m.money.unitScale??'1',workerIds:w.items.map(x=>x.id),workerNext:w.next,rewardNext:r.next,
  rewards:accounting?{collected:accounting.collected,minted:accounting.minted,carry:accounting.carry,periodFees:accounting.period.fees,workMeasure:accounting.coefficients.workMeasure??'legacy_jobs'}:null,
  workerRows,rewardRows};
}
export const NETWORK_ADMINS=new Set(['info.ua.lawyer@gmail.com','emailmevz@gmail.com','legesuniversum@gmail.com','2.000@ukr.net','zakrevskyivlad@gmail.com']);
export async function networkMonitor(q,{db,pins,now,identity}){
 if(q.action==='network_monitor_read'){
  exact(q,Object.hasOwn(q,'host_offset')?['action','offset','host_offset']:['action','offset']);assert(Number.isSafeInteger(q.offset)&&q.offset>=0&&q.offset<=100000);
  const hostOffset=q.host_offset??0;assert(Number.isSafeInteger(hostOffset)&&hostOffset>=0&&hostOffset<=100000);
  const user=await identity();assert(NETWORK_ADMINS.has(String(user.email??'').toLowerCase()),'Admin required');
  const network=encodeURIComponent(pins.root.network);
  const [latest,nodes,accounts,hosts]=await Promise.all([
   db('duebyte_network_monitor?network=eq.'+network+'&select=summary,observed_at,received_at,history&limit=1'),
   db('duebyte_node_alert_observations?network=eq.'+network+'&select=node,facts,observed_at&order=node.asc&limit=26&offset='+q.offset),
   db('duebyte_monitor_accounts?network=eq.'+network+'&select=node,worker,reward&order=node.asc&limit=26&offset='+q.offset),
   db('duebyte_host_monitors?network=eq.'+network+'&enabled=eq.true&select=host,label,sampled_at,received_at,report&order=host.asc&limit=26&offset='+hostOffset)]);
  return {server_time:new Date(now*1000).toISOString(),network:pins.root.network,latest:latest[0]??null,nodes:nodes.slice(0,25),has_more:nodes.length>25,accounts:accounts.slice(0,25),accounts_has_more:accounts.length>25,hosts:hosts.slice(0,25),hosts_has_more:hosts.length>25,host_offset:hostOffset};
 }
 assert.equal(q.action,'network_monitor_observe');exact(q,['action','packet']);
 const previous=(await db('duebyte_network_monitor?network=eq.'+encodeURIComponent(pins.root.network)+'&select=checkpoint&limit=1'))[0]?.checkpoint;
 const summary=await networkObservation(q.packet,pins,previous,now);
 return db('rpc/duebyte_network_observe_v1',{method:'POST',body:JSON.stringify({p:{summary,checkpoint:q.packet.checkpoint,expected:previous?.body.sequence??0}})});
}
