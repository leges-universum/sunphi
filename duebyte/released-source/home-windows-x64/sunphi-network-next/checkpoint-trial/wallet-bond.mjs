import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {exact,hash,sign} from './crypto.mjs';
import {bondBody,bondPolicy,bondPolicyForHash,bondedAdmissionPolicy,checkBondRequest,validateBondTemplate} from './bond-request.mjs';
import {formatToken} from './token-units.mjs';
import {spendPolicy} from './spend-protection.mjs';
import {WalletCollateral} from './wallet-collateral.mjs';
import {consentedVotingHold,preparedVotingMinimum} from './worker-collateral.mjs';

export class WalletBond extends WalletCollateral {
 constructor(wallet,options) {
  super(wallet,options);
  wallet.db.exec('CREATE TABLE IF NOT EXISTS bond_receipts(node TEXT PRIMARY KEY, packet TEXT NOT NULL)');
 }
 async overview(node) {
  const {state}=await this.current({rewardIds:[node]});
  assert.equal(state.workerFunding?.accounts[node]?.owner,this.wallet.key.publicKey,'Open the collateral owner wallet.');
  const amount=formatToken(preparedVotingMinimum(state)??state.money.nodes[node].consensusHeld,state.money.unitScale??'1');
  const prepared=state.authority?.posSlashing;
  const policy=prepared?bondPolicyForHash(prepared.policyHash):bondPolicy;
  return {amount,policy,hasSaved:Boolean(this.saved(node))};
 }
 async terms(t) {
  validateBondTemplate(t);
  const {state:s}=await this.current({rewardIds:[t.node]});
  assert(t.network===this.wallet.client.config.chainId && t.configHash===s.configHash,'Request belongs to a different network.');
  const node=s.money.nodes[t.node], funding=s.workerFunding?.accounts?.[t.node];
  assert(funding && t.owner===this.wallet.key.publicKey && funding.owner===t.owner,'Open the wallet that owns this collateral.');
  assert(node && node.key===t.workerKey,'Worker identity changed.');
  const a=s.authority;
  const policy=bondPolicyForHash(t.policyHash);
  if(policy===bondPolicy){
   assert(!funding.release && BigInt(node.consensusHeld)>=BigInt(t.bond) && BigInt(node.stake)>=BigInt(node.consensusHeld)+BigInt(node.taskHeld),'Reserved collateral is unavailable.');
   assert((a?.validators??this.wallet.client.config.control?.validators)?.some(v=>v.key===t.validator),'Validator is outside the current roster.');
  }else consentedVotingHold(s,t.node,t.bond);
  const p=spendPolicy(s,t.owner);
  let reason=null;
  if(a?.version!==2 || !a.posSlashing)reason='Signing opens when the network approves the penalty terms.';
  else if(a.posSlashing.policyHash!==t.policyHash)reason='The network approved different penalty terms.';
  else if(a.posSlashing.activation!==null){
   const rules=a.bondedAdmission;
   if(policy!==bondedAdmissionPolicy || rules?.version!==3 || rules.ballot!==policy.ballot ||
      !Number.isSafeInteger(a.posSlashing.activation) || s.height<a.posSlashing.activation)
    reason='Bond signing is unavailable at this height.';
   else if(typeof rules.minimumMicro!=='string' || !/^[1-9][0-9]{0,19}$/.test(rules.minimumMicro) || BigInt(t.bond)<BigInt(rules.minimumMicro))
    reason='The requested amount does not meet the confirmed minimum.';
  }
  if(!reason && a.pending)reason='A validator change is pending. Review again after confirmation.';
  if(!reason && (p?.enabled || p?.pending))reason='This wallet requires additional spending approval.';
  return {ready:reason===null,reason,time:s.money.time,amount:formatToken(t.bond,s.money.unitScale??'1'),height:s.height};
 }
 async review(packet) {
  const paired=Object.hasOwn(packet,'body');
  if(!paired) exact(packet,['template']);
  const {template:t}=packet;
  const status=await this.terms(t);
  const result={...status,template:t,policy:bondPolicyForHash(t.policyHash),request:null,id:null};
  this.clear();
  if(paired) checkBondRequest(packet,status.time,['validator','worker']);
  if(!status.ready) return result;
  if(!paired) return {...result,request:{template:t,body:bondBody(t,status.time,status.time+600)}};
  const id=randomBytes(32).toString('hex');
  this.pending.set(id,{packet:structuredClone(packet),deadline:this.now()+Math.min(120,packet.body.expires-status.time)*1000});
  return {...result,id,expires:packet.body.expires};
 }
 async confirm(q,stillAuthorized) {
  exact(q,['id']);const pending=this.pending.get(q.id);
  this.pending.delete(q.id);
  assert(pending && this.now()<pending.deadline,'Review the bond again.');
  const {packet}=pending,status=await this.terms(packet.template);
  assert(status.ready && stillAuthorized() && this.now()<pending.deadline,'Wallet, policy or confirmation changed. Review again.');
  checkBondRequest(packet,status.time,['validator','worker']);
  const complete={...packet,ownerSignature:sign(packet.body,this.wallet.key.privateKey)};
  checkBondRequest(complete,status.time,['validator','worker','owner']);
  const {template,...consent}=complete,action={type:'BIND_CONSENSUS_BOND_V1',consent};
  const previous=this.saved(template.node);
  assert(!previous || previous.consent.body.expires<=status.time || hash(previous)===hash(action),'Another unexpired authorization exists for this node.');
  const written=this.wallet.db.prepare(`INSERT INTO bond_receipts(node,packet) VALUES(?,?)
   ON CONFLICT(node) DO UPDATE SET packet=excluded.packet WHERE bond_receipts.packet=?`).run(
   template.node,JSON.stringify(action),previous?JSON.stringify(previous):null);
  assert.equal(written.changes,1,'Saved authorization changed. Reopen the bond.');
  return action;
 }
 saved(node) {
  const row=this.wallet.db.prepare('SELECT packet FROM bond_receipts WHERE node=?').get(node);
  return row?JSON.parse(row.packet):null;
 }
}
