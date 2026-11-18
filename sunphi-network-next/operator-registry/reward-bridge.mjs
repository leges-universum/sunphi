// Trusted backend adapter. Never accept evidence, source revision or signing keys
// from an end-user request. Existing canonical reviews are the source of truth.
import {need,hash} from './contract.mjs';
import {sameIdentity,sameCompany,companyIdentity,normalize} from './verification-contract.mjs';
export const REWARD_STATUS='SET_OPERATOR_REWARD_STATUS_V1';
export const REWARD_LINK='LINK_OPERATOR_REWARD_PROFILE_V1';
const DAY=86400;
const utc=t=>Math.floor(t/DAY)*DAY;
const seconds=v=>Math.floor(Date.parse(v)/1000);
export async function operatorReference(application){return hash({domain:'DUEBYTE_OPERATOR_REFERENCE_V1',application:application.id,operatorKey:application.operator_key});}
export async function publicProfileHash(application){const p=application.submission?.body?.profile;need(p,'Public registration required');return hash({kind:p.kind,country:p.country,legalName:p.legalName,registrationNumber:p.registrationNumber,representative:p.representative,commonControl:p.commonControl});}
export function legalReviewUntil({application,link,review,company,now}){
 const p=application?.submission?.body?.profile,r=review?.detail;
 if(!company||company.id!==link?.company_id||company.status==='suspended'||company.verification_status!=='verified')return 0;
 let identity;try{identity=companyIdentity(company);}catch{return 0;}
 if(!sameIdentity(identity,link?.identity))return 0;
 if(!p||link?.status!=='confirmed'||link.application_id!==application.id||review?.company_id!==link.company_id||review.status!=='verified'||!sameIdentity(review.identity,link.identity)||!sameCompany(review.identity,p))return 0;
 if(r?.lawyer!==true||r.companyRecords!==true||r.representativeAuthority!==true||r.subjectAccount!==link.source_account||normalize(r.subjectName)!==normalize(p.representative))return 0;
 if(!['reviewer','organization','reference','authorityScope'].every(k=>typeof r[k]==='string'&&r[k].trim().length>0))return 0;
 const at=seconds(review.reviewed_at);if(!Number.isSafeInteger(at)||at<=0||at>now)return 0;
 const year=new Date(at*1000);year.setUTCFullYear(year.getUTCFullYear()+1);
 const explicit=r.validUntil?seconds(r.validUntil):Infinity,end=Math.min(Math.floor(year.getTime()/1000),explicit);
 if(!Number.isFinite(end)||end<=now)return 0;return utc(end);
}
export async function rewardEvidence({application,account,link,review,company,now}){
 need(Number.isSafeInteger(now)&&now>0,'Verified time required');
 const p=application?.submission?.body?.profile;
 const registered=!!(application?.id&&account?.operator_key===application.operator_key&&account.account_id&&p&&p.legalName?.trim()&&p.representative?.trim()&&p.commonControl?.trim()&&!['rejected','revoked'].includes(application.decision));
 if(!registered)return {registered:false,legalUntil:0,reviewedAt:0};
 const legalUntil=legalReviewUntil({application,link,review,company,now});
 return {registered:true,operator:await operatorReference(application),profileHash:await publicProfileHash(application),legalUntil,reviewedAt:legalUntil?seconds(review.reviewed_at):0};
}
export async function loadRewardEvidence({db,readCompany,applicationId,now}){
 need(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(applicationId),'Invalid application reference');
 const a=(await db('duebyte_operator_applications?id=eq.'+applicationId+'&select=id,operator_key,submission,decision,revision&limit=1'))[0];if(!a)return {registered:false,legalUntil:0,reviewedAt:0};
 const account=(await db('duebyte_operator_accounts?operator_key=eq.'+encodeURIComponent(a.operator_key)+'&select=account_id,operator_key&limit=1'))[0];
 const links=await db('sunphi_duebyte_company_links?application_id=eq.'+applicationId+'&status=eq.confirmed&select=application_id,company_id,source_account,identity,status&limit=2');need(links.length<=1,'Ambiguous verification link');
 const link=links[0],review=link?(await db('sunphi_company_reviews?company_id=eq.'+encodeURIComponent(link.company_id)+'&select=company_id,identity,status,detail,reviewed_at,revision&limit=1'))[0]:null;
 // The source service must check its CURRENT company entity as well as the
 // canonical review. An old review cannot survive changed ownership/suspension.
 // A source outage throws; it is not an authenticated revocation.
 const company=link?await readCompany(link.company_id):null;
 return rewardEvidence({application:a,account,link,review,company,now});
}
export async function prepareRewardCredential({view,configHash,evidence,issuer,sign}){
 need(view.kind==='worker'&&view.policy,'Active Linux reward policy required');
 const now=view.time,day=Math.ceil((now+1)/DAY)*DAY,old=view.status?.pending;
 const effectiveFrom=old&&old.effectiveFrom>now?old.effectiveFrom:Math.max(day,view.policy.effectiveFrom);
 const record=view.link,consent=record?(record.pending.effectiveFrom<=effectiveFrom?record.pending:record.current):null;
 const registered=evidence.registered&&consent&&consent.operator===evidence.operator&&consent.profileHash===evidence.profileHash&&consent.validUntil>=effectiveFrom+DAY;
 if(!registered&&!old)return {status:'LINK_REQUIRED',action:null};
 const registeredUntil=registered?Math.min(consent.validUntil,utc(now+366*DAY)):0;
 const legalUntil=registered&&consent.automaticLegalUpdates&&evidence.legalUntil>=effectiveFrom+DAY?Math.min(evidence.legalUntil,registeredUntil):0;
 const b={domain:REWARD_STATUS,configHash,node:view.node,operator:registered?evidence.operator:old.operator,profileHash:registered?evidence.profileHash:old.profileHash,sequence:(view.status?.sequence??0)+1,effectiveFrom,registeredUntil,legalUntil,reviewedAt:legalUntil?evidence.reviewedAt:0,sourceRevision:(old?.sourceRevision??0)+1,issuer};
 const same=old&&['operator','profileHash','registeredUntil','legalUntil','reviewedAt'].every(k=>old[k]===b[k]);if(same)return {status:'UNCHANGED',action:null};
 // Do not queue a new promotion over an uncommitted UTC-day promotion.
 if(old&&old.effectiveFrom>now&&!(b.operator===old.operator&&b.profileHash===old.profileHash&&b.registeredUntil<=old.registeredUntil&&b.legalUntil<=old.legalUntil&&(b.reviewedAt===0||b.reviewedAt===old.reviewedAt)))return {status:'WAITING_BOUNDARY',action:null};
 const authorized=view.policy.pendingAuthority&&now>=view.policy.pendingAuthority.effectiveFrom?view.policy.pendingAuthority.issuers:view.policy.issuers;
 need(authorized.includes(issuer),'Unapproved reward issuer');
 return {status:'READY',action:{type:REWARD_STATUS,credential:b,issuerSignature:await sign(b),nodeSignature:null}};
}
// One bounded work item. The caller supplies durable atomic compare-and-set
// storage and a consensus-verified reader. Lost acknowledgement resends the SAME
// signed action. Conflicting source revisions trigger a fresh read, not a raise.
export async function reconcileRewardCredential({node,readVerified,evidence,outbox,issuer,configHash,sign,broadcast}){
 const view=await readVerified(node);need(view.node===node,'Node proof mismatch');
 const saved=await outbox.get(node);
 if(saved){const current=view.status;if(current?.lastHash===await hash(saved.credential)){await outbox.clear(node,saved);return {status:'CONFIRMED',sequence:current.sequence};}
  if((current?.sequence??0)>=saved.credential.sequence){await outbox.clear(node,saved);return {status:'RECHECK_SOURCE'};}
  // A missed UTC boundary cannot be repaired by repeatedly sending a now
  // retroactive credential. Rebuild from fresh evidence and a new full day.
  if(view.time>=saved.credential.effectiveFrom){await outbox.clear(node,saved);return {status:'RECHECK_SOURCE'};}
  const fresh=await evidence(node,view.time),check=await prepareRewardCredential({view,configHash,evidence:fresh,issuer,sign});
  const fields=['operator','profileHash','registeredUntil','legalUntil','reviewedAt','issuer'];
  if(!check.action||fields.some(k=>check.action.credential[k]!==saved.credential[k])){await outbox.clear(node,saved);return {status:'RECHECK_SOURCE'};}
  const r=await broadcast(saved);return {status:r?.accepted?'SUBMITTED':'RETRYING'};
 }
 const fresh=await evidence(node,view.time),prepared=await prepareRewardCredential({view,configHash,evidence:fresh,issuer,sign});if(!prepared.action)return {status:prepared.status};
 need(await outbox.putIfAbsent(node,prepared.action),'Concurrent credential preparation');
 const r=await broadcast(prepared.action);return {status:r?.accepted?'SUBMITTED':'RETRYING'};
}
