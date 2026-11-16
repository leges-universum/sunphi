import assert from 'node:assert/strict';
import {exact,hash,hex,verify} from '../checkpoint-trial/crypto.mjs';
import {verifyNodeAlertConsent} from '../checkpoint-trial/node-alerts.mjs';
import {validateLinkAction} from '../checkpoint-trial/sunphi-link.mjs';
import {nodeAlertEvidence} from './node-alert-evidence.mjs';
export async function nodeAlertBridge(q,{db,pins,now}){
 const rpc=(action,p)=>db('rpc/duebyte_node_alerts_v1',{method:'POST',body:JSON.stringify({p_action:action,p})});
 if(['node_alert_status','node_alert_stop'].includes(q.action)){
  exact(q,['action','packet']);const b=validateLinkAction(q.packet,q.action,pins.configHash,now);assert.equal(b.network,pins.root.network);
  return rpc(q.action==='node_alert_stop'?'stop':'status',{network:b.network,node:b.node,wallet:b.wallet,revision:b.revision??0});
 }
 if(q.action==='node_alert_subscribe'){
  exact(q,['action','approval','evidence']);exact(q.approval,['request','managementSignature']);
  const b=verifyNodeAlertConsent(q.approval.request,pins,now);
  assert(verify(b,q.approval.managementSignature,b.management),'Server alert approval required.');
  const previous=(await db('duebyte_node_alert_observations?network=eq.'+encodeURIComponent(pins.root.network)+'&node=eq.'+b.node+'&select=checkpoint'))[0];
  const facts=await nodeAlertEvidence(q.evidence,b.node,pins,previous?.checkpoint,now);assert(facts.known&&facts.management===b.management,'Current server authority required.');
  return rpc('subscribe',{body:b,consent:q.approval,consentHash:hash(q.approval)});
 }
 assert.equal(q.action,'node_alert_observe');exact(q,['action','node','evidence']);hex(q.node);
 const previous=(await db('duebyte_node_alert_observations?network=eq.'+encodeURIComponent(pins.root.network)+'&node=eq.'+q.node+'&select=checkpoint'))[0];
 const facts=await nodeAlertEvidence(q.evidence,q.node,pins,previous?.checkpoint,now);
 if(!facts.known&&!previous)return {ok:true,known:false};
 const recorded=await rpc('observe',{facts,checkpoint:q.evidence.checkpoint,expected:previous?.checkpoint.body.sequence??0});
 return {...recorded,...await rpc('deliver',{})};
}
