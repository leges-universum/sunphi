// Consensus-owned earnings. The legacy money interpreter and old hashes stay unchanged.
import assert from 'node:assert/strict';
import {controllerContext} from './controller-context.mjs';
import {cloneSubsidy} from './economic-record-view.mjs';
import {createHash} from 'node:crypto';
import {hash,exact,integer,hex,publicKey,verify,canonical} from './crypto.mjs';
import {amount,audit} from './payment-model.mjs';
import {formatToken,unitScale,intentUnits} from './token-units.mjs';
import {validatorQuorum} from './authority.mjs';
import {validateCalendar,boundedEmission} from './emission-calendar.mjs';
import {paymentWorkUnits,WORK_UNITS} from './reward-work-budget.mjs';
import {FUNDED_ACTIONS,applyFundedWork,advanceFundedWork,auditFundedWork,reservedWorkFees,unissuedWorkBudget} from './funded-reward-work.mjs';
import {launchReserved} from './launch-fund.mjs';
import {networkReserved} from './network-reserves.mjs';
import {recordCenturySubsidy,advanceCenturySubsidy,auditCenturySubsidy} from './century-subsidy.mjs';
import {homeHeld} from './century-home.mjs';
import {cloneRewardLedger,rewardRegistryIds,rewardRegistryIterator,rewardRegistryTotals,rewardPayoutQueue,advanceRewardPayout} from './reward-registry-view.mjs';

import {UTC_REWARDS,utcRewards,rewardClock,checkRewardClock,rewardNotice} from './economic-clock.mjs';

export const REWARDS='DUEBYTE_NODE_REWARDS_V1';
export const REWARD_ACTIONS=['ENABLE_NODE_REWARDS_V1','SET_REWARD_COEFFICIENTS_V1','ALLOW_REWARD_NODES_V1','REGISTER_REWARD_NODE_V1','BIND_REWARD_WALLETS_V1','SET_REWARD_MANAGEMENT_V1','REWARD_WITNESS_V1',...FUNDED_ACTIONS];
const sum=xs=>xs.reduce((a,b)=>a+BigInt(b),0n);
const sorted=x=>Object.keys(x).sort();
const peerId=key=>createHash('sha256').update(Buffer.from(key,'base64url')).digest('hex').slice(0,40);
export const rewardNodeId=(configHash,key)=>hash({domain:REWARDS+'/NODE',configHash,key});
export function validateCoefficients(p){
 exact(p,['version',...(p.timeBasis?['timeBasis','periodSeconds']:['periodBlocks']),'workerWeight','witnessWeight','alphaPPM','periodMintLimit','lifetimeMintLimit',...(p.calendar?['calendar']:[]),...(p.workMeasure?['workMeasure']:[])]);
 if(p.workMeasure)assert.equal(p.workMeasure,'payment_value_v2');
 integer(p.version,1);if(p.timeBasis){assert.equal(p.timeBasis,UTC_REWARDS);integer(p.periodSeconds,20);assert(p.periodSeconds<=432000);}else{integer(p.periodBlocks,10);assert(p.periodBlocks<=43200);}
 for(const key of ['workerWeight','witnessWeight']){integer(p[key],1);assert(p[key]<=1000000);}
 integer(p.alphaPPM);assert(p.alphaPPM<1000000,'emission share must be below one');
 if(p.calendar)validateCalendar(p.calendar);
 amount(p.periodMintLimit);amount(p.lifetimeMintLimit);return p;
}
function validatePeers(peers){assert(Array.isArray(peers)&&peers.length<=128);assert(new Set(peers).size===peers.length);for(const id of peers)assert(/^[a-f0-9]{40}$/.test(id));}
export function rewardsEnabled(s){return !!s.authority?.nodeRewards&&rewardClock(s)>=s.authority.nodeRewards.activation;}
const account=(key,management,kind)=>({key,management,kind,payouts:[],sequence:0,earned:'0',paid:'0',workerJobs:'0',witnessJobs:'0'});
export function ensureRewardWorker(s,id){
 if(s.rewards.nodes[id])return;
 const n=s.money.nodes[id];assert(n,'registered payment worker required');s.rewards.nodes[id]=account(n.key,n.key,'worker');
}
function certify(s,action,c){
 exact(action,['type','certificate']);const cert=action.certificate;exact(cert,['body','approvals']);const b=cert.body;
 assert.equal(b.domain,REWARDS+'/'+action.type);assert.equal(b.configHash,hash(c));assert.equal(b.network,c.chainId);assert.equal(b.generation,s.authority.generation);
 integer(b.notBefore,1);integer(b.expires,1);assert(b.expires>=b.notBefore&&b.expires-b.notBefore<=100&&s.height>=b.notBefore&&s.height<=b.expires,'reward inclusion window');
 validatorQuorum(b,cert.approvals,s.authority.validators);return b;
}
export function applyRewardAction(base,action,author,c,context){
 assert(base.authority,'reward authority unavailable');let s={...base};
 // Governance does not rewrite wallet history. Detach only its writable ledger.
 if(action.type==='ENABLE_NODE_REWARDS_V1')s.authority=structuredClone(base.authority);
 else if(base.rewards&&!FUNDED_ACTIONS.includes(action.type))s.rewards=cloneRewardLedger(base.rewards);
 if(unitScale(s)!==1n){
  assert(!FUNDED_ACTIONS.includes(action.type),'fractional funded rewards require the century executor');
  if(['ENABLE_NODE_REWARDS_V1','SET_REWARD_COEFFICIENTS_V1'].includes(action.type)){
   const p=action.certificate?.body?.coefficients;
   assert(p&&p.alphaPPM===0&&p.periodMintLimit==='0'&&p.lifetimeMintLimit==='0'&&!p.calendar,'fractional legacy rewards are fee-only');
  }
 }
 const common=['domain','configHash','network','generation','notBefore','expires'];
 if(action.type==='ENABLE_NODE_REWARDS_V1'){
  const b=certify(s,action,c);exact(b,[...common,'activation','coefficients','allowedPeers']);assert(!s.authority.nodeRewards,'rewards already enabled');
  validateCoefficients(b.coefficients);checkRewardClock(c,b.coefficients);rewardNotice(s,b.activation,b.expires,b.coefficients);assert.equal(b.coefficients.version,1);validatePeers(b.allowedPeers);
  if(b.coefficients.calendar){const cal=b.coefficients.calendar;assert(cal.startTime>=s.money.time,'calendar cannot start in the past');assert(amount(cal.budget)+amount(s.money.supply)+launchReserved(s)+networkReserved(s)<=amount(cal.supplyCap),'reserve exceeds supply cap');assert(amount(b.coefficients.lifetimeMintLimit)<=amount(cal.budget),'lifetime cap exceeds calendar');}
  s.authority.nodeRewards={activation:b.activation,coefficients:b.coefficients,allowedPeers:b.allowedPeers,certificate:hash(action.certificate)};return s;
 }
 assert(rewardsEnabled(s)&&s.rewards,'rewards not activated');const r=s.rewards;
 if(FUNDED_ACTIONS.includes(action.type)){s=applyFundedWork(s,action,author,c);auditRewards(s);return s;}
 if(action.type==='SET_REWARD_COEFFICIENTS_V1'){
  const b=certify(s,action,c);exact(b,[...common,'activation','coefficients']);validateCoefficients(b.coefficients);checkRewardClock(c,b.coefficients);assert.equal(b.coefficients.timeBasis,r.coefficients.timeBasis,'reward clock immutable');assert.equal(b.coefficients.version,r.coefficients.version+1);assert(!r.scheduled,'coefficient update pending');
  assert.deepEqual(b.coefficients.calendar??null,r.coefficients.calendar??null,'calendar cannot change with reward coefficients');
  assert.equal(b.coefficients.workMeasure??null,r.coefficients.workMeasure??null,'work measure is immutable');
  if(r.fundedWork){assert.equal(b.coefficients.alphaPPM,0,'cannot restart legacy emission');assert(amount(b.coefficients.lifetimeMintLimit)>=amount(r.minted)+unissuedWorkBudget(r),'preserve funded work budget');}
  if(r.coefficients.calendar)assert(amount(b.coefficients.lifetimeMintLimit)<=amount(r.coefficients.calendar.budget),'lifetime cap exceeds calendar');
  // Only the next complete period may change. Already accepted work keeps its tariff.
  assert.equal(b.activation,r.period.end);rewardNotice(s,b.activation,b.expires,b.coefficients);
  assert(amount(b.coefficients.lifetimeMintLimit)>=amount(r.minted),'cannot erase issued tokens');r.scheduled={activation:b.activation,coefficients:b.coefficients};
 }else if(action.type==='ALLOW_REWARD_NODES_V1'){
  const b=certify(s,action,c);exact(b,[...common,'peers']);validatePeers(b.peers);const peers=[...new Set([...r.allowedPeers,...b.peers])].sort();validatePeers(peers);r.allowedPeers=peers;
 }else if(action.type==='REGISTER_REWARD_NODE_V1'){
  exact(action,['type','body','identitySignature','workSignature','managementSignature']);const b=action.body;
  exact(b,['domain','configHash','identity','work','management']);assert.equal(b.domain,REWARDS+'/REGISTER');assert.equal(b.configHash,s.configHash);
  for(const key of [b.identity,b.work,b.management])publicKey(key);assert.equal(new Set([b.identity,b.work,b.management]).size,3,'separate work and payout authority');assert.equal(author,b.work);
  assert(r.allowedPeers.includes(peerId(b.identity)),'node admission not authorized');
  assert(!controllerContext(s)?.homePeerRegistered?.(peerId(b.identity)),'Home identity already registered');
  assert(verify(b,action.identitySignature,b.identity)&&verify(b,action.workSignature,b.work)&&verify(b,action.managementSignature,b.management),'node possession');
  const id=rewardNodeId(s.configHash,b.work),existing=r.enrolled[peerId(b.identity)];
  if(existing){assert.equal(existing,id,'installation already enrolled');assert.equal(r.nodes[id].management,b.management);return base;}
  assert(!Object.hasOwn(r.nodes,id),'duplicate work identity');r.enrolled[peerId(b.identity)]=id;r.nodes[id]=account(b.work,b.management,'witness');
 }else if(action.type==='SET_REWARD_MANAGEMENT_V1'){
  exact(action,['type','body','signature','newSignature']);const b=action.body;
  exact(b,['domain','configHash','node','sequence','management']);assert.equal(b.domain,REWARDS+'/MANAGEMENT');assert.equal(b.configHash,s.configHash);hex(b.node);publicKey(b.management);
  const n=r.nodes[b.node];assert(n,'unknown reward node');assert.equal(author,n.management);assert.notEqual(b.management,n.key,'management must be separate from work key');
  assert.notEqual(b.management,n.management,'management key unchanged');assert.equal(b.sequence,n.sequence+1);
  assert(verify(b,action.signature,n.management)&&verify(b,action.newSignature,b.management),'both management keys must consent');
  n.management=b.management;n.sequence=b.sequence;
 }else if(action.type==='BIND_REWARD_WALLETS_V1'){
  exact(action,['type','body','signature','consents']);const b=action.body;
  exact(b,['domain','configHash','node','sequence','payouts']);assert.equal(b.domain,REWARDS+'/BIND');assert.equal(b.configHash,s.configHash);hex(b.node);const n=r.nodes[b.node];assert(n,'unknown reward node');assert.equal(author,n.management);assert(verify(b,action.signature,n.management),'payout authority');
  assert(Array.isArray(b.payouts)&&b.payouts.length>=1&&b.payouts.length<=16);assert.equal(action.consents.length,b.payouts.length);const wallets=new Set();
  for(let i=0;i<b.payouts.length;i++){const p=b.payouts[i];exact(p,['wallet','weight']);publicKey(p.wallet);integer(p.weight,1);assert(p.weight<=1000000&&!wallets.has(p.wallet));wallets.add(p.wallet);
   assert(verify(walletConsent(s.configHash,b.node,p.wallet),action.consents[i],p.wallet),'recipient ownership');}
  if(b.sequence===n.sequence){assert.deepEqual(b.payouts,n.payouts,'payout sequence conflict');return base;}
  assert.equal(b.sequence,n.sequence+1,'payout sequence');n.sequence=b.sequence;n.payouts=structuredClone(b.payouts);
 }else if(action.type==='REWARD_WITNESS_V1'){
  exact(action,['type','body','signature']);const b=action.body;
  exact(b,['domain','configHash','node','period','height','stateHash']);assert.equal(b.domain,REWARDS+'/WITNESS');assert.equal(b.configHash,s.configHash);const n=r.nodes[b.node];assert(n?.kind==='witness','registered witness required');assert.equal(author,n.key);assert(verify(b,action.signature,n.key),'witness signature');
  assert.equal(b.period,r.period.index,'witness period');assert.deepEqual({height:b.height,stateHash:b.stateHash},r.period.anchor,'assigned checkpoint');
  if(r.period.witnesses.includes(b.node))return base;
  // The assigned set is frozen when the period opens; new identities wait for the next period.
  assert(r.period.assigned.includes(b.node),'no assignment in this period');r.period.witnesses.push(b.node);r.period.witnesses.sort();
  // Under the explicit availability contract, a second public-anchor signature
  // must not earn additional fee weight outside its funded service assignment.
  if(!r.fundedWork?.serviceContract)work(r,b.node,'witness',r.coefficients.workMeasure?WORK_UNITS:1n);
 }else assert.fail('unknown reward action');
 auditRewards(s,context);return s;
}
export const walletConsent=(configHash,node,wallet)=>({domain:REWARDS+'/ACCEPT_REWARDS',configHash,node,wallet});
function work(r,id,kind,value){const n=r.nodes[id];assert(n,'unknown work account');const field=kind+'Jobs';n[field]=String(amount(n[field])+value);const w=r.period.work[id]??{worker:'0',witness:'0'};w[kind]=String(amount(w[kind])+value);r.period.work[id]=w;}
export function recordRewardSettlements(base,before,context){
 if(!base.rewards)return base;let s=base;
 const fresh=(context?.changedRequests??Object.entries(base.money.requests)).filter(([pid,r])=>r.status==='SETTLED'&&before.requests[pid]?.status!=='SETTLED');if(!fresh.length)return base;
 s={...base,rewards:cloneRewardLedger(base.rewards),...(base.centurySubsidy?{centurySubsidy:cloneSubsidy(base.centurySubsidy)}:{})};for(const [,request]of fresh){const fee=BigInt(intentUnits(request.intent,request.intent.fee,unitScale(s)));s.rewards.period.fees=String(amount(s.rewards.period.fees)+fee);s.rewards.collected=String(amount(s.rewards.collected)+fee);
  if(context?.indexed)for(const p of request.intent.parts)for(const id of p.nodes)ensureRewardWorker(s,id);
  if(s.rewards.coefficients.workMeasure){for(const [id,units]of Object.entries(paymentWorkUnits(request.intent)))work(s.rewards,id,'worker',BigInt(units));}
  else for(const p of request.intent.parts)for(const id of p.nodes)work(s.rewards,id,'worker',1n);
  recordCenturySubsidy(s,request);
 }auditRewards(s,context);return s;
}
function openPeriod(s,index,anchor){const c=s.rewards.coefficients,start=rewardClock(s);return {index,start,end:integer(start+(utcRewards(c)?c.periodSeconds:c.periodBlocks),1),...(utcRewards(c)?{startHeight:s.height}:{}),...(s.rewards.coefficients.calendar?{startTime:s.money.time}:{}),anchor,fees:'0',work:{},assigned:s.rewards.homeRegistry?Object.values(s.rewards.enrolled).sort():rewardRegistryIds(s.rewards.nodes,'witness')??sorted(s.rewards.nodes).filter(id=>s.rewards.nodes[id].kind==='witness'),witnesses:[]};}
function allocate(s,allowMint=true){
 const r=s.rewards,p=r.period,c=r.coefficients,F=amount(p.fees),remaining=amount(c.lifetimeMintLimit)-amount(r.minted);
 const limit=amount(c.periodMintLimit),formula=F*BigInt(c.alphaPPM)/BigInt(1000000-c.alphaPPM);
 const mint=allowMint&&formula>0n&&limit>0n&&remaining>0n?boundedEmission({calendar:c.calendar,from:p.startTime??0,to:s.money.time,workBudget:String(formula),periodLimit:String(limit),lifetimeRemaining:String(remaining),supply:s.money.supply}):0n;
 const weights=sorted(p.work).map(id=>({id,value:BigInt(p.work[id].worker)*BigInt(c.workerWeight)+BigInt(p.work[id].witness)*BigInt(c.witnessWeight)}));
 const W=sum(weights.map(w=>w.value));assert(!F||W>0n,'funded work missing');
 if(!W)return;
 const pool=F+amount(r.carry)+mint;let awarded=0n;
 for(const w of weights){const value=pool*w.value/W;r.nodes[w.id].earned=String(amount(r.nodes[w.id].earned)+value);awarded+=value;}
 r.carry=String(pool-awarded);r.minted=String(amount(r.minted)+mint);s.money.supply=String(amount(s.money.supply)+mint);s.money.fees=String(amount(s.money.fees)+mint);
 const statement={index:p.index,start:p.start,end:rewardClock(s),...(utcRewards(c)?{timeBasis:UTC_REWARDS,scheduledEnd:p.end,startHeight:p.startHeight,endHeight:s.height}:{}),coefficientHash:hash(c),fees:p.fees,minted:String(mint),awarded:String(awarded),carry:r.carry,work:p.work};
 r.history=hash({previous:r.history,statement});r.lastStatement=statement;
}
export const MAX_REWARD_PAYOUT_VISITS=64;
function pay(s,context){
 const r=s.rewards;
 const queue=context?.indexed?rewardPayoutQueue(r.nodes):null;let visits=0;
 let capacity=context?.indexed?196608:1048576-196608-Buffer.byteLength(canonical(s)),outputs=0,detached=!!context?.indexed;
 for(const id of queue??rewardRegistryIterator(r.nodes,'payable')??sorted(r.nodes)){
  if(queue&&visits++===MAX_REWARD_PAYOUT_VISITS)break;
  const n=r.nodes[id],pending=amount(n.earned)-amount(n.paid);if(!pending||!n.payouts.length){if(queue)advanceRewardPayout(r.nodes,id);continue;}
  const weights=sum(n.payouts.map(p=>p.weight));let paid=0n;const batch=[];
  for(const p of n.payouts){const value=pending*BigInt(p.weight)/weights;if(!value)continue;
   const output=hash({domain:REWARDS+'/PAYOUT',configHash:s.configHash,node:id,wallet:p.wallet,paid:n.paid,sequence:n.sequence});assert(!Object.hasOwn(s.money.outputs,output),'reward output collision');
   const record={owner:p.wallet,value:String(value),unlock:0},bytes=output.length+Buffer.byteLength(canonical(record))+8;
   // Keep pending claims when the bounded trial snapshot is full. Never halt
   // consensus or erase earnings merely because recipients have not spent yet.
   batch.push({output,record,bytes});paid+=value;
  }
  const bytes=batch.reduce((total,x)=>total+x.bytes,0);if(outputs+batch.length>32||bytes>capacity){if(queue)break;continue;}
  if(batch.length&&!detached){s.money.outputs={...s.money.outputs};detached=true;}
  for(const item of batch)s.money.outputs[item.output]=item.record;outputs+=batch.length;capacity-=bytes;
  n.paid=String(amount(n.paid)+paid);s.money.fees=String(amount(s.money.fees)-paid);
  if(queue)advanceRewardPayout(r.nodes,id);
  if(outputs===32)break;
 }
}
export function beginRewards(base,next,context){
 if(!rewardsEnabled(next))return next;const s={...next,money:{...next.money},...(next.rewards?{rewards:cloneRewardLedger(next.rewards)}:{}),...(next.centurySubsidy?{centurySubsidy:cloneSubsidy(next.centurySubsidy)}:{})};
 if(!s.rewards){const feature=s.authority.nodeRewards;
  s.rewards={domain:REWARDS,coefficients:structuredClone(feature.coefficients),scheduled:null,allowedPeers:[...feature.allowedPeers],enrolled:{},nodes:{},period:null,collected:'0',minted:'0',carry:'0',history:hash({domain:REWARDS+'/HISTORY',configHash:s.configHash}),lastStatement:null};
  for(const id of (context?.nextRewardWorkers?context.nextRewardWorkers():sorted(s.money.nodes)))ensureRewardWorker(s,id);
  s.rewards.period=openPeriod(s,0,{height:base.height,stateHash:context?.anchorRoot??hash(base)});
  // Existing committed settlements prove accepted receipts. Preserve their fees;
  // allocate only represented fees, with no retrospective emission or witness work.
  if(context?.seed){const seed=context.seed;s.rewards.collected=seed.fees;s.rewards.period.fees=seed.fees;for(const [id,w]of Object.entries(seed.work)){ensureRewardWorker(s,id);work(s.rewards,id,'worker',BigInt(w));}}
  else {const legacy=recordRewardSettlements(s,{requests:{}});Object.assign(s,legacy);}allocate(s,false);
  s.rewards.period=openPeriod(s,1,{height:base.height,stateHash:context?.anchorRoot??hash(base)});
 }else if(rewardClock(s)>=s.rewards.period.end){
  if(!utcRewards(s.rewards.coefficients))assert.equal(s.height,s.rewards.period.end,'missed reward period');
  allocate(s);if(s.rewards.scheduled){assert.equal(s.rewards.scheduled.activation,s.rewards.period.end);s.rewards.coefficients=s.rewards.scheduled.coefficients;s.rewards.scheduled=null;}
  s.rewards.period=openPeriod(s,s.rewards.period.index+1,{height:base.height,stateHash:context?.anchorRoot??hash(base)});
 }else assert(rewardClock(s)<s.rewards.period.end,'missed reward period');
 if(next.rewards&&context?.nextRewardWorkers)for(const id of context.nextRewardWorkers())ensureRewardWorker(s,id);
 advanceFundedWork(s);advanceCenturySubsidy(s);pay(s,context);if(!context?.indexed)audit(s.money);auditRewards(s,context);return s;
}
export function auditRewardAccount(id,n){
 hex(id);exact(n,['key','management','kind','payouts','sequence','earned','paid','workerJobs','witnessJobs']);publicKey(n.key);publicKey(n.management);assert(['worker','witness'].includes(n.kind));integer(n.sequence);assert(amount(n.paid)<=amount(n.earned));amount(n.workerJobs);amount(n.witnessJobs);
 assert(Array.isArray(n.payouts)&&n.payouts.length<=16);const seen=new Set();for(const p of n.payouts){exact(p,['wallet','weight']);publicKey(p.wallet);integer(p.weight,1);assert(p.weight<=1000000&&!seen.has(p.wallet));seen.add(p.wallet);}
}
export function auditRewards(s,context){
 if(!s.rewards){assert(!rewardsEnabled(s),'missing reward ledger');return;}
 assert(rewardsEnabled(s),'reward ledger before activation');const r=s.rewards;
 exact(r,['domain','coefficients','scheduled','allowedPeers','enrolled','nodes','period','collected','minted','carry','history','lastStatement',...(r.fundedWork?['fundedWork']:[]),...(r.homeRegistry?['homeRegistry']:[])]);assert.equal(r.domain,REWARDS);validateCoefficients(r.coefficients);validatePeers(r.allowedPeers);hex(r.history);
 if(r.homeRegistry){exact(r.homeRegistry,['version','count']);assert.equal(r.homeRegistry.version,'DUEBYTE_HOME_REGISTRY_V1');integer(r.homeRegistry.count,1);}
 auditFundedWork(s);
 auditCenturySubsidy(s);
 assert(amount(r.minted)<=amount(r.coefficients.lifetimeMintLimit)+amount(s.centurySubsidy?.totalMintedMicro??'0'));amount(r.collected);let held=amount(r.carry)+amount(r.period.fees)+reservedWorkFees(r)+homeHeld(s),earned=0n;
 const registry=rewardRegistryTotals(r.nodes);assert((registry?.count??Object.keys(r.nodes).length)<=(context?.workerCount??Object.keys(s.money.nodes).length)+128+(r.homeRegistry?.count??0));
 if(registry){earned=registry.earned;held+=registry.earned-registry.paid;}
 else for(const [id,n]of Object.entries(r.nodes)){auditRewardAccount(id,n);held+=amount(n.earned)-amount(n.paid);earned+=amount(n.earned);}
 assert(held<=amount(s.money.fees),'reward claims exceed custody');
 assert.equal(earned+amount(r.carry)+amount(r.period.fees)+reservedWorkFees(r)+homeHeld(s),amount(r.collected)+amount(r.minted),'reward accounting identity');
 const p=r.period;exact(p,['index','start','end','anchor','fees','work','assigned','witnesses',...(r.coefficients.calendar?['startTime']:[]),...(utcRewards(r.coefficients)?['startHeight']:[])]);integer(p.index);integer(p.start,1);integer(p.end,p.start+1);assert(rewardClock(s)>=p.start&&rewardClock(s)<p.end);if(utcRewards(r.coefficients)){integer(p.startHeight,1);assert(p.startHeight<=s.height);assert.equal(p.end-p.start,r.coefficients.periodSeconds);}exact(p.anchor,['height','stateHash']);integer(p.anchor.height);hex(p.anchor.stateHash);assert.equal(p.anchor.height,(utcRewards(r.coefficients)?p.startHeight:p.start)-1);
 if(r.coefficients.calendar){integer(p.startTime);assert(p.startTime<=s.money.time);assert(amount(s.money.supply)<=amount(r.coefficients.calendar.supplyCap));}
 for(const [id,w]of Object.entries(p.work)){assert(r.nodes[id]);exact(w,['worker','witness']);amount(w.worker);amount(w.witness);}
 for(const field of ['assigned','witnesses']){assert(Array.isArray(p[field])&&p[field].length<=128&&new Set(p[field]).size===p[field].length);for(const id of p[field])assert(r.nodes[id]?.kind==='witness');}
 for(const id of p.witnesses){assert(p.assigned.includes(id));if(r.fundedWork?.serviceContract)assert.equal(p.work[id]?.witness??'0','0');else assert.equal(p.work[id]?.witness,String(r.coefficients.workMeasure?WORK_UNITS:1n));}
 for(const [peer,id]of Object.entries(r.enrolled)){assert(r.allowedPeers.includes(peer));assert(r.nodes[id]?.kind==='witness');}
 if(r.scheduled){exact(r.scheduled,['activation','coefficients']);assert.equal(r.scheduled.activation,p.end);validateCoefficients(r.scheduled.coefficients);assert.equal(r.scheduled.coefficients.timeBasis,r.coefficients.timeBasis);assert.equal(r.scheduled.coefficients.version,r.coefficients.version+1);}
}
export function rewardSummary(s,node){
 const n=s?.rewards?.nodes[node];if(!n)return {available:false,node,accrued:null,pending:null,paid:null};
 const scale=String(unitScale(s)),values={accrued:n.earned,pending:String(amount(n.earned)-amount(n.paid)),paid:n.paid};
 return {available:true,node,...values,unitScale:scale,display:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,formatToken(v,scale)])),workerJobs:n.workerJobs,witnessJobs:n.witnessJobs,workUnitScale:s.rewards.coefficients.workMeasure?String(WORK_UNITS):'1',payouts:n.payouts,sequence:n.sequence,period:s.rewards.period.index,...(utcRewards(s.rewards.coefficients)?{timeBasis:UTC_REWARDS,nextDistributionAt:s.rewards.period.end}:{nextDistribution:s.rewards.period.end}),coefficientVersion:s.rewards.coefficients.version};
}
