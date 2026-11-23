// Proposal decisions in the authenticated ledger. Enacting a protocol change
// requires an executor that understands the exact proposal payload.
import assert from 'node:assert/strict';
import {hash,hex,integer,publicKey,verify,exact} from '../crypto.mjs';
import {amount} from '../payment-model.mjs';
import {anniversary} from '../economic-policy-v2.mjs';
import {consensusAddress} from '../consensus-context.mjs';
import {validatorQuorum} from '../authority.mjs';
import {posVotingAuthority} from './pos-authority-transition.mjs';
import {validateFinancialChange,enactFinancialChange} from './reviewed-financial-rules.mjs';
import {lockedSupport} from '../support-accounting.mjs';
import {escrowedNodePrincipal} from './settlement-assurance.mjs';
import {developmentManager} from '../reserve-recovery.mjs';
import {SMOOTH_EMISSION} from './smooth-emission.mjs';

const namespace='operator-ballots/';
export const ballotHead=namespace+'head',ballotKey=id=>namespace+hex(id);
export const authorQuestions=owner=>namespace+'author/'+hash(owner);
export const archiveKey=n=>ballotKey(hash(['DUEBYTE_VOTING_HISTORY_PAGE_V1',n]));
export const archivePageSize=10;
export const EXPERT_SEATS=5,EXPERT_SIGNATURES=3;
export const SUBMIT_TOPIC='SUBMIT_COMMUNITY_TOPIC_V1', EDIT_TOPIC='EDIT_COMMUNITY_TOPIC_V1';
export const ENABLE_COMMUNITY='ENABLE_PUBLIC_COMMUNITY_V1';
export const governanceActions=['ENABLE_OPERATOR_BALLOTS_V4','FILE_OPERATOR_PROPOSAL_V1','ADMIT_OPERATOR_QUESTION_V2','CAST_OPERATOR_BALLOT_V1','FINISH_OPERATOR_BALLOT_V1',SUBMIT_TOPIC,EDIT_TOPIC,ENABLE_COMMUNITY];
const [ENABLE,FILE,ADMIT,CAST,FINISH]=governanceActions;
export const walletBallotActions=governanceActions.filter(x=>x!==ENABLE&&x!==ENABLE_COMMUNITY);
export const warmupSigner=s=>s.networkReserves?developmentManager(s.networkReserves):null;
const boundedText=(v,max)=>assert(typeof v==='string'&&v.trim().length>0&&Buffer.byteLength(v)<=max,'proposal text bounds');
export const ballotRecord=k=>k===ballotHead||/^operator-ballots\/(?:author\/)?[a-f0-9]{64}$/.test(k);
export function warmupEnd(s){
 const start=s.centuryFunds?.execution?.warmupStart??s.centuryWarmup?.controller.start;
 if(start==null)return null;
 integer(start,1);
 if(s.centuryWarmup)assert.equal(start,s.centuryWarmup.controller.start,'inconsistent warmup anchor');
 return anniversary(start,5);
}
export function governancePhase(s,head,now){
 if(head?.reviewers?.length)return 'expert-review';
 if(Array.isArray(head?.community))return 'warmup';
 const end=warmupEnd(s);
 if(end===null||now<end)return 'warmup';
 return 'expert-election';
}
export const candidateConsent=(configHash,history,profile,mandate)=>({domain:'DUEBYTE_EXPERT_CANDIDACY_V2',configHash,history,profile,mandate});
export function seatsAt(h,now){
 return (h?.reviewers??[]).map(r=>r.next&&r.next.starts<=now?r.next:r);
}
export function servingExperts(h,now){
 return seatsAt(h,now).filter(r=>r.starts<=now&&now<r.ends);
}
export function seatMandate(h,seat,now){
 integer(seat,1);assert(seat<=EXPERT_SEATS,'expert seat out of range');
 const prior=seatsAt(h,now)[seat-1];
 assert(!prior?.next,'successor already elected for this seat');
 return {seat,years:prior?10:7+seat,predecessor:prior?.election??null};
}
function checkSlate(s,h,slate,history=h.history){
 const first=!h.reviewers.length,now=s.money.time;
 assert(Array.isArray(slate)&&slate.length===(first?EXPERT_SEATS:1),first?'exactly five expert candidates required':'nominate one seat at a time');
 const keys=new Set(),organizations=new Set();
 for(const [index,candidate] of slate.entries()){
  exact(candidate,['profile','mandate','signature']);
  const p=candidate.profile;const linked=Object.hasOwn(p,'disclosureUrl');
  exact(p,['key','organization','name',...(linked?['disclosureUrl','disclosureHash']:[])]);
  publicKey(p.key);hex(p.organization);boundedText(p.name,160);
  if(linked){hex(p.disclosureHash);boundedText(p.disclosureUrl,512);assert(/^https:\/\/[^\s]+$/.test(p.disclosureUrl),'public profile URL');}
  assert(!keys.has(p.key)&&!organizations.has(p.organization),'distinct expert keys and organizations required');
  const seat=first?index+1:candidate.mandate.seat;
  assert.deepEqual(candidate.mandate,seatMandate(h,seat,now),'consent must identify the exact seat and term');
  for(const other of seatsAt(h,now).filter(r=>r.seat!==seat)){
   for(const member of [other,other.next].filter(r=>r&&r.ends>now))
    assert(member.key!==p.key&&member.organization!==p.organization,'another seat has this key or organization');
  }
  assert(verify(candidateConsent(s.configHash,history,p,candidate.mandate),candidate.signature,p.key),'signed expert candidacy required');
  keys.add(p.key);organizations.add(p.organization);
 }
}
function weights(s,get){
 const result=new Map();
 for(const v of posVotingAuthority(s.authority).validators){
  const addr=consensusAddress(v.key),r=get('pos/signing/'+addr);
  if(!r||r.signing.jailed||r.signing.tombstoned||r.signing.removedHeight!==null||get('pos/bonds/'+r.node)?.address!==addr)continue;
  const n=s.money.nodes[r.node];assert(r.signing.key===v.key&&n&&amount(n.consensusHeld)>=amount(r.signing.bond));
  const owner=r.owner,funding=s.workerFunding?.accounts[r.node];assert.equal(funding?.owner,owner);
  // The voting bond and payment holds are already inside stake. Order escrow is
  // outside it. A queued withdrawal stays at risk until the on-chain payout.
  const netPaid=amount(funding.depositedMicro)-amount(funding.withdrawnMicro??'0');
  const backing=amount(n.stake)+escrowedNodePrincipal(get,r.node)-lockedSupport(s,r.node)-amount(funding.initialStakeMicro??'0');
  const weight=backing<netPaid?backing:netPaid;
  if(weight>0n)result.set(owner,(result.get(owner)??0n)+weight);
 }
 return Object.fromEntries([...result].filter(([,v])=>v>0n).map(([k,v])=>[k,String(v)]));
}
const decisionContext=(s,h)=>hash({history:h.history,pending:h.live,config:s.configHash,
 financialGeneration:s.authority.generation,financialRegistry:s.authority.validators,plan:s.economicPreparation?.planHash??null,
 slashing:s.authority.posSlashing?.policyHash??null,tariff:s.money.paymentTariff??null});
export const reviewContext=(s,h)=>hash([decisionContext(s,h),servingExperts(h,s.money.time).map(e=>[e.seat,e.election])]);
export function operatorBallotAction(s,a,author,tx,config){
 const h=tx.get(ballotHead),now=s.money.time;
 if(a.type===ENABLE){
  exact(a,['type','body','approvals']);const b=a.body;exact(b,['domain','configHash','generation','notBefore','expires','reviewers','minimumReviews','durationSeconds','quorumBps']);
  assert(!h&&b.domain===ENABLE&&b.configHash===s.configHash&&b.generation===s.authority.generation&&!s.authority.pending);
  integer(b.notBefore);integer(b.expires,b.notBefore+1);assert(now>=b.notBefore&&now<b.expires&&b.expires-b.notBefore<=600);
  assert(warmupEnd(s)!==null&&governancePhase(s,null,now)==='warmup','activation requires the committed five-year warmup');
  assert.deepEqual(b.reviewers,[],'operators elect the first panel');assert.equal(b.minimumReviews,EXPERT_SIGNATURES);
  publicKey(warmupSigner(s));assert(!s.networkReserves.development.access?.pending,'founder key recovery pending');
  const activation=s.authority.posSlashing?.activation;
  assert(Number.isSafeInteger(activation)&&s.height>=activation&&s.authority.posSlashing.voting,'bonded voting must be active before retiring its preparation and activation commands');
  assert(Object.keys(weights(s,k=>tx.get(k))).length,'funded voting operators required at activation');
  if(s.centuryFunds?.mainProgramme)assert.equal(s.centuryFees?.ordinaryCurve,SMOOTH_EMISSION,'seal the prepared ordinary curve before closing the amendment path');
  integer(b.durationSeconds,86400);assert(b.durationSeconds<=30*86400);integer(b.quorumBps,5001);assert(b.quorumBps<=10000);
  validatorQuorum(b,a.approvals,s.authority.validators);
  tx.set(ballotHead,{...b,live:[],history:hash(b)});return s;
 }
 assert(h?.domain===ENABLE,'operator ballots require V4 activation');
 if(a.type===ENABLE_COMMUNITY){
  exact(a,['type','body','approvals','consent']);const b=a.body;
  exact(b,['domain','configHash','history','generation','notBefore','expires','votingDays']);
  assert(!h.community&&b.domain===ENABLE_COMMUNITY&&b.configHash===s.configHash&&b.history===h.history&&b.generation===s.authority.generation&&b.votingDays===14);
  integer(b.notBefore);integer(b.expires,b.notBefore+1);assert(now>=b.notBefore&&now<b.expires&&b.expires-b.notBefore<=7*86400);
  assert(!s.authority.pending&&!s.networkReserves.development.access.pending&&verify(b,a.consent,warmupSigner(s)));
  validatorQuorum(b,a.approvals,s.authority.validators);
  assert(!h.live.some(id=>tx.get(ballotKey(id)).status==='open'),'complete the active ballot before changing its review procedure');
  h.community=[];h.archived=0;h.history=hash([h.history,b]);tx.set(ballotHead,h);return s;
 }
 if(a.type===SUBMIT_TOPIC){
  assert(Array.isArray(h.community),'public proposals await network activation');
  exact(a,['type','title','text','history']);assert.equal(a.history,h.history);
  boundedText(a.title,160);boundedText(a.text,6000);
  const id=hash([s.configHash,author,a]);assert(!tx.get(ballotKey(id)),'topic already submitted');
  const pending=h.community??[];
  assert(pending.length<32,'the public review queue is full');
  assert(!pending.some(key=>tx.get(ballotKey(key)).author===author),'a proposal from this wallet is already under review');
  tx.set(ballotKey(id),{id,author,original:{title:a.title,text:a.text},proposal:a,revision:id,status:'community',filed:s.height});
  h.community=[...pending,id];tx.set(ballotHead,h);return s;
 }
 if(a.type===EDIT_TOPIC){
  exact(a,['type','id','revision','title','text']);hex(a.id);hex(a.revision);
  const interim=!h.reviewers.length&&author===warmupSigner(s)&&!s.networkReserves.development.access.pending;
  assert(interim||servingExperts(h,now).some(e=>e.key===author),'the interim founder or a serving elected expert is required');
  const r=tx.get(ballotKey(a.id));assert(r?.original&&['community','draft'].includes(r.status)&&r.revision===a.revision,'review the current editable version');
  assert(!(h.live??[]).some(key=>tx.get(ballotKey(key)).status==='open'),'complete the current vote before changing the agenda');
  boundedText(a.title,160);boundedText(a.text,6000);
  if(r.status==='community'){
   assert(h.live.length<32,'the voting agenda is full');
   h.community=h.community.filter(key=>key!==a.id);h.live.push(a.id);r.expires=now+30*86400;
  }else assert(a.title!==r.proposal.title||a.text!==r.proposal.text,'the text is unchanged');
  r.status='draft';r.editor=author;r.revision=hash([r.revision,author,a]);r.admissions=[];
  r.proposal={title:a.title,text:a.text,implementationHash:hash([a.title,a.text])};
  h.history=hash([h.history,a.id,r.revision]);tx.set(ballotKey(a.id),r);tx.set(ballotHead,h);return s;
 }
 const cutoff=warmupEnd(s),after=cutoff!==null&&now>=cutoff;
 const onAgenda=h.live.find(id=>tx.get(ballotKey(id)).status==='open');
 if(onAgenda)assert(a.id===onAgenda,'voting agenda is frozen until the decision');
 if(a.type===FILE){
  const election=Object.hasOwn(a,'slate'),financial=Object.hasOwn(a,'change');
  assert(!(election&&financial),'expert election cannot change financial rules');
  const founderSlate=election&&!h.reviewers.length;
  if(founderSlate)assert(author===warmupSigner(s)&&!s.networkReserves.development.access?.pending&&a.node===null,'the founder nominates the first panel');
  if(election&&!founderSlate)assert(a.node===null&&servingExperts(h,now).some(e=>e.key===author),'a serving expert files a seat nomination');
  const revision=Object.hasOwn(a,'supersedes');
  exact(a,['type','node','title','text','implementationHash','history',...(election?['slate']:[]),...(financial?['change']:[]),...(revision?['supersedes']:[])]);if(!election)hex(a.node);hex(a.implementationHash);assert.equal(a.history,h.history);
  if(financial){
   validateFinancialChange(a.change);assert.equal(a.implementationHash,hash(a.change),'financial terms digest');
  }
  if(election){
   checkSlate(s,h,a.slate);
   assert.equal(a.implementationHash,hash(a.slate),'election authorizes only the displayed slate');
  }else if(after&&!h.community)assert(h.reviewers.length,'elect experts before proposing rule changes');
  boundedText(a.title,160);boundedText(a.text,6000);
  const worker=election?null:s.money.nodes[a.node];
  if(!election){assert(weights(s,k=>tx.get(k))[author],'bonded initiator required');assert(worker&&s.workerFunding?.accounts[a.node]?.owner===author);}
  // Warmup drafts must not occupy the only lane for founding the panel.
  const id=hash([s.configHash,author,a]);assert(!tx.get(ballotKey(id)),'proposal already filed');
  if(!financial&&!election){
   assert(!revision,'file a new discussion or attach formal terms');
   tx.set(ballotKey(id),{id,author,proposal:a,status:'discussion',filed:s.height});
   h.discussions=[id,...(h.discussions??[])].slice(0,16);tx.set(ballotHead,h);
   return s;
  }
  if(revision){
   const old=tx.get(ballotKey(hex(a.supersedes)));
   assert(old?.author===author&&!old.replacedBy&&['draft','revision_requested','admission_declined','insufficient_admissions','expired'].includes(old.status),'only the author can revise an eligible version');
   assert(Object.hasOwn(old.proposal,'slate')===election&&Object.hasOwn(old.proposal,'change')===financial,'attach the revised payload for the same type of question');
   assert(old.proposal.title!==a.title||old.proposal.text!==a.text||old.proposal.implementationHash!==a.implementationHash,'change the question before resubmitting');
   h.live=h.live.filter(key=>key!==old.id);
   old.replacedBy=id;if(old.status==='draft')old.status='superseded';
   h.history=hash([h.history,'revision',old.id,id]);tx.set(ballotKey(old.id),old);
  }
  const sameLane=h.live.map(key=>tx.get(ballotKey(key))).filter(r=>h.reviewers.length||Boolean(r.proposal.slate)===election);
  assert(h.live.length<32&&sameLane.length<16&&!sameLane.some(r=>r.author===author),'one current proposal per proposer');
  const subject=founderSlate?'Elect the five nominated experts':election?'Elect expert for seat '+a.slate[0].mandate.seat:a.change.type;
  tx.set(ballotKey(id),{id,author,subject,serverKey:worker?.key??null,proposal:a,status:'draft',filed:s.height,expires:now+30*86400});
  const authorKey=authorQuestions(author);tx.set(authorKey,[id,...(tx.get(authorKey)??[])].slice(0,16));
  h.live.push(id);tx.set(ballotHead,h);return s;
 }
 hex(a.id);const r=tx.get(ballotKey(a.id));assert(r&&h.live.includes(a.id),'proposal not pending');
 function finish(status){
  r.status=status;h.live=h.live.filter(x=>x!==a.id);h.history=hash([h.history,a.id,status,r.yes??'0',r.no??'0']);
  if(h.community){
   const count=h.archived??0,key=archiveKey(Math.floor(count/archivePageSize));
   const entries=tx.get(key)??[];assert.equal(entries.length,count%archivePageSize);
   tx.set(key,[...entries,{id:r.id,title:r.subject??r.proposal.title,result:status,height:s.height}]);h.archived=count+1;
  }
  h.lastDecision=a.id;tx.set(ballotHead,h);
 }
 function adopt(){
  if(r.proposal.change){
   try{s=enactFinancialChange(s,config,r.proposal.change,r.id,tx);}
   catch(error){
    if(!(error instanceof assert.AssertionError))throw error;
    finish('inapplicable');return;
   }
  }
  if(r.proposal.slate){
   const seats=seatsAt(h,now);
   for(const {profile,mandate} of r.proposal.slate){
    const i=mandate.seat-1,prior=seats[i],starts=Math.max(now,prior?.ends??now);
    const elected={...profile,seat:i+1,starts,ends:anniversary(starts,mandate.years),election:r.id,electionHeight:s.height};
    seats[i]=starts>now?{...prior,next:elected}:elected;
   }
   h.reviewers=seats;
  }
  finish('adopted');
 }
 if(a.type===ADMIT){
  exact(a,['type','id','phase','context','decision','review']);assert(r.status==='draft'&&now<r.expires,'only a current draft can be reviewed');
  assert(['admit','reject','revise','abstain'].includes(a.decision),'expert disposition');
  const phase=governancePhase(s,h,now),context=reviewContext(s,h);
  assert.equal(a.phase,phase,'admission phase changed');assert.equal(a.context,context,'agenda changed since review');
  if(r.proposal.slate)checkSlate(s,h,r.proposal.slate,r.proposal.history);
  const initial=phase==='expert-election';if(initial&&!r.original)assert(r.proposal.slate,'first elect the expert panel');
  if(phase==='expert-review'){
   assert(servingExperts(h,now).some(x=>x.key===author),'elected expert signature required');
  }else{
   assert(author===warmupSigner(s)&&!s.networkReserves.development.access?.pending,'founder signature required for admission');
  }
  if(a.decision==='admit'&&phase==='expert-review'){
   exact(a.review,['combinedEffects','alternative']);boundedText(a.review.combinedEffects,1600);boundedText(a.review.alternative,800);
  }else if(a.decision==='admit'||a.decision==='abstain')assert.equal(a.review,null);
  else{exact(a.review,['reason']);boundedText(a.review.reason,1600);}
  const serving=servingExperts(h,now);
  const admissions=(r.admissionContext===context&&r.admissionPhase===phase?r.admissions:[]).filter(e=>phase!=='expert-review'||serving.some(member=>member.key===e.key&&member.election===e.mandate));
  assert(!admissions.some(e=>e.key===author),'expert already signed this admission');
  r.admissions=[...admissions,{key:author,mandate:serving.find(e=>e.key===author)?.election??null,decision:a.decision,review:a.review,height:s.height}];r.admissionContext=context;r.admissionPhase=phase;
  const panel=phase==='expert-review',threshold=panel?EXPERT_SIGNATURES:1,remaining=(panel?serving.length:1)-r.admissions.length;
  const count=decision=>r.admissions.filter(e=>e.decision===decision).length;
  if(count('admit')<threshold){
   if(count('reject')>=threshold)finish('admission_declined');
   else if(count('revise')>=threshold)finish('revision_requested');
   else if(Math.max(count('admit'),count('reject'),count('revise'))+remaining<threshold)finish(count('revise')?'revision_requested':'insufficient_admissions');
   tx.set(ballotKey(a.id),r);return s;
  }
  r.weights=weights(s,k=>tx.get(k));assert(Object.keys(r.weights).length,'bonded voters required');
  if(!r.original&&!r.proposal.slate)assert(r.weights[r.author],'initiator bond no longer active');
  r.total=String(Object.values(r.weights).reduce((n,v)=>n+amount(v),0n));r.yes='0';r.no='0';r.votes={};
  r.status='open';r.after=after;r.context=decisionContext(s,h);r.openHeight=s.height;r.ends=now+(r.original?14*86400:h.durationSeconds);
 }else if(a.type===CAST){
  exact(a,['type','id','choice']);assert(r.status==='open'&&now<r.ends);
  assert(r.weights[author]&&!Object.hasOwn(r.votes,author),'eligible unspent snapshot vote required');assert(['yes','no'].includes(a.choice));
  r.votes[author]=a.choice;r[a.choice]=String(amount(r[a.choice])+amount(r.weights[author]));
 }else{
  assert.equal(a.type,FINISH,'unsupported ballot action');exact(a,['type','id']);
  if(r.status==='draft'){assert(now>=r.expires);finish('expired');}
  else{assert(r.status==='open'&&now>=r.ends);const yes=amount(r.yes),no=amount(r.no);
   if(now>=r.ends+30*86400)finish('expired');
   else if(decisionContext(s,h)!==r.context)finish('new_review_required');
   else if(yes<=no||(yes+no)*10000n<amount(r.total)*BigInt(h.quorumBps))finish('rejected');
   else adopt();
  }
 }
 tx.set(ballotKey(a.id),r);return s;
}
