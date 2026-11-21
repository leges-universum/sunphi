import assert from 'node:assert/strict';
import {hash,sign,verify} from './crypto.mjs';
import {rpc} from './client.mjs';
import {enrollmentRoute, enrollmentPolicy, signEnrollment, verifyEnrollmentOffer} from './validator-enrollment.mjs';
import {checkBondRequest} from './bond-request.mjs';
import {consentedVotingHold,preparedVotingMinimum} from './worker-collateral.mjs';
import {spendPolicy} from './spend-protection.mjs';

export class WalletEnrollment {
 constructor(wallet,request){
  this.wallet=wallet;
  this.request=request??(async q=>{
   const r=await rpc(wallet.routes[q.node]??wallet.url,'abci_query',{path:'/work',data:Buffer.from(JSON.stringify(q)).toString('hex')});
   assert(!r.response.code && r.response.value,'Validator service unavailable.');
   return JSON.parse(Buffer.from(r.response.value,'base64'));
  });
  wallet.db.exec('CREATE TABLE IF NOT EXISTS validator_enrollment(id TEXT PRIMARY KEY,owner TEXT NOT NULL,record TEXT NOT NULL)');
 }
 records(){return this.wallet.db.prepare('SELECT record FROM validator_enrollment WHERE owner=? ORDER BY rowid DESC').all(this.wallet.key.publicKey).map(r=>JSON.parse(r.record));}
 present(r,state){
  const {node,bond,owner,validator}=r.intent.template;
  const receipt={id:r.id,node,status:r.status,message:r.message};
  const p=state?.authority?.posSlashing,account=state?.workerFunding?.accounts[node];
  if(!p||account?.owner!==owner)return receipt;
  const held=BigInt(state.money.nodes[node]?.consensusHeld??'0');
  if(held>=BigInt(bond)){
   const active=state.authority.bondedAdmission?.activeValidators?.some(v=>v.node===node&&v.key===validator&&v.power>0)
    ||(Number.isSafeInteger(p.activation)&&state.height>=p.activation&&p.voting?.validators?.some(v=>v.key===validator&&v.power>0));
   return {...receipt,status:active?'active':'reserved',message:active?'Validator active at block '+state.height+'.':
    p.activation===null?'Validator bond reserved. Waiting for network activation.':'Validator bond reserved. Waiting for admission.'};
  }
  if(r.packet&&state.money.time>=r.packet.body.expires&&['accepted','scheduled','pending'].includes(r.status)){
   return {...receipt,status:'expired',message:'Validator authorization expired before the bond was confirmed.'};
  }
  return receipt;
 }
 save(r){this.wallet.db.prepare('INSERT INTO validator_enrollment VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record WHERE owner=excluded.owner').run(r.id,r.intent.template.owner,JSON.stringify(r));}
 async reserveForDeposit(funding,state,valid){
  const r=this.records().find(item=>item.id===funding.clientId);
  if(!r||r.status==='scheduled')return;
  const {template:t}=r.intent;
  assert(r.intent.requiresDeposit && r.intent.instruction===funding.terms);
  assert(verify(r.intent,r.authorization,this.wallet.key.publicKey));
  assert.equal(t.bond,preparedVotingMinimum(state));assert.equal(t.policyHash,enrollmentPolicy);
  assert.equal(t.workerKey,state.money.nodes[t.node]?.key);assert.equal(t.network,this.wallet.client.config.chainId);
  assert.equal(t.configHash,state.configHash);assert.equal(t.node,funding.consent.body.node);
  assert.equal(t.owner,funding.consent.body.owner);
  assert(valid(),'Wallet session changed.');
  if(!r.packet){r.packet=signEnrollment(t,state.money.time,this.wallet.key);this.save(r);}
  const q={operation:enrollmentRoute,phase:'reserve',node:t.node,owner:t.owner,packet:r.packet,funding:funding.consent};
  const reply=await this.request(q);
  assert.deepEqual(reply.body,{operation:enrollmentRoute,request:hash(q),status:'scheduled'});
  assert(verify(reply.body,reply.signature,t.workerKey),'Invalid validator scheduling receipt.');
  r.status='scheduled';r.message='Server will submit the validator bond when this deposit is confirmed.';this.save(r);
 }
 async prepare(q,state,valid){
  const owner=this.wallet.key.publicKey,node=q.node,config=this.wallet.client.config;
  assert.equal(q.enrollment.policyHash,enrollmentPolicy);
  assert.equal(q.enrollment.bond,preparedVotingMinimum(state),'Validator minimum changed. Check the current terms.');
  const policy=spendPolicy(state,owner);
  assert(!policy?.enabled&&!policy?.pending,'Additional spending approval is required.');
  if(q.operation==='activate')consentedVotingHold(state,node,q.enrollment.bond);
  const prior=this.records().find(r=>r.id===q.requestId);
  if(prior){assert.equal(prior.intent.instruction,hash(q));return prior;}
  const reply=await this.request({operation:enrollmentRoute,phase:'offer',node,owner});
  const offer=verifyEnrollmentOffer(reply,state,node,owner,config.chainId);
  if(offer.bound){assert(q.operation==='deposit','The server already has a validator bond.');return null;}
  assert(valid(),'Wallet confirmation expired.');
  const intent={domain:'DUEBYTE_HOME_VALIDATOR_ENROLLMENT_V1',instruction:hash(q),template:offer.template,
    requestId:q.requestId,requiresDeposit:q.operation==='deposit',fundingSequence:state.workerFunding?.accounts[node]?.sequence??0};
  const r={id:q.requestId,intent,authorization:sign(intent,this.wallet.key.privateKey),status:'pending',message:'Waiting for confirmed collateral.'};
  if(q.operation==='activate')this.save(r);
  return r;
 }
 async advance(r,state,valid){
  const t=r.intent.template,owner=this.wallet.key.publicKey;
  assert.equal(t.owner,owner);
  assert(verify(r.intent,r.authorization,owner),'Invalid validator enrollment instruction.');
  assert.equal(t.workerKey,state.money.nodes[t.node]?.key,'Server identity changed.');
  assert.equal(t.configHash,state.configHash);assert.equal(t.network,this.wallet.client.config.chainId);
  assert.equal(t.bond,preparedVotingMinimum(state),'Validator minimum changed. A new approval is required.');
  const account=state.workerFunding?.accounts[t.node];
  if(r.intent.requiresDeposit){
   const row=this.wallet.db.prepare("SELECT record FROM collateral_outgoing WHERE owner=? AND json_extract(record,'$.clientId')=?").get(owner,r.id);
   if(!row)return;
   const funding=JSON.parse(row.record);
   if(['REJECTED','CANCELLED','EXPIRED','CONFLICT'].includes(funding.status)){
    r.status='ended';r.message='Validator enrollment ended with the deposit request.';this.save(r);return;
   }
   if(funding.status!=='COMMITTED')return;
   assert.equal(account?.owner,owner);
   assert.equal(funding.terms,r.intent.instruction);assert.equal(funding.consent.body.node,t.node);
   assert.equal(funding.consent.body.owner,owner);
   assert.equal(account.sequence,funding.consent.body.sequence,'Collateral changed after this deposit.');
   assert.equal(account.lastBodyHash,hash(funding.consent.body),'Deposit could not be verified.');
  }else{
   assert.equal(account?.owner,owner);
   assert.equal(account.sequence,r.intent.fundingSequence,'Collateral changed after approval.');
  }
  if(!r.packet){
   consentedVotingHold(state,t.node,t.bond);
   assert(valid(),'Wallet session changed.');
   r.packet=signEnrollment(t,state.money.time,this.wallet.key);
   this.save(r);
  }
  // Retry the identical authorization after a lost reply, including after
  // expiry. The server can acknowledge an already accepted packet by digest.
  const packet=await this.request({operation:enrollmentRoute,phase:'bind',node:t.node,owner,packet:r.packet});
  assert.deepEqual(packet.body,r.packet.body);assert.deepEqual(packet.template,t);
  checkBondRequest(packet,r.packet.body.notBefore,['owner','worker','validator']);
  r.status='accepted';r.message='Server received the validator authorization. Waiting for network confirmation.';this.save(r);
 }
}
