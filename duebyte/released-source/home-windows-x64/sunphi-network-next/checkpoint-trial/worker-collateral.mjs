// Owned collateral only. A pre-signed pilot mandate may enable funded capacity.
import assert from 'node:assert/strict';
import {activatePilotSupport} from './zero-stage.mjs';
import {lockedSupport,supportAccount} from './support-accounting.mjs';
import {exact,hash,hex,integer,publicKey,verify} from './crypto.mjs';
import {amount,MAX} from './payment-model.mjs';
import {spendPolicy} from './spend-protection.mjs';
import {centuryRestrictedAccounts} from './century-funds.mjs';
import {centuryWarmupAccounts,memorialPolicy} from './economic-policy-v3.mjs';
import {reserveAddresses} from './network-reserves.mjs';
import {bondedAdmissionPolicy} from './bond-request.mjs';
import {LEGACY_INPUTS,consolidationEnabled} from './payment-input-policy.mjs';
export const FUND_WORKER='FUND_PAYMENT_WORKER_V1';
export const QUEUE_RELEASE='QUEUE_WORKER_COLLATERAL_RELEASE_V1';
export const CANCEL_RELEASE='CANCEL_WORKER_COLLATERAL_RELEASE_V1';
export const EXECUTE_RELEASE='EXECUTE_WORKER_COLLATERAL_RELEASE_V1';
export const MERGE_OWNED='CONSOLIDATE_OWNED_OUTPUTS_V1';
export const COLLATERAL_ACTIONS=[FUND_WORKER,QUEUE_RELEASE,CANCEL_RELEASE,EXECUTE_RELEASE,MERGE_OWNED];
export const RELEASE_DELAY_SECONDS=86400;
export const COLLATERAL_DOMAIN='DUEBYTE_WORKER_COLLATERAL_V1';
export function consolidatedOutput(configHash,owner,inputs){
 return hash({domain:MERGE_OWNED,configHash,owner,inputs});
}
export function consolidateOwned(s,action,owner){
 exact(action,['type','inputs']);assert.equal(action.type,MERGE_OWNED);publicKey(owner);
 assert(consolidationEnabled(s),'Free consolidation is not active.');
 const protection=spendPolicy(s,owner);
 assert(!protection?.enabled&&!protection?.pending,'Protected wallet consolidation is unavailable.');
 assertOrdinaryOwner(s,owner);
 const ids=action.inputs;
 assert(Array.isArray(ids)&&ids.length>=2&&ids.length<=LEGACY_INPUTS,'consolidation input count');
 ids.forEach(hex);assert.deepEqual(ids,[...new Set(ids)].sort(),'canonical consolidation inputs');
 const output=consolidatedOutput(s.configHash,owner,ids);assert(!s.money.outputs[output],'consolidation already applied');
 let total=0n;
 for(const id of ids){
  const o=s.money.outputs[id];assert(o?.owner===owner&&o.unlock<=s.money.time,'Consolidation requires confirmed spendable funds from this wallet.');
  const value=amount(o.value);assert(value>0n);total+=value;
 }
 assert(total<=MAX);for(const id of ids)delete s.money.outputs[id];
 s.money.outputs[output]={owner,value:String(total),unlock:0};return s;
}
function assertOrdinaryOwner(s,owner){
 const restricted=[...centuryRestrictedAccounts(s.configHash),...centuryWarmupAccounts(s.configHash),memorialPolicy(s.configHash).account,...Object.values(reserveAddresses(s.configHash))];
 assert(!restricted.includes(owner)&&owner!==supportAccount(s.configHash),'programme funds cannot bypass custody');
}
const bondedPolicyHash=hash(bondedAdmissionPolicy);
export function preparedVotingMinimum(s){
 const p=s.authority?.posSlashing;
 if(!p||!Object.hasOwn(p,'voting')||p.policyHash!==bondedPolicyHash)return null;
 const rule=s.authority.bondedAdmission;
 if(!rule)return '100000000';
 return rule.version===3&&rule.ballot===bondedAdmissionPolicy.ballot&&
  typeof rule.minimumMicro==='string'&&/^[1-9][0-9]{0,19}$/.test(rule.minimumMicro)&&
  amount(rule.minimumMicro)>=100000000n&&amount(rule.minimumMicro)<=10000000000n&&
  amount(rule.minimumMicro)%1000000n===0n?rule.minimumMicro:null;
}
export function outsideCollateralPilot(s,id){
 const pilot=s.centuryFunds?.zeroStage?.body;
 if(pilot?.settings?.ramp!=='TERMINAL_WEEK_V2'||pilot.workers.some(w=>w.node===id))return false;
 return !(preparedVotingMinimum(s) && s.money.nodes[id]);
}
// Project the consensus hold only after validating the owner's tracked deposit.
// A prior reservation stays locked. The three-party consent specifies the total
// bond, so an already reserved portion is never locked twice.
export function consentedVotingHold(s,id,bond,{increase=false}={}){
 const node=s.money.nodes[id],f=s.workerFunding?.accounts[id];
 assert(node&&f&&!f.release&&Object.hasOwn(f,'initialStakeMicro'),'tracked owner deposit required');
 const value=amount(bond),reserved=amount(node.consensusHeld),stake=amount(node.stake);
 const total=reserved>value?reserved:value;
 assert(value>0n&&(increase||value>=100000000n)&&value<=amount(f.depositedMicro)-amount(f.withdrawnMicro),increase?'Insufficient owner deposits.':'100 DUBYT of owner deposits required');
 assert(total+amount(node.taskHeld)<=stake,'insufficient free collateral');
 assert(value+amount(node.taskHeld)+lockedSupport(s,id)+amount(f.initialStakeMicro)<=stake,'insufficient operator-owned stake');
 return String(total);
}
export const collateralChangeId=b=>hash({domain:COLLATERAL_DOMAIN+'/CHANGE',body:b});
// Owner-funded capacity after voting, existing work and non-owner funds.
export function availableWorkingStake(s,id){
 const n=s.money.nodes[id],f=s.workerFunding?.accounts[id];
 if(!n||!f||f.release||f.initialStakeMicro===undefined||s.money.liability?.discipline?.[id]?.suspended)return 0n;
 const held=amount(n.consensusHeld), minimum=amount(preparedVotingMinimum(s)??'0');
 const free=amount(n.stake)-(held>minimum?held:minimum)-amount(n.taskHeld)-lockedSupport(s,id)-amount(f.initialStakeMicro);
 const owned=amount(f.depositedMicro)-amount(f.withdrawnMicro);
 return free<=0n?0n:free<owned?free:owned;
}
export const collateralReleaseId=(configHash,node,sequence)=>hash({domain:COLLATERAL_DOMAIN+'/RELEASE',configHash,node,sequence});
export function auditWorkerFunding(s){
 const f=s.workerFunding;if(!f)return;
 exact(f,['version','accounts']);assert.equal(f.version,COLLATERAL_DOMAIN);
 const entries=Object.entries(f.accounts);assert(entries.length<=1024);
 for(const [node,a]of entries){
  hex(node);const tracked=Object.hasOwn(a,'initialStakeMicro');
  exact(a,['owner','sequence','depositedMicro','lastBodyHash',...(a.votingBond?['votingBond']:[]),...(tracked?['initialStakeMicro','withdrawnMicro','release','lastRelease']:[])]);
  publicKey(a.owner);integer(a.sequence,1);assert(amount(a.depositedMicro)>0n);hex(a.lastBodyHash);
  if(a.votingBond){exact(a.votingBond,['validator','heldMicro']);publicKey(a.votingBond.validator);amount(a.votingBond.heldMicro);}
  if(tracked){amount(a.initialStakeMicro);assert(amount(a.withdrawnMicro)<=amount(a.depositedMicro));
   if(a.release){exact(a.release,['sequence','valueMicro','queuedAt','readyAt']);integer(a.release.sequence,1);assert(a.release.sequence<=a.sequence);assert(amount(a.release.valueMicro)>0n);integer(a.release.queuedAt,1);integer(a.release.readyAt,a.release.queuedAt+RELEASE_DELAY_SECONDS);}
   if(a.lastRelease){exact(a.lastRelease,['sequence','valueMicro','output']);integer(a.lastRelease.sequence,1);assert(a.lastRelease.sequence<=a.sequence);assert(amount(a.lastRelease.valueMicro)>0n);hex(a.lastRelease.output);}
  }
 }
}
export function fundWorker(s,a,author,increaseVoting){
 exact(a,['type','body','ownerSignature','workerSignature']);assert.equal(a.type,FUND_WORKER);const b=a.body;
 exact(b,['domain','configHash','node','owner','sequence','issuedAt','expires','unitScale','inputs','valueMicro',...(Object.hasOwn(b,'votingValidator')?['votingValidator']:[])]);
 if(Object.hasOwn(b,'votingValidator')){publicKey(b.votingValidator);assert(increaseVoting,'Voting bond increases require indexed execution.');}
 assert.equal(b.domain,COLLATERAL_DOMAIN);assert.equal(b.configHash,s.configHash);hex(b.node);publicKey(b.owner);assert.equal(author,b.owner);
 assert.equal(s.money.unitScale,'1000000');assert.equal(b.unitScale,s.money.unitScale);assert(s.centuryFees,'qualified precision and fee policy required');
 integer(b.issuedAt,1);integer(b.expires,b.issuedAt+1);assert(b.expires-b.issuedAt<=600&&b.issuedAt<=s.money.time&&s.money.time<b.expires,'collateral UTC window');
 const worker=s.money.nodes[b.node];assert(worker,'registered worker required');
 assert(!outsideCollateralPilot(s,b.node),'pilot support worker: bonded admissions are not open');
 assert(verify(b,a.ownerSignature,b.owner),'funding owner signature');assert(verify(b,a.workerSignature,worker.key),'worker funding consent');
 // A payment approval is not a collateral approval. Fail closed until the
 // separate protected-wallet collateral consent UI/contract is qualified.
 const protection=spendPolicy(s,b.owner);assert(!protection?.enabled&&!protection?.pending,'protected wallet collateral unsupported');
 assertOrdinaryOwner(s,b.owner);
 integer(b.sequence,1);const value=amount(b.valueMicro);assert(value>0n);
 assert(Array.isArray(b.inputs)&&b.inputs.length>0&&b.inputs.length<=8);b.inputs.forEach(hex);assert.deepEqual(b.inputs,[...new Set(b.inputs)].sort(),'canonical funding inputs');
 const prior=s.workerFunding?.accounts[b.node],digest=hash(b);
 if(prior){assert.equal(prior.owner,b.owner,'funding owner is fixed');if(b.sequence===prior.sequence){assert.equal(prior.lastBodyHash,digest,'conflicting funding replay');return s;}}
 assert(!prior?.release,'collateral release pending');
 assert.equal(b.sequence,(prior?.sequence??0)+1,'funding sequence');
 assert(prior||Object.keys(s.workerFunding?.accounts??{}).length<1024,'funding account capacity');
 const change=collateralChangeId(b);assert(!s.money.outputs[change],'funding output collision');
 let total=0n;for(const id of b.inputs){const o=s.money.outputs[id];assert(o&&o.owner===b.owner,'missing or foreign funding input');assert(o.unlock<=s.money.time,'funding input is locked');total+=amount(o.value);}
 assert(total>=value&&total<=MAX,'funding amount');const stake=amount(worker.stake)+value,deposited=amount(prior?.depositedMicro??'0')+value;assert(stake<=MAX&&deposited<=MAX,'collateral overflow');
 for(const id of b.inputs)delete s.money.outputs[id];
 if(total>value)s.money.outputs[change]={owner:b.owner,value:String(total-value),unlock:0};
 worker.stake=String(stake);
 const tracking=prior??{initialStakeMicro:String(stake-value-lockedSupport(s,b.node)),withdrawnMicro:'0',release:null,lastRelease:null};
 s.workerFunding={version:COLLATERAL_DOMAIN,accounts:{...s.workerFunding?.accounts,[b.node]:{...tracking,owner:b.owner,sequence:b.sequence,depositedMicro:String(deposited),lastBodyHash:digest}}};
 const pilot=s.centuryFunds?.zeroStage?.body;
 if(pilot?.settings.ramp==='TERMINAL_WEEK_V2' && pilot.workers.some(w=>w.node===b.node))activatePilotSupport(s,b.node,s.centuryFunds.support?.book.grants[b.node]);
 if(b.votingValidator)increaseVoting(b);
 auditWorkerFunding(s);return s;
}
// Reserve pre-existing stake conservatively. Losses consume the newly funded
// portion first; cumulative deposits are never proof that slashed money exists.
export function releasableCollateral(s,node){
 const a=s.workerFunding?.accounts[node],n=s.money.nodes[node];assert(a&&n&&Object.hasOwn(a,'initialStakeMicro'),'tracked funding provenance required');
 const held=amount(n.consensusHeld)+amount(n.taskHeld),protectedStake=amount(a.initialStakeMicro)+lockedSupport(s,node),floor=protectedStake>held?protectedStake:held;
 const free=amount(n.stake)>floor?amount(n.stake)-floor:0n,owned=amount(a.depositedMicro)-amount(a.withdrawnMicro);
 return free<owned?free:owned;
}
export function releaseWorkerCollateral(s,a,author){
 assert([QUEUE_RELEASE,CANCEL_RELEASE,EXECUTE_RELEASE].includes(a.type));
 assert.equal(s.money.unitScale,'1000000');assert(s.centuryFees,'qualified precision and fee policy required');
 assert(!s.money.liability||s.money.liability.policy.version>=2,'UTC liability required');
 if(a.type===EXECUTE_RELEASE){
  exact(a,['type','node','sequence']);hex(a.node);integer(a.sequence,1);const account=s.workerFunding?.accounts[a.node],n=s.money.nodes[a.node];assert(account&&n,'known funded worker');
  if(account.lastRelease?.sequence===a.sequence)return s;
  const p=account.release;assert(p&&p.sequence===a.sequence,'current release required');assert(s.money.time>=p.readyAt,'collateral cooldown');
  assert.equal(n.tier,'0','worker must remain drained');assert.equal(n.taskHeld,'0','outstanding payment collateral');
  assert(!Object.values(s.money.liability?.records??{}).some(r=>r.assignments.some(x=>x.node===a.node)),'unresolved liability');
  assert(amount(p.valueMicro)<=releasableCollateral(s,a.node),'collateral reduced or reserved');
  const output=collateralReleaseId(s.configHash,a.node,p.sequence);assert(!s.money.outputs[output],'release collision');
  n.stake=String(amount(n.stake)-amount(p.valueMicro));s.money.outputs[output]={owner:account.owner,value:p.valueMicro,unlock:0};
  account.withdrawnMicro=String(amount(account.withdrawnMicro)+amount(p.valueMicro));account.lastRelease={sequence:p.sequence,valueMicro:p.valueMicro,output};account.release=null;
  auditWorkerFunding(s);return s;
 }
 exact(a,['type','body','ownerSignature','workerSignature']);const b=a.body;
 exact(b,['domain','configHash','node','owner','sequence','issuedAt','expires',...(a.type===QUEUE_RELEASE?['valueMicro']:['releaseSequence'])]);
 assert.equal(b.domain,COLLATERAL_DOMAIN+'/'+a.type);assert.equal(b.configHash,s.configHash);hex(b.node);publicKey(b.owner);assert.equal(author,b.owner);
 const account=s.workerFunding?.accounts[b.node],n=s.money.nodes[b.node];assert(account&&n&&Object.hasOwn(account,'initialStakeMicro'),'tracked funding provenance required');assert.equal(b.owner,account.owner);
 assert(verify(b,a.ownerSignature,b.owner)&&verify(b,a.workerSignature,n.key),'release consent');
 integer(b.issuedAt,1);integer(b.expires,b.issuedAt+1);assert(b.expires-b.issuedAt<=600&&b.issuedAt<=s.money.time&&s.money.time<b.expires,'release UTC window');integer(b.sequence,1);
 if(b.sequence===account.sequence){assert.equal(account.lastBodyHash,hash(b),'conflicting collateral replay');return s;}
 assert.equal(b.sequence,account.sequence+1,'collateral sequence');
 if(a.type===QUEUE_RELEASE){
  assert(!account.release,'collateral release pending');const value=amount(b.valueMicro);assert(value>0n&&value<=amount(account.depositedMicro)-amount(account.withdrawnMicro),'owned funding limit');
  // Stop new assignments immediately. Existing receipts and penalties remain live.
  n.tier='0';const readyAt=s.money.time+Math.max(RELEASE_DELAY_SECONDS,s.money.liability?.policy.challengeSeconds??0);integer(readyAt,1);
  account.release={sequence:b.sequence,valueMicro:b.valueMicro,queuedAt:s.money.time,readyAt};
 }else{integer(b.releaseSequence,1);assert.equal(account.release?.sequence,b.releaseSequence,'current release required');account.release=null;}
 account.sequence=b.sequence;account.lastBodyHash=hash(b);auditWorkerFunding(s);return s;
}
