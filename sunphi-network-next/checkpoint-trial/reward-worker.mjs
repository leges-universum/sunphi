// A bounded background role, independent of wallet unlock/spending authority.
import assert from 'node:assert/strict';
import {dirname} from 'node:path';
import {hash,sign} from './crypto.mjs';
import {envelope,stateHash} from './core.mjs';
import {snapshot,rpc} from './client.mjs';
import {REWARDS,rewardSummary} from './node-rewards.mjs';
import {walletRewardIdentity,registrationAction} from './reward-identity.mjs';

import {availabilityBody} from './funded-reward-work.mjs';
import {centuryHomeBody,CENTURY_HOME_ACTION} from './century-home.mjs';

export class RewardWorker{
 constructor({home,config,store,url,historyUrl,snapshotReader=snapshot,broadcast}){
  Object.assign(this,{home,config,store,url,historyUrl,snapshotReader});this.identity=walletRewardIdentity(home,config.chainId);if(this.identity)assert.equal(this.identity.configHash,hash(config));
  this.broadcast=broadcast??(async wire=>{try{const r=await rpc(url,'broadcast_tx_sync',{tx:Buffer.from(JSON.stringify(wire)).toString('base64')});assert.equal(r.code,0,'Reward submission is awaiting network acceptance.');}catch(e){if(!e.message.includes('tx already exists in cache'))throw e;}});
 }
 async submit(id,action,key){
  const db=this.store.db;let row=db.prepare('SELECT body FROM reward_outbox WHERE id=?').get(id);
  if(!row){const wire=envelope(this.config,action,key);db.prepare('INSERT INTO reward_outbox VALUES(?,?)').run(id,JSON.stringify(wire));row={body:JSON.stringify(wire)};}
  await this.broadcast(JSON.parse(row.body));
 }
 async tick(view){
  const identity=this.identity;if(!identity)return null;
  const s=view.state;assert.equal(stateHash(s,this.config),view.certificate.appHash);assert.equal(s.height,view.certificate.appHeight);
  const result={...rewardSummary(s,identity.node),wallets:this.store.rewardWallets(),selectionPending:false,message:null};
  if(!s.rewards){result.message='Rewards are awaiting network activation.';return result;}
  const n=s.rewards.nodes[identity.node];
  if(!n){
   try{await this.submit('registration',registrationAction(dirname(this.home),identity),identity.work);result.message='Registering this node for reward assignments.';}catch{result.message='This node is awaiting admission to paid work. Saved data is retained.';}
   return result;
  }
  this.store.db.prepare('DELETE FROM reward_outbox WHERE id=?').run('registration');
  const selected=result.wallets.filter(w=>w.rewardsSelected),needsConsent=selected.some(w=>!w.rewardsReady);
  const wallets=selected.filter(w=>w.rewardsReady).sort((a,b)=>a.owner.localeCompare(b.owner));
  const payouts=wallets.map(w=>({wallet:w.owner,weight:1}));
  if(!needsConsent&&payouts.length&&hash(payouts)!==hash(n.payouts)){
   result.selectionPending=true;const body={domain:REWARDS+'/BIND',configHash:s.configHash,node:identity.node,sequence:n.sequence+1,payouts};
   const consents=wallets.map(w=>JSON.parse(this.store.db.prepare('SELECT body FROM reward_consents WHERE wallet=?').get(w.owner).body).signature);
   await this.submit('binding:'+body.sequence,{type:'BIND_REWARD_WALLETS_V1',body,signature:sign(body,identity.management.privateKey),consents},identity.management);
  }
  // Only confirmed binding sequences may leave the local retry outbox.
  for(const row of this.store.db.prepare('SELECT id FROM reward_outbox').all())if(row.id.startsWith('binding:')&&Number(row.id.slice(8))<=n.sequence)this.store.db.prepare('DELETE FROM reward_outbox WHERE id=?').run(row.id);
  const period=s.rewards.period;
  if(!s.centuryFees&&!s.rewards.fundedWork?.serviceContract&&period.assigned.includes(identity.node)&&!period.witnesses.includes(identity.node)){
   let anchor;try{anchor=await this.snapshotReader(this.historyUrl,period.anchor.height);}catch(e){if(this.historyUrl===this.url)throw e;anchor=await this.snapshotReader(this.url,period.anchor.height);}
   assert.equal(anchor.height,period.anchor.height);assert.equal(stateHash(anchor,this.config),period.anchor.stateHash,'assigned history differs');
   const body={domain:REWARDS+'/WITNESS',configHash:s.configHash,node:identity.node,period:period.index,...period.anchor};
   await this.submit('witness:'+period.index,{type:'REWARD_WITNESS_V1',body,signature:sign(body,identity.work.privateKey)},identity.work);
  }
  for(const row of this.store.db.prepare('SELECT id FROM reward_outbox').all())if(row.id.startsWith('witness:')&&(Number(row.id.slice(8))<period.index||(Number(row.id.slice(8))===period.index&&period.witnesses.includes(identity.node))))this.store.db.prepare('DELETE FROM reward_outbox WHERE id=?').run(row.id);
  const funded=s.rewards.fundedWork;
  const century=s.centurySubsidy,h=century?.pending?.home,j=h?.jobs[identity.node];
  if(j?.status==='assigned'&&s.money.time<=h.sample.deadline){
   const target=h.sample.anchor;let anchor;
   try{anchor=await this.snapshotReader(this.historyUrl,target.height);}catch(e){if(this.historyUrl===this.url)throw e;anchor=await this.snapshotReader(this.url,target.height);}
   assert.equal(anchor.height,target.height);assert.equal(stateHash(anchor,this.config),target.stateHash,'century home history differs');
   const body=centuryHomeBody(s,identity.node);
   await this.submit('century-home:'+century.sequence,{type:CENTURY_HOME_ACTION,body,signature:sign(body,identity.work.privateKey)},identity.work);
  }
  for(const row of this.store.db.prepare('SELECT id FROM reward_outbox').all())if(row.id.startsWith('century-home:')){
   const sequence=Number(row.id.slice('century-home:'.length));
   if(!century?.pending||sequence<century.sequence||j?.status!=='assigned'||s.money.time>h.sample.deadline)this.store.db.prepare('DELETE FROM reward_outbox WHERE id=?').run(row.id);
  }
  if(funded){
   // One explicitly funded verification per tick; never scan remote history or
   // manufacture jobs simply because this installation exists.
   const entry=Object.entries(funded.book.jobs).filter(([,j])=>j.request.node===identity.node&&j.status==='assigned'&&s.money.time<=j.request.deadline).sort(([a],[b])=>a.localeCompare(b))[0];
   if(entry){
    const [id,j]=entry,target=funded.targets[id];assert.equal(j.request.kind,'checkpoint','unsupported home work class');
    let anchor;try{anchor=await this.snapshotReader(this.historyUrl,target.height);}catch(e){if(this.historyUrl===this.url)throw e;anchor=await this.snapshotReader(this.url,target.height);}
    assert.equal(anchor.height,target.height);assert.equal(stateHash(anchor,this.config),target.stateHash,'funded history differs');
    const body=funded.serviceContract?availabilityBody(s,id):{domain:'DUEBYTE_FUNDED_WORK_V1/COMPLETE',configHash:s.configHash,assignment:id,result:hash(target)};
    const type=funded.serviceContract?'COMPLETE_REWARD_AVAILABILITY_V1':'COMPLETE_REWARD_WORK_V1';
    await this.submit('funded:'+funded.book.policy.version+':'+id,{type,body,signature:sign(body,identity.work.privateKey)},identity.work);
   }
   for(const row of this.store.db.prepare('SELECT id FROM reward_outbox').all())if(row.id.startsWith('funded:')){
    const [,version,id]=row.id.split(':');if(Number(version)<funded.book.policy.version||(Number(version)===funded.book.policy.version&&funded.book.jobs[id]?.status!=='assigned'))this.store.db.prepare('DELETE FROM reward_outbox WHERE id=?').run(row.id);
   }
  }
  result.message=needsConsent?'Open each selected wallet once to verify its reward consent. The current network payout selection remains in effect.':!payouts.length?'Earnings are saved for this node. Create or open a wallet to receive them.':result.selectionPending?'Saving your reward wallet selection…':'Rewards are distributed automatically to your selected wallets.';
  return result;
 }
}
