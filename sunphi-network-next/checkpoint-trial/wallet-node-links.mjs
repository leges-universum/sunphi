// This wallet flow prepares two-sided instructions; it never broadcasts them.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {exact,hash,sign} from './crypto.mjs';
import {WalletCollateral} from './wallet-collateral.mjs';
import {prepareNodeLink,pairingCode,applyNodeLink} from './node-wallet-link.mjs';
import {nodeWalletStatus} from './node-link-state.mjs';
import {walletCollateralSummary} from './wallet-collateral-status.mjs';
export class WalletNodeLinks extends WalletCollateral {
 async options(){const {state:s}=await this.current(),owner=this.wallet.key.publicKey;
  const nodes=[...new Set([...Object.keys(s.rewards?.nodes??{}),...Object.keys(s.workerFunding?.accounts??{})])].filter(id=>s.rewards?.nodes[id]?.management===owner||s.rewards?.nodes[id]?.payouts.some(p=>p.wallet===owner)||s.workerFunding?.accounts[id]?.owner===owner).map(id=>nodeWalletStatus(s,id,owner));
  return {nodes,collateral:walletCollateralSummary(s,owner),verifiedHeight:s.height,mode:'PREPARATION_ONLY',broadcastEnabled:false,reason:s.rewards?null:'Reward node registration awaits network activation.'};
 }
 async review(q){exact(q,['node','operation']);const {state}=await this.current({rewardIds:[q.node]}),body=prepareNodeLink(state,q.node,this.wallet.key.publicKey,q.operation,randomBytes(32).toString('hex')),id=randomBytes(32).toString('hex');
  this.pending.clear();this.pending.set(id,{body,expires:this.now()+120000});
  return {id,body,code:pairingCode(body),lastWallet:q.operation==='unlink'&&body.payouts.length===0,status:nodeWalletStatus(state,q.node),submitted:false};
 }
 async confirm(q){exact(q,['id']);const p=this.pending.get(q.id);this.pending.delete(q.id);assert(p&&this.now()<p.expires,'Node link review expired. Review again.');const {state}=await this.current({rewardIds:[p.body.node]}),b=p.body;
  assert(state.money.time>=b.issuedAt&&state.money.time<b.expires,'Node link review expired.');const fresh=prepareNodeLink(state,b.node,b.wallet,b.operation,b.nonce);
  assert.equal(hash({...fresh,issuedAt:b.issuedAt,expires:b.expires}),hash(b),'Node link changed. Review again.');
  return {body:b,walletSignature:sign(b,this.wallet.key.privateKey)};
 }
 async check(q){exact(q,['action']);const {state}=await this.current({rewardIds:[q.action.request?.body.node]});assert.equal(q.action.request?.body.wallet,this.wallet.key.publicKey,'Approval belongs to another wallet.');
  applyNodeLink(state,q.action,q.action.request.body.management);
  return {valid:true,code:pairingCode(q.action.request.body),node:q.action.request.body.node,operation:q.action.request.body.operation,submitted:false,reason:'Both approvals verified. Submission requires the compatible network release.'};
 }
}
