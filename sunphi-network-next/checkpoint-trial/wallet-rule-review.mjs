import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {rpc} from './client.mjs';
import {exact,hash,hex,integer,sign} from './crypto.mjs';
import {validatorApprovalBody,validatorSet,verifyValidatorApprovals} from './validator-authority.mjs';
import {requestRuleVote,verifyRuleRoute,RULE_ROUTE,RULE_VOTE} from './home-rule-route.mjs';
import {PREPARE_DOMAIN,reviewPreparation,preparationPacket} from './bond-preparation-ballot.mjs';
import {PREPARE_TYPE} from './bond-preparation-ballot.mjs';
import {envelope} from './core.mjs';
import {issuancePacket,mandateId,reviewIssuance} from './ordinary-issuance-ballot.mjs';
import {reviewClosedReserve} from './closed-reserve-ballot.mjs';
import {PREPARE_CLOSED_RESERVE} from './research/closed-network-reserve.mjs';

// This signature domain only endorses the text of a rule. Executable changes
// keep their own certificates and explicit activation height.
export function reviewRuleText(packet,state,network,owner){
 if(packet?.body?.domain===PREPARE_CLOSED_RESERVE)return reviewClosedReserve(packet,state,network,owner);
 if(packet?.body?.domain==='SEAL_ORDINARY_EMISSION_CURVE_V1')return reviewIssuance(packet,state,network,owner);
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
 constructor(wallet,request=requestRuleVote,history=rpc){
  this.wallet=wallet;this.request=request;this.history=history;this.pending=null;
  wallet.db.exec('CREATE TABLE IF NOT EXISTS rule_endorsements(owner TEXT,proposal TEXT,packet TEXT NOT NULL,PRIMARY KEY(owner,proposal))');
  wallet.db.exec('CREATE TABLE IF NOT EXISTS rule_votes(proposal TEXT,signer TEXT,signature TEXT NOT NULL,PRIMARY KEY(proposal,signer))');
  wallet.db.exec('CREATE TABLE IF NOT EXISTS preparation_feedback(owner TEXT PRIMARY KEY,receipt TEXT NOT NULL)');
  wallet.db.exec('CREATE TABLE IF NOT EXISTS closed_reserve_submission(owner TEXT PRIMARY KEY, proposal TEXT NOT NULL, atHeight INTEGER NOT NULL)');
 }
 preparationFeedback(state){
  if(this.feedback===undefined){
   const w=this.wallet,owner=w.key.publicKey;
   const saved=w.db.prepare('SELECT receipt FROM preparation_feedback WHERE owner=?').get(owner);
   this.feedback=saved?JSON.parse(saved.receipt):null;
   if(!saved){
    const prior=w.db.prepare("SELECT proposal,packet FROM rule_endorsements WHERE owner=? AND json_extract(packet,'$.body.domain')=? ORDER BY rowid DESC LIMIT 1").get(owner,PREPARE_DOMAIN);
    if(prior){
     const body=JSON.parse(prior.packet).body;
     const count=w.db.prepare('SELECT COUNT(*) n FROM rule_votes WHERE proposal=?').get(prior.proposal).n;
     this.feedback={proposal:prior.proposal,start:body.notBefore,end:body.expires,policy:hash(body.policy),count,stage:'interrupted'};
    }
   }
  }
  if(!this.feedback)return null;
  const f=this.feedback;
  let stage=f.stage;
  if(state.authority?.posSlashing?.policyHash===f.policy){
   stage='open';
   if(!f.confirmedHeight&&!this.lookup&&this.wallet.client.historyUrl&&Date.now()>=(this.lookupAfter??0)){
    this.lookup=this.confirmationBlock(f,state.height).then(height=>{
     if(height&&this.feedback?.proposal===f.proposal)this.saveFeedback({...this.feedback,confirmedHeight:height});
    }).catch(()=>{}).finally(()=>{this.lookup=null;this.lookupAfter=Date.now()+60000;});
   }
  }
  else if(state.height>=f.end)stage='expired';
  else if(stage==='signing'&&!this.signingPreparation)stage='interrupted';
  return {...f,stage,height:state.height};
 }
 saveFeedback(f){
  this.wallet.db.prepare('INSERT OR REPLACE INTO preparation_feedback(owner,receipt) VALUES(?,?)').run(this.wallet.key.publicKey,JSON.stringify(f));
  this.feedback=f;
 }
 async confirmationBlock(f,verifiedHeight){
  const w=this.wallet,peers=[...new Set([w.url,w.client.historyUrl])];
  if(peers.length!==2||peers.some(url=>!url))return null;
  const matches=encoded=>{
   const wire=JSON.parse(Buffer.from(encoded,'base64')),a=wire.body?.action;
   return a?.type===PREPARE_TYPE&&hash(a.certificate.body)===f.proposal;
  };
  let digest=f.txHash;
  if(!digest){
   // Earlier versions kept the certificate and window but no transaction hash.
   for(let h=f.start;h<=Math.min(f.end,verifiedHeight)&&!digest;h++){
    const {block}=await this.history(peers[0],'block',{height:String(h)});
    assert.equal(block.header.chain_id,w.client.config.chainId);assert.equal(Number(block.header.height),h);
    const raw=(block.data.txs??[]).find(matches);
    if(raw)digest=createHash('sha256').update(Buffer.from(raw,'base64')).digest('hex');
   }
  }
  if(!digest)return null;
  const rows=await Promise.all(peers.map(async url=>{
   const tx=await this.history(url,'tx',{hash:Buffer.from(digest,'hex').toString('base64'),prove:true});
   const height=Number(tx.height);
   assert(Number.isSafeInteger(height)&&height>=f.start&&height<=Math.min(f.end,verifiedHeight));
   assert.equal(Number(tx.tx_result.code),0);assert(matches(tx.tx));
   assert.equal(createHash('sha256').update(Buffer.from(tx.tx,'base64')).digest('hex'),digest);
   const {block,block_id}=await this.history(url,'block',{height:tx.height});
   assert.equal(block.header.chain_id,w.client.config.chainId);assert.equal(Number(block.header.height),height);
   const transactions=block.data.txs;
   assert.equal(transactions[tx.index],tx.tx);assert(/^[0-9a-f]{64}$/i.test(block_id.hash));
   const sha=bytes=>createHash('sha256').update(bytes).digest();
   function root(first,count){
    if(count===1)return sha(Buffer.concat([Buffer.from([0]),sha(Buffer.from(transactions[first],'base64'))]));
    const split=2**Math.floor(Math.log2(count-1));
    return sha(Buffer.concat([Buffer.from([1]),root(first,split),root(first+split,count-split)]));
   }
   assert.equal(root(0,transactions.length).toString('hex'),block.header.data_hash.toLowerCase());
   assert.equal(tx.proof.root_hash,block.header.data_hash);
   return {height,blockHash:block_id.hash};
  }));
  assert.deepEqual(rows[0],rows[1]);return rows[0].height;
 }
 builtin(){return JSON.parse(readFileSync(new URL('./public-bonded-rule-v3.json',import.meta.url),'utf8'));}
 async preparationGroup(nodes,issuance=false,noticeState=null,reservePacket=null){
  if(!noticeState)this.pending=null;
  assert(Array.isArray(nodes)&&nodes.length<=128&&new Set(nodes).size===nodes.length,'Invalid linked server list.');
  nodes.forEach(node=>hex(node));
  const w=this.wallet,owner=w.key.publicKey,network=w.client.config.chainId;
  const state=noticeState??(await w.view({rewardIds:nodes})).state;
  if(!nodes.length)nodes=Object.keys(state.rewards?.nodes??{}).filter(id=>state.rewards.nodes[id].payouts?.some(p=>p.wallet===owner)).sort().slice(0,128);
  const receipt=issuance||reservePacket?null:this.preparationFeedback(state);
  if(noticeState&&['signing','submitted','open'].includes(receipt?.stage))return false;
  const start=receipt&&state.height<receipt.end?receipt.start:undefined;
  const {merged,status}=this.collect(reservePacket??(issuance?issuancePacket():preparationPacket(state,network,start)),state);
  if(reservePacket&&!status.available)return noticeState?false:{...status,id:null};
  if(!noticeState&&['signing','submitted','open'].includes(receipt?.stage))return {...status,id:null,canSign:false,canSubmit:false,feedback:receipt};
  if(noticeState&&(status.expired||status.sealed||status.approved||issuance&&!status.available||!issuance&&!reservePacket&&state.authority.posSlashing))return status.canSubmit;
  const scope=reservePacket?{reserveMandate:status.proposal}:issuance?{issuanceMandate:mandateId}:{preparationStart:merged.body.notBefore},grants=[],used=new Set(merged.approvals.map(v=>v.key));
  let weight=BigInt(status.weight),unreachable=false;
  for(const node of [...nodes].sort()){
   if(weight>=BigInt(status.required)&&(!reservePacket||status.canSubmit))break;
   const payouts=state.rewards?.nodes?.[node]?.payouts;
   if(payouts?.length!==1||payouts[0].wallet!==owner)continue;
   let reply;
   try{reply=await this.request(w,node,{operation:RULE_ROUTE,node,owner,...scope});}catch{unreachable=true;continue;}
   const grant=verifyRuleRoute(reply,state,network,node,owner);
   assert(grant.domain===merged.body.domain&&grant.proposal===status.proposal,'Server reviewed a different proposal');
   if(used.has(grant.controller)||!reviewRuleText(merged,state,network,grant.controller).canSign)continue;
   if(noticeState)return true;
   used.add(grant.controller);grants.push(grant);
   weight+=BigInt(state.authority.validators.find(v=>v.key===grant.controller).power??10);
  }
  if(noticeState){if(unreachable)throw Error('Server eligibility could not be verified.');return status.canSubmit;}
  if(!grants.length&&!status.canSubmit)return {...status,id:null,canSign:false,servers:[],saved:merged.approvals.length?merged:null};
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
 async confirm(q,valid,sessionValid=valid){
  exact(q,['id']);const p=this.pending;this.pending=null;
  assert(p&&p.id===q.id&&Date.now()<p.expires,'Review the proposal again');
  const w=this.wallet,b=p.packet.body,g=p.grant;
  if(p.action==='group'){
   let packet=p.packet;
   const tracked=b.domain===PREPARE_DOMAIN;
   let txHash;
   const update=(stage,reason)=>{if(tracked)this.saveFeedback({proposal:hash(b),start:b.notBefore,end:b.expires,policy:hash(b.policy),count:packet.approvals.length,target:p.packet.approvals.length+p.grants.length,stage,reason,txHash});};
   if(tracked||b.domain===PREPARE_CLOSED_RESERVE){
    assert(valid(),'Approval expired before collection started.');
    // Only the reviewed grant list and body proceed. The server and the wallet
    // recheck eligibility and the signed block window before each endorsement.
    valid=sessionValid;p.expires=Infinity;if(tracked)this.signingPreparation=true;
   }
   try{
   update('signing');
   // Each vote passes the same fresh route, ledger, expiry and signature checks
   // as an individual click. Completed signatures persist across partial retries.
   for(const grant of p.grants){
    assert(valid()&&Date.now()<p.expires,'Wallet session or review expired');
    const one=new WalletRuleReviews(w,this.request);
    one.pending={...p,packet,grant,action:'sign'};
    let result;
    try{result=await one.confirm(q,valid);}
    catch(error){
     if(b.domain!==PREPARE_CLOSED_RESERVE||!valid())throw error;
     // Keep verified endorsements and try the next reviewed signer. No
     // unverified response contributes to the final quorum check below.
     continue;
    }
    packet=result.packet;
    update('signing');
    if(result.status.canSubmit)break;
   }
   const {state}=await w.view(),current=this.collect(packet,state);
   if(!p.willSubmit||!current.status.canSubmit){update('partial');return {packet:current.merged,status:current.status,group:true};}
   const submit=new WalletRuleReviews(w,this.request);
   submit.pending={...p,grant:null,packet:current.merged,action:'submit'};
   const result=await submit.confirm(q,valid);txHash=result.txHash;update('submitted');return {...result,group:true};
   }catch(error){update('interrupted',String(error.message).slice(0,240));throw error;}
   finally{if(tracked)this.signingPreparation=false;}
  }
  const {state}=await w.view(g?{rewardIds:[g.node]}:{});
  const {merged,status:before}=this.collect(p.packet,state);
  if(p.action==='submit'){
   assert(before.canSubmit&&[PREPARE_DOMAIN,PREPARE_CLOSED_RESERVE].includes(b.domain),'Preparation is unavailable at this height');
   assert(valid()&&Date.now()<p.expires,'Wallet session or review expired');
   const wire=envelope(w.client.config,{...(b.domain===PREPARE_CLOSED_RESERVE?{type:PREPARE_CLOSED_RESERVE,managerConsent:merged.managerConsent}:{type:PREPARE_TYPE}),certificate:{body:b,approvals:merged.approvals}},w.key);
   await w.broadcast(wire);
   return {packet:merged,status:before,submitted:true,txHash:createHash('sha256').update(JSON.stringify(wire)).digest('hex')};
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
