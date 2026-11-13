// Preparation only. No issuance, clock start, unlock, or payment execution.
import assert from 'node:assert/strict';
import {auditWorkerSupport} from './worker-support.mjs';
import {guardSupportPayment} from './support-accounting.mjs';
import {controllerContext,ownedOutputs} from './controller-context.mjs';
import {exact,hash,hex,integer,publicKey,verify} from './crypto.mjs';
import {quorum} from './authority.mjs';
import {validateRecovery,developmentManager} from './reserve-recovery.mjs';
import {memorialAware,centuryWarmupAccounts} from './economic-policy-v3.mjs';
import {datedCumulative} from './economic-policy-v2.mjs';
import {auditCenturyIssuance} from './century-issuance.mjs';
export const CENTURY_FUNDS_ACTION='PREPARE_CENTURY_FUNDS_V1';
const address=(configHash,role)=>Buffer.from(hash({domain:CENTURY_FUNDS_ACTION,configHash,role}),'hex').toString('base64url');
export const centuryRestrictedAccounts=configHash=>[address(configHash,'development'),address(configHash,'founder-vesting')];
export function centuryFundsManifest(s,founderRecipient){
 const e=s.economicPreparation;assert(memorialAware(e?.plan.version));publicKey(founderRecipient);
 const access=s.networkReserves?.development.access;assert(access&&!access.pending,'stable recovery custody required');validateRecovery(access.recovery);
 assert(founderRecipient!==access.manager&&!access.recovery.keys.includes(founderRecipient),'separate reward recipient from reserve custody');
 return {version:CENTURY_FUNDS_ACTION,configHash:s.configHash,planHash:e.planHash,issuanceEnabled:false,emissionStart:null,warmupStart:null,
  warmup:{totalMicro:e.plan.warmupMicro,accounts:centuryWarmupAccounts(s.configHash),privateKeys:false,years:5,firstTwoYearsMicro:String(BigInt(e.plan.warmupMicro)/2n),unused:'LOCKED_AFTER_YEAR_FIVE'},
  development:{totalMicro:e.plan.developmentMicro,account:address(s.configHash,'development'),benefit:'DUEBYTE_AND_SUN_PHI',vestingYears:10,firstUnlockAnniversary:1,annualUnlockMicro:String(BigInt(e.plan.developmentMicro)/10n)},
  founder:{totalMicro:e.plan.founderMicro,account:address(s.configHash,'founder-vesting'),recipient:founderRecipient,vestingYears:10,firstUnlockAnniversary:1,annualUnlockMicro:String(BigInt(e.plan.founderMicro)/10n)},
  memorial:{totalMicro:e.plan.memorialMicro,account:e.plan.memorial.account,ordinarySpending:false},
  management:{manager:developmentManager(s.networkReserves),epoch:access.epoch,recovery:structuredClone(access.recovery)}};
}
export function applyCenturyFunds(base,a,c){
 assert(!base.centuryFunds?.execution,'issued fund terms are immutable');
 exact(a,['type','certificate','founderConsent','recipientConsent']);assert.equal(a.type,CENTURY_FUNDS_ACTION);
 exact(a.certificate,['body','approvals']);const b=a.certificate.body;
 exact(b,['domain','network','configHash','generation','notBefore','expires','manifest','previousManifestHash']);assert.equal(b.domain,CENTURY_FUNDS_ACTION);
 assert.equal(b.network,c.chainId);assert.equal(b.configHash,base.configHash);assert.equal(b.generation,base.authority.generation);
 integer(b.notBefore,1);integer(b.expires,b.notBefore);assert(b.expires-b.notBefore<=100&&base.height>=b.notBefore&&base.height<=b.expires,'fund preparation window');
 quorum(b,a.certificate.approvals,base.authority.validators,7);
 assert.deepEqual(b.manifest,centuryFundsManifest(base,b.manifest.founder.recipient),'fund terms or custody changed');
 assert(verify(b,a.founderConsent,developmentManager(base.networkReserves)),'founder fund preparation consent');
 assert(verify(b,a.recipientConsent,b.manifest.founder.recipient),'founder reward recipient possession');
 const certificateHash=hash(a.certificate);
 if(base.centuryFunds?.certificateHash===certificateHash)return base;
 assert.equal(b.previousManifestHash,base.centuryFunds?.manifestHash??null,'previous fund preparation');
 const s={...base};s.centuryFunds={manifest:b.manifest,manifestHash:hash(b.manifest),certificateHash,preparedHeight:s.height,previousManifestHash:b.previousManifestHash};auditCenturyFunds(s);return s;
}
export function centuryFundsReadiness(s){
 const f=s.centuryFunds;if(!f)return {prepared:false,issuanceEnabled:false};
 auditCenturyFunds(s);const a=s.networkReserves.development.access,m=f.manifest.management;
 return {prepared:true,issuanceEnabled:false,managementCurrent:!a.pending&&a.epoch===m.epoch&&a.manager===m.manager&&hash(a.recovery)===hash(m.recovery),
  funded:Boolean(f.execution),backupIndependenceProven:false,launchAuthorizationRequired:!f.execution};
}
export function centuryFundAllowance(s,kind,{start,at}){
 auditCenturyFunds(s);assert(s.centuryFunds);assert(['warmup','development','founder'].includes(kind));
 // A preview requires an explicit hypothetical start. It never starts a clock.
 integer(start,1);integer(at);return datedCumulative({start,at,kind});
}
export function checkCenturyFundsPayment(s,intent){
 guardSupportPayment(s,intent);
 // Reserve deterministic custody before preparation: unsolicited dust must not
 // prevent a future signed allocation or create an apparent vested balance.
 const accounts=[address(s.configHash,'development'),address(s.configHash,'founder-vesting')];
 assert(!accounts.includes(intent.sender)&&!accounts.includes(intent.recipient),'prepared fund custody cannot use ordinary payments');
}
export function auditCenturyFunds(s){
 const f=s.centuryFunds;if(!f)return;exact(f,['manifest','manifestHash','certificateHash','preparedHeight','previousManifestHash',...(f.execution?['execution']:[]),...(f.support?['support']:[])]);if(f.previousManifestHash!==null)hex(f.previousManifestHash);hex(f.certificateHash);assert.equal(hash(f.manifest),f.manifestHash);integer(f.preparedHeight);assert(f.preparedHeight<=s.height);
 const m=f.manifest;validateRecovery(m.management.recovery);publicKey(m.management.manager);integer(m.management.epoch);assert(!m.management.recovery.keys.includes(m.management.manager));
 // Reconstruct immutable terms with the historical custody snapshot. A later
 // legitimate manager recovery makes preparation stale, never halts consensus.
 const view={...s,networkReserves:{...s.networkReserves,development:{...s.networkReserves.development,access:{...s.networkReserves.development.access,...m.management,pending:null}}}};
 assert.deepEqual(m,centuryFundsManifest(view,m.founder.recipient));
 const accounts=[m.development.account,m.founder.account];assert(new Set([...accounts,...m.warmup.accounts,m.memorial.account]).size===5);
 if(!f.execution)for(const owner of accounts)assert.equal(ownedOutputs(s.money,owner).length,0,'fund allocation still unissued');
 if(!controllerContext(s))for(const r of Object.values(s.money.requests))checkCenturyFundsPayment(s,r.intent);
 auditCenturyIssuance(s);
 auditWorkerSupport(s);
}
