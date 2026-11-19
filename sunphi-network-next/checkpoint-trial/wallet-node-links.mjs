// This wallet flow prepares two-sided instructions; it never broadcasts them.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {exact,hash,hex,sign} from './crypto.mjs';
import {walletConsent} from './node-rewards.mjs';
import {envelope} from './core.mjs';
import {WalletCollateral} from './wallet-collateral.mjs';
import {prepareNodeLink,pairingCode,applyNodeLink} from './node-wallet-link.mjs';
import {nodeWalletStatus} from './node-link-state.mjs';
import {walletCollateralSummary} from './wallet-collateral-status.mjs';
export function walletNodeOverview(s,owner){
 const nodes=[...new Set([...Object.keys(s.rewards?.nodes??{}),...Object.keys(s.workerFunding?.accounts??{})])].filter(id=>s.rewards?.nodes[id]?.management===owner||s.rewards?.nodes[id]?.payouts.some(p=>p.wallet===owner)||s.workerFunding?.accounts[id]?.owner===owner).map(id=>nodeWalletStatus(s,id,owner)).sort((a,b)=>(a.kind==='home'?0:1)-(b.kind==='home'?0:1)||a.id.localeCompare(b.id));
 return {nodes,collateral:walletCollateralSummary(s,owner),verifiedHeight:s.height,mode:'PREPARATION_ONLY',broadcastEnabled:false,reason:s.rewards?null:'Reward node registration awaits network activation.'};
}
export class WalletNodeLinks extends WalletCollateral {
 async options(){const {state}=await this.current();return walletNodeOverview(state,this.wallet.key.publicKey);}
 async review(q){exact(q,['node','operation']);hex(q.node);
  if(q.operation==='receive'){
   this.pending.clear();
   const {state,certificate}=await this.current({rewardIds:[q.node]});
   const body=walletConsent(state.configHash,q.node,this.wallet.key.publicKey);
   const account=state.rewards?.nodes[q.node];
   if(account?.payouts?.length){
    assert(account.payouts.length===1&&account.payouts[0].wallet===body.wallet,'This server already has a different reward recipient.');
    return {confirmed:true,height:state.height,body};
   }
   if(!account)return {waiting:true,body,height:state.height,reason:'Waiting for the server to register its reward account.'};
   const offer=await this.wallet.client.serverRecipient(certificate.appHash,q.node);
   if(!offer)return {waiting:true,body,height:state.height,reason:'Waiting for the server to invite your wallet.'};
   assert(offer.wallet===body.wallet&&offer.management===account.management&&offer.sequence===account.sequence+1,'No current invitation from this server for this wallet.');
   const id=randomBytes(32).toString('hex');
   this.pending.clear();this.pending.set(id,{body,receive:true,offer,expires:this.now()+120000});
   return {id,body,network:this.wallet.client.config.chainId,registered:!!account,height:state.height};
  }
  const {state}=await this.current({rewardIds:[q.node]}),body=prepareNodeLink(state,q.node,this.wallet.key.publicKey,q.operation,randomBytes(32).toString('hex')),id=randomBytes(32).toString('hex');
  this.pending.clear();this.pending.set(id,{body,expires:this.now()+120000});
  return {id,body,code:pairingCode(body),lastWallet:q.operation==='unlink'&&body.payouts.length===0,status:nodeWalletStatus(state,q.node),submitted:false};
 }
 async confirm(q,currentSession=()=>true){exact(q,['id']);const p=this.pending.get(q.id);this.pending.delete(q.id);assert(p&&this.now()<p.expires,'Node link review expired. Review again.');const {state,certificate}=await this.current({rewardIds:[p.body.node]}),b=p.body;
  if(p.receive){
   assert(this.now()<p.expires,'Review expired.');
   assert.deepEqual(b,walletConsent(state.configHash,b.node,this.wallet.key.publicKey));
   assert(!state.rewards?.nodes[b.node]?.payouts?.length,'This server already has a reward recipient.');
    const fresh=await this.wallet.client.serverRecipient(certificate.appHash,b.node);
    assert.deepEqual(fresh,p.offer,'The invitation changed. Review again.');
    const account=state.rewards.nodes[b.node];assert.equal(account.management,fresh.management);assert.equal(account.sequence+1,fresh.sequence);
    assert(currentSession()&&this.now()<p.expires,'Session expired.');
    const action={type:'ACCEPT_SERVER_REWARD_RECIPIENT_V1',node:b.node,sequence:fresh.sequence,consent:sign(b,this.wallet.key.privateKey)};
    await this.wallet.broadcast(envelope(this.wallet.client.config,action,this.wallet.key));
    return {submitted:true};
  }
  assert(state.money.time>=b.issuedAt&&state.money.time<b.expires,'Node link review expired.');const fresh=prepareNodeLink(state,b.node,b.wallet,b.operation,b.nonce);
  assert.equal(hash({...fresh,issuedAt:b.issuedAt,expires:b.expires}),hash(b),'Node link changed. Review again.');
  return {body:b,walletSignature:sign(b,this.wallet.key.privateKey)};
 }
 async check(q){exact(q,['action']);const {state}=await this.current({rewardIds:[q.action.request?.body.node]});assert.equal(q.action.request?.body.wallet,this.wallet.key.publicKey,'Approval belongs to another wallet.');
  applyNodeLink(state,q.action,q.action.request.body.management);
  return {valid:true,code:pairingCode(q.action.request.body),node:q.action.request.body.node,operation:q.action.request.body.operation,submitted:false,reason:'Both approvals verified. Submission requires the compatible network release.'};
 }
}
