import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {exact,hash,hex,integer,sign} from './crypto.mjs';
import {validatorApprovalBody,validatorSet,verifyValidatorApprovals} from './validator-authority.mjs';
import {requestRuleVote,verifyRuleRoute,RULE_ROUTE,RULE_VOTE} from './home-rule-route.mjs';
import {PREPARE_DOMAIN,reviewPreparation,preparationPacket} from './bond-preparation-ballot.mjs';
import {PREPARE_TYPE} from './bond-preparation-ballot.mjs';
import {envelope} from './core.mjs';

// This signature domain only endorses the text of a rule. Executable changes
// keep their own certificates and explicit activation height.
export function reviewRuleText(packet,state,network,owner){
 if(packet?.body?.domain===PREPARE_DOMAIN)return reviewPreparation(packet,state,network,owner);
 exact(packet,['body','document','approvals']);
 const {body,document,approvals}=packet,a=state.authority;
 exact(body,['domain','network','configHash','generation','financialSetHash','documentSha256','referenceHeight','expiresHeight','supersedes']);
 assert.equal(body.domain,'DUEBYTE_OFFCHAIN_RULE_REVIEW_V1','Unsupported ballot');
 assert.equal(body.network,network,'Different network');assert.equal(body.configHash,state.configHash,'Different genesis configuration');
 assert(a?.version===2&&a.generation===body.generation,'Financial registry changed');
 assert.equal(body.financialSetHash,validatorSet(a.validators).hash,'Financial registry changed');
 assert(typeof document==='string'&&document.trim()&&Buffer.byteLength(document)<=65536,'Invalid proposal text');
 assert.equal(createHash('sha256').update(document).digest('hex'),body.documentSha256,'Proposal text differs from the signed document');
 if(body.supersedes!==null)hex(body.supersedes);
 integer(body.referenceHeight,1);integer(body.expiresHeight,body.referenceHeight);integer(state.height,body.referenceHeight);
 const tally=verifyValidatorApprovals(body,approvals,a.validators);
 const approved=tally.power>=tally.threshold,expired=state.height>body.expiresHeight;
 const member=a.validators.some(v=>v.key===owner),voted=approvals.some(x=>x.key===owner);
 return {proposal:hash(body),document,network,height:state.height,closesAt:body.expiresHeight,
  weight:String(tally.power),required:String(tally.threshold),approved,expired,member,voted,
  canSign:member&&!voted&&!approved&&!expired};
}

export class WalletRuleReviews{
 constructor(wallet,request=requestRuleVote){
  this.wallet=wallet;this.request=request;this.pending=null;
  wallet.db.exec('CREATE TABLE IF NOT EXISTS rule_endorsements(owner TEXT,proposal TEXT,packet TEXT NOT NULL,PRIMARY KEY(owner,proposal))');
  wallet.db.exec('CREATE TABLE IF NOT EXISTS rule_votes(proposal TEXT,signer TEXT,signature TEXT NOT NULL,PRIMARY KEY(proposal,signer))');
 }
 builtin(){return JSON.parse(readFileSync(new URL('./public-bonded-rule-v3.json',import.meta.url),'utf8'));}
 async preparationGroup(nodes){
  this.pending=null;
  assert(Array.isArray(nodes)&&nodes.length>0&&nodes.length<=128&&new Set(nodes).size===nodes.length,'Open a wallet with linked servers.');
  nodes.forEach(node=>hex(node));
  const w=this.wallet,owner=w.key.publicKey,network=w.client.config.chainId;
  const {state}=await w.view({rewardIds:nodes});
  const {merged,status}=this.collect(preparationPacket(state,network),state);
  const scope={preparationStart:merged.body.notBefore},grants=[],used=new Set(merged.approvals.map(v=>v.key));
  let weight=BigInt(status.weight);
  for(const node of [...nodes].sort()){
   if(weight>=BigInt(status.required))break;
   const payouts=state.rewards?.nodes?.[node]?.payouts;
   if(payouts?.length!==1||payouts[0].wallet!==owner)continue;
   let reply;
   try{reply=await this.request(w,node,{operation:RULE_ROUTE,node,owner,...scope});}catch{continue;}
   const grant=verifyRuleRoute(reply,state,network,node,owner);
   assert(grant.domain===PREPARE_DOMAIN&&grant.proposal===status.proposal,'Server reviewed a different proposal');
   if(used.has(grant.controller)||!reviewPreparation(merged,state,network,grant.controller).canSign)continue;
   used.add(grant.controller);grants.push(grant);
   weight+=BigInt(state.authority.validators.find(v=>v.key===grant.controller).power);
  }
  assert(grants.length||status.canSubmit,'No eligible linked server is available for this proposal.');
  const id=randomBytes(32).toString('hex');
  const willSubmit=weight>=BigInt(status.required);
  this.pending={id,action:'group',packet:merged,grants,scope,willSubmit,expires:Date.now()+120000};
  return {...status,group:true,canSign:grants.length>0,id,servers:grants.map(g=>g.node),expectedWeight:String(weight),willSubmit};
 }
 collect(packet,state){
  const w=this.wallet,inspect=value=>reviewRuleText(value,state,w.client.config.chainId,w.key.publicKey);
  const first=inspect(packet);
  const saved=w.db.prepare('SELECT packet FROM rule_endorsements WHERE owner=? AND proposal=?').get(w.key.publicKey,first.proposal);
  const known=w.db.prepare('SELECT signer AS key,signature FROM rule_votes WHERE proposal=? ORDER BY signer').all(first.proposal);
  const votes=new Map();
  for(const row of [...(saved?JSON.parse(saved.packet).approvals:[]),...known,...packet.approvals]){
   const {key,signature}=row;votes.set(key,{key,signature});
  }
  const merged={...packet,approvals:[...votes.values()]},status=inspect(merged);
  const remember=w.db.prepare('INSERT OR IGNORE INTO rule_votes(proposal,signer,signature) VALUES(?,?,?)');
  for(const vote of packet.approvals)remember.run(first.proposal,vote.key,vote.signature);
  return {merged,status};
 }
 async review(packet,node=null){
  this.pending=null;
  const w=this.wallet,owner=w.key.publicKey,network=w.client.config.chainId;
  if(node!==null)hex(node);
  const {state}=await w.view(node?{rewardIds:[node]}:{});
  const generated=packet?.builtin==='bond-preparation'&&Object.keys(packet).length===1;
  if(generated)packet=preparationPacket(state,network);
  const scope=generated?{preparationStart:packet.body.notBefore}:{};
  const {merged,status}=this.collect(packet,state);
  let grant=null;
  if(node){
   const reply=await this.request(w,node,{operation:RULE_ROUTE,node,owner,...scope});
   grant=verifyRuleRoute(reply,state,network,node,owner);
   assert.equal(grant.domain,merged.body.domain,'The server pairing does not authorize this kind of proposal');
   assert.equal(grant.proposal,hash(merged.body),'The server is paired to a different proposal');
   Object.assign(status,reviewRuleText(merged,state,network,grant.controller),{controller:grant.controller,server:node});
  }
  const action=status.canSubmit?'submit':status.canSign?'sign':null;
  const id=action?randomBytes(32).toString('hex'):null;
  if(id)this.pending={id,action,expires:Date.now()+120000,packet:structuredClone(merged),grant,scope};
  return {...status,id,saved:merged.approvals.length?merged:null};
 }
 async confirm(q,valid){
  exact(q,['id']);const p=this.pending;this.pending=null;
  assert(p&&p.id===q.id&&Date.now()<p.expires,'Review the proposal again');
  const w=this.wallet,b=p.packet.body,g=p.grant;
  if(p.action==='group'){
   let packet=p.packet;
   // Each vote passes the same fresh route, ledger, expiry and signature checks
   // as an individual click. Completed signatures persist across partial retries.
   for(const grant of p.grants){
    assert(valid()&&Date.now()<p.expires,'Wallet session or review expired');
    const one=new WalletRuleReviews(w,this.request);
    one.pending={...p,packet,grant,action:'sign'};
    const result=await one.confirm(q,valid);
    packet=result.packet;
    if(result.status.canSubmit)break;
   }
   const {state}=await w.view(),current=this.collect(packet,state);
   if(!p.willSubmit||!current.status.canSubmit)return {packet:current.merged,status:current.status,group:true};
   const submit=new WalletRuleReviews(w,this.request);
   submit.pending={...p,grant:null,packet:current.merged,action:'submit'};
   return {...await submit.confirm(q,valid),group:true};
  }
  const {state}=await w.view(g?{rewardIds:[g.node]}:{});
  const {merged,status:before}=this.collect(p.packet,state);
  if(p.action==='submit'){
   assert(before.canSubmit&&b.domain===PREPARE_DOMAIN,'Preparation is unavailable at this height');
   assert(valid()&&Date.now()<p.expires,'Wallet session or review expired');
   const wire=envelope(w.client.config,{type:PREPARE_TYPE,certificate:{body:b,approvals:merged.approvals}},w.key);
   await w.broadcast(wire);
   return {packet:merged,status:before,submitted:true};
  }
  const signer=g?.controller??w.key.publicKey;
  assert((g?reviewRuleText(merged,state,w.client.config.chainId,signer):before).canSign,'Ballot is closed or signer is ineligible');
  assert(valid()&&Date.now()<p.expires,'Wallet session or review expired');
  let approval;
  if(g){
   const reply=await this.request(w,g.node,{operation:RULE_ROUTE,node:g.node,owner:w.key.publicKey,...p.scope});
   assert.deepEqual(verifyRuleRoute(reply,state,w.client.config.chainId,g.node,w.key.publicKey),g,'Server pairing changed');
   assert(valid()&&Date.now()<p.expires,'Review expired before server authorization');
   const intent={domain:RULE_VOTE,network:g.network,configHash:g.configHash,node:g.node,owner:g.owner,controller:signer,
    grant:hash(g),proposal:hash(b),height:state.height,expiresHeight:Math.min(state.height+12,g.expiresHeight,b.expiresHeight??b.expires)};
   const result=await this.request(w,g.node,{operation:RULE_VOTE,intent,ownerSignature:sign(intent,w.key.privateKey),...p.scope});
   exact(result,['proposal','approval']);assert.equal(result.proposal,intent.proposal);
   approval=result.approval;assert.equal(approval.key,signer);
  }else approval={key:signer,signature:sign(validatorApprovalBody(b,state.authority.validators),w.key.privateKey)};
  const packet={...merged,approvals:[...merged.approvals,approval]};
  const status=reviewRuleText(packet,state,w.client.config.chainId,w.key.publicKey);
  w.db.prepare('INSERT INTO rule_endorsements(owner,proposal,packet) VALUES(?,?,?) ON CONFLICT(owner,proposal) DO NOTHING').run(w.key.publicKey,status.proposal,JSON.stringify(packet));
  this.collect(packet,state);
  return {packet,status,remoteController:g?.controller??null};
 }
}
