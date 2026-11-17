// Portable review metadata. This never grants network or payment permissions.
export const SOURCE_APP='696e4a5c63b67ccaefee6b6a';
export const DUEBYTE_APP='6ad28d53b17239869dc68f72';
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const need=(v,m)=>{if(!v)throw Error(m);};
const text=(v,max,required=true)=>{need(typeof v==='string'&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v),'Invalid review text');v=v.trim();need(!required||v.length>0,'Review details required');return v;};
export const normalize=v=>String(v??'').normalize('NFKC').trim().replace(/\s+/g,' ').toUpperCase();
export function countryCode(value){
 const v=normalize(value);if(/^[A-Z]{2}$/.test(v))return v;
 const names=new Intl.DisplayNames(['en'],{type:'region'});
 for(let a=65;a<=90;a++)for(let b=65;b<=90;b++){const code=String.fromCharCode(a,b);if(normalize(names.of(code))===v)return code;}
 throw Error('Use the same ISO country code in both company registrations.');
}
export function companyIdentity(c){return {name:normalize(c.company_name),country:countryCode(c.registration_country),number:normalize(c.registration_number).replace(/[\s-]/g,''),owner:String(c.owner_id??'')};}
export const sameIdentity=(a,b)=>!!a&&!!b&&['name','country','number','owner'].every(k=>a[k]===b[k]);
export function sameCompany(identity,profile){return identity.name===normalize(profile.legalName)&&identity.country===profile.country&&identity.number===normalize(profile.registrationNumber).replace(/[\s-]/g,'');}
export function reviewInput(value,company,now=Date.now()){
 const v=value??{};need(typeof v==='object'&&!Array.isArray(v),'Invalid review');
 need(Object.keys(v).every(k=>['lawyer','reviewer','organization','reference','companyRecords','representativeAuthority','subjectName','authorityScope','validUntil'].includes(k)),'Unexpected review fields');
 need(typeof v.lawyer==='boolean'&&typeof v.companyRecords==='boolean'&&typeof v.representativeAuthority==='boolean','Select the review scope');
 need(v.companyRecords||v.representativeAuthority,'Select the review scope');
 const lawyer=v.lawyer,rep=v.representativeAuthority;
 const validUntil=v.validUntil?new Date(v.validUntil).toISOString():null;
 need(!validUntil||Date.parse(validUntil)>now,'Validity must end in the future');
 return {lawyer,reviewer:text(v.reviewer??'',160,lawyer),organization:text(v.organization??'',180,lawyer),reference:text(v.reference??'',160,lawyer),companyRecords:v.companyRecords,representativeAuthority:rep,subjectName:rep?text(v.subjectName??'',160):null,authorityScope:text(v.authorityScope??'',300,rep),subjectAccount:rep?text(company.owner_id,80):null,validUntil};
}
 export function portableReview({review,company,link,targetProfile,now=Date.now()}){
 const base={source:'Sun-Phi',checkedAt:new Date(now).toISOString(),status:'unconfirmed',companyReviewed:false,representativeReviewed:false,lawyer:false};
 if(!link||link.status!=='confirmed')return {...base,status:'not_linked'};
 const current=companyIdentity(company);
 if(!sameIdentity(current,link.identity))return {...base,status:'identity_changed'};
 if(!targetProfile||!sameCompany(current,targetProfile))return {...base,status:'identity_changed'};
 if(company.status==='suspended'||company.verification_status!=='verified')return {...base,status:'not_verified'};
 if(!review)return {...base,status:'admin_verified',companyReviewed:true};
 if(review.status!=='verified')return {...base,status:'revoked'};
 if(!sameIdentity(current,review.identity))return {...base,status:'review_required'};
 const r=review.detail;
 if(r.validUntil&&Date.parse(r.validUntil)<=now)return {...base,status:'expired'};
 const representativeReviewed=!!(r.representativeAuthority&&r.subjectAccount===link.source_account&&r.subjectName&&normalize(r.subjectName)===normalize(targetProfile.representative));
 if(!r.companyRecords&&!representativeReviewed)return {...base,status:'review_required'};
 return {...base,status:r.lawyer?'lawyer_reviewed':'admin_verified',lawyer:r.lawyer,companyReviewed:r.companyRecords,representativeReviewed,authorityScope:representativeReviewed?r.authorityScope:null,reviewer:r.reviewer,organization:r.organization,reference:r.reference,reviewedAt:review.reviewed_at,validUntil:r.validUntil,revision:review.revision};
}
