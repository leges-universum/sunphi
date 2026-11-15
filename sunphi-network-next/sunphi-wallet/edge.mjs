// Dedicated request runtime; Base44 only renders the authenticated account page.
import {SUNPHI_ORIGIN,SUNPHI_APP,validateLinkRequest,validateAccountConsent,validateLinkAction} from '../checkpoint-trial/sunphi-link.mjs';
import {hash,exact} from '../checkpoint-trial/crypto.mjs';
import {checkpointEvidence} from '../operator-registry/checkpoint-evidence.mjs';
import {paymentEvents} from './payment-events.mjs';
import {verifyApprovalRequest,verifyApprovalDecision} from '../checkpoint-trial/approval-transport.mjs';
import {indexedApprovalEvidence} from './indexed-approval.mjs';
import {indexedNotificationEvidence} from './indexed-notifications.mjs';
import {nodeAlertBridge} from './node-alert-bridge.mjs';
import {networkMonitor} from './network-monitor.mjs';
const need=(ok)=>{if(!ok)throw Error('request_not_verified');};
export function createWalletBridge({db,pins,fetcher=fetch,notifications=false,approvals=false,nodeAlerts=false,nodeServicesOnly=false,now=()=>Math.floor(Date.now()/1000)}){
 const rpc=(action,p)=>db('rpc/duebyte_wallet_link_v1',{method:'POST',body:JSON.stringify({p_action:action,p})});
 async function currentIdentity(req){
  const token=req.headers.get('authorization')??'';need(/^Bearer [A-Za-z0-9._~-]{20,8000}$/.test(token));
  const r=await fetcher(`${SUNPHI_ORIGIN}/api/apps/${SUNPHI_APP}/entities/User/me`,{headers:{Authorization:token},redirect:'error',signal:AbortSignal.timeout(10000)});need(r.ok);const user=await r.json();
  need(user.app_id===SUNPHI_APP&&typeof user.id==='string'&&/^[A-Za-z0-9_-]{10,80}$/.test(user.id)&&!user.disabled&&!user.is_service&&!user.force_password_reset);return user;
 }
 const currentUser=async req=>(await currentIdentity(req)).id;
 return async req=>{
  const origin=req.headers.get('origin'),headers={'Cache-Control':'no-store','Vary':'Origin','Access-Control-Allow-Origin':SUNPHI_ORIGIN,'Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Methods':'POST,OPTIONS'};
  const reply=(body,status=200)=>Response.json(body,{status,headers});
  if(origin&&origin!==SUNPHI_ORIGIN)return reply({error:'origin_denied'},403);
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers});if(req.method!=='POST')return reply({error:'method_not_allowed'},405);
  let stage='request';try{
   need(req.headers.get('content-type')?.startsWith('application/json'));let size=0;const chunks=[];for await(const c of req.body){size+=c.length;need(size<=1200000);chunks.push(c);}const data=new Uint8Array(size);let offset=0;for(const c of chunks){data.set(c,offset);offset+=c.length;}const q=JSON.parse(new TextDecoder().decode(data));
   const notificationRpc=(action,p)=>db('rpc/duebyte_payment_notifications_v1',{method:'POST',body:JSON.stringify({p_action:action,p})});
   const approvalRpc=(action,p)=>db('rpc/duebyte_approval_transport_v1',{method:'POST',body:JSON.stringify({p_action:action,p})});
   if(nodeServicesOnly)need(q.action?.startsWith('node_alert_')||q.action?.startsWith('network_monitor_'));
   if(q.action?.startsWith('node_alert_')){need(nodeAlerts);stage='verify_node_alert';return reply(await nodeAlertBridge(q,{db,pins,now:now()}));}
   if(q.action?.startsWith('network_monitor_')){need(nodeAlerts);stage='network_monitor';return reply(await networkMonitor(q,{db,pins,now:now(),identity:()=>currentIdentity(req)}));}
   if(q.action==='approval_open'){
    need(approvals);exact(q,['action','packet','checkpoint',...(q.proof?['proof']:['state'])]);
    let state=q.state;
    if(q.proof)state=await indexedApprovalEvidence(q.checkpoint,q.proof,q.packet,pins,now());
    else {need(!pins.indexedTransition);await checkpointEvidence(q.checkpoint,state,pins,null,now());}
    const context=verifyApprovalRequest(q.packet,state,pins,now());
    return reply(await approvalRpc('open',{context}));
   }
   if(q.action==='observe_payments'){
    need(notifications);exact(q,['action','checkpoint',...(q.proof?['proof']:['state'])]);stage='verify_payment_observation';
    const previous=(await db('duebyte_payment_observations?network=eq.'+encodeURIComponent(pins.root.network)+'&select=checkpoint'))[0];
    if(q.proof){
     const page=await indexedNotificationEvidence(q.checkpoint,q.proof,pins,previous?.checkpoint,now());
     const observed=await db('rpc/duebyte_indexed_payment_observe_v1',{method:'POST',body:JSON.stringify({p:{network:pins.root.network,checkpoint:q.checkpoint,...page}})});
     return reply({...observed,...await notificationRpc('deliver',{})});
    }
    need(!pins.indexedTransition);
    await checkpointEvidence(q.checkpoint,q.state,pins,previous?.checkpoint,now());
    const events=await paymentEvents(q.state,q.checkpoint);
    stage='store_payment_observation';const observed=await notificationRpc('observe',{network:pins.root.network,checkpoint:q.checkpoint,expected:previous?.checkpoint.body.sequence??0,events});
    stage='deliver_payment_events';return reply({...observed,...await notificationRpc('deliver',{})});
   }
   need(size<=20000);
   if(q.action==='approval_get'||q.action==='approval_decide'){
    need(approvals);exact(q,q.action==='approval_get'?['action','id']:['action','id','response']);need(/^[a-f0-9]{64}$/.test(q.id));
    const account=await currentUser(req),row=await approvalRpc('get_account',{id:q.id,account});
    if(q.action==='approval_get')return reply(row);
    need(!row.expired);verifyApprovalDecision(row.context,q.response);
    return reply(await approvalRpc('decide',{id:q.id,account,response:q.response}));
   }
   if(q.action==='approval_status'){
    need(approvals);exact(q,['action','packet']);const b=validateLinkAction(q.packet,q.action,pins.configHash,now());need(b.network===pins.root.network);
    return reply(await approvalRpc('get_wallet',{id:b.id,network:b.network,wallet:b.wallet}));
   }
   if(q.action==='payment_feed'||q.action==='payment_read'){
    need(notifications);exact(q,q.action==='payment_feed'?['action','before']:['action','last']);
    const account=await currentUser(req);
    if(q.action==='payment_feed'){need(q.before===null||(typeof q.before==='string'&&/^[a-f0-9-]{36}$/.test(q.before)));return reply(await notificationRpc('feed',{account,before:q.before}));}
    need(typeof q.last==='string'&&/^[a-f0-9-]{36}$/.test(q.last));return reply(await notificationRpc('read',{account,last:q.last}));
   }
   if(q.action==='claim'){
    exact(q,['action','id']);need(/^[a-f0-9]{64}$/.test(q.id));const account=await currentUser(req);return reply(await rpc('claim',{id:q.id,account}));
   }
   if(q.action==='start'){
    stage='verify_start';
    exact(q,['action','packet']);const b=validateLinkRequest(q.packet,pins.configHash,now());need(b.network===pins.root.network);
    stage='store_start';const result=await rpc('start',{id:b.nonce,network:b.network,wallet:b.wallet,expires:b.expires,request:q.packet,request_hash:hash(q.packet)});
    return reply({...result,accountUrl:`${SUNPHI_ORIGIN}/DueByteWalletLink?id=${b.nonce}`});
   }
   if(q.action==='commit'){
    exact(q,['action','request','consent']);const b=validateLinkRequest(q.request,pins.configHash,now());need(b.network===pins.root.network);
    const status=await rpc('status',{id:b.nonce,network:b.network,wallet:b.wallet});need(status.phase==='claimed'||status.phase==='linked');
    validateAccountConsent(q.consent,q.request,status.account_id,pins.configHash,now());
    return reply(await rpc('commit',{id:b.nonce,network:b.network,wallet:b.wallet,account:status.account_id,request_hash:hash(q.request),consent:q.consent}));
   }
   exact(q,['action','packet']);const b=validateLinkAction(q.packet,q.action,pins.configHash,now());need(b.network===pins.root.network);
   return reply(await rpc(q.action,{network:b.network,wallet:b.wallet,...('id'in b?{id:b.id}:{}),...('revision'in b?{revision:b.revision}:{}),...('notifications'in b?{notifications:b.notifications}:{})}));
  }catch(e){console.warn(JSON.stringify({event:'duebyte_wallet_request_rejected',stage,kind:e?.name??'Error',databaseStatus:e?.databaseStatus??null,databaseCode:e?.databaseCode??null}));return reply({error:'The request could not be verified. Refresh the connection and try again.'},400);}
 };
}
