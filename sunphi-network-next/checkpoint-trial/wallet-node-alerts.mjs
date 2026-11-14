import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
import {exact,hash,sign,verify} from './crypto.mjs';import {WalletCollateral} from './wallet-collateral.mjs';
import {prepareNodeAlerts,alertPairingCode,verifyNodeAlertConsent} from './node-alerts.mjs';
export class WalletNodeAlerts extends WalletCollateral {
 constructor(wallet,{connection,store,walletId,checkpoint,now=Date.now}){super(wallet,{now});Object.assign(this,{connection,store,walletId,checkpoint});}
 async status(q){exact(q,['node']);return this.connection.call(this.connection.signed(this.wallet.key,'node_alert_status',q));}
 async account(){await this.connection.refresh(this.walletId,this.wallet.key);const l=this.store.sunphiLink(this.walletId);assert(l?.status==='linked','Connect your account in Messenger settings first.');return {id:l.linkId,revision:l.revision,status:l.status,network:this.wallet.client.config.chainId,wallet_key:this.wallet.key.publicKey,account_id:l.accountId};}
 async review(q){exact(q,['node']);const link=await this.account(),current=await this.status(q),{state}=await this.current();
  const body=prepareNodeAlerts(state,this.wallet.client.config.chainId,q.node,this.wallet.key.publicKey,link,true,current.revision,randomBytes(32).toString('hex'),Math.floor(this.now()/1000)),id=randomBytes(32).toString('hex');
  this.pending.clear();this.pending.set(id,{body,expires:this.now()+120000});return {id,body,code:alertPairingCode(body)};
 }
 async confirm(q){exact(q,['id']);const p=this.pending.get(q.id);this.pending.delete(q.id);assert(p&&this.now()<p.expires,'Review expired.');const l=await this.account(),{state}=await this.current(),b=p.body;
  const fresh=prepareNodeAlerts(state,b.network,b.node,b.wallet,l,true,b.revision-1,b.nonce,b.issuedAt);assert.equal(hash(fresh),hash(b),'Account or server changed. Review again.');
  assert((await this.status({node:b.node})).revision===b.revision-1,'Subscription changed.');return {body:b,walletSignature:sign(b,this.wallet.key.privateKey)};
 }
 async activate(q){exact(q,['approval']);exact(q.approval,['request','managementSignature']);const b=verifyNodeAlertConsent(q.approval.request,{root:{network:this.wallet.client.config.chainId},configHash:hash(this.wallet.client.config)},Math.floor(this.now()/1000));
  assert.equal(b.wallet,this.wallet.key.publicKey);assert(verify(b,q.approval.managementSignature,b.management),'Server approval required.');
  const l=await this.account();assert(l.id===b.linkId&&l.revision===b.linkRevision&&l.account_id===b.account,'Account changed.');
  const evidence=await this.wallet.client.nodeAlertEvidence(await this.checkpoint(),this.wallet.url,b.node);
  return this.connection.call({action:'node_alert_subscribe',approval:q.approval,evidence});
 }
 async stop(q){exact(q,['node','revision']);return this.connection.call(this.connection.signed(this.wallet.key,'node_alert_stop',q));}
}
