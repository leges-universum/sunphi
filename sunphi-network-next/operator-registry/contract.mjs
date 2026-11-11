// Shared browser / worker contract. Application signatures never authorize payments.
export const NETWORK='duebyte-trial-lab-1793721064315';
export const DOMAIN='DUEBYTE_OPERATOR_APPLICATION_V1';
export const TERMS='duebyte-operator-rules-2026-11-03';
export function need(ok,message){if(!ok)throw Error(message);}
export function canonical(v){if(v===null||typeof v==='boolean'||typeof v==='string')return JSON.stringify(v);if(Number.isSafeInteger(v))return String(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';need(v&&Object.getPrototypeOf(v)===Object.prototype,'Invalid object');return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';}
export const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
export const bytes=s=>Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
export async function hash(v){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(v))))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export async function verify(body,signature,key){try{need(/^[A-Za-z0-9_-]{43}$/.test(key)&&/^[A-Za-z0-9_-]{86}$/.test(signature),'Invalid signature');const k=await crypto.subtle.importKey('raw',bytes(key),'Ed25519',false,['verify']);return await crypto.subtle.verify('Ed25519',k,bytes(signature),new TextEncoder().encode(canonical(body)));}catch{return false;}}
export async function sign(body,key){return b64(await crypto.subtle.sign('Ed25519',key,new TextEncoder().encode(canonical(body))));}
const text=(v,max,min=1)=>{need(typeof v==='string'&&v.length<=max&&v.trim().length>=min&&!/[\x00-\x1f\x7f]/.test(v),'Invalid text field');return v.trim();};
const exact=(v,names)=>need(v&&Object.keys(v).sort().join('|')===names.sort().join('|'),'Unexpected fields');
export function applicationBody(input,key,now=Date.now()){
 const country=text(input.country,2).toUpperCase();need(/^[A-Z]{2}$/.test(country),'Use an ISO country code');
 need(['company','sole_trader'].includes(input.kind),'Registered company or sole trader required');
 const website=text(input.website??'',300,0);if(website){const u=new URL(website);need(u.protocol==='https:'&&!u.username&&!u.password,'Use an HTTPS website');}
 const email=text(input.email,200).toLowerCase();need(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'Enter a contact email');
 const profile={kind:input.kind,country,jurisdiction:text(input.jurisdiction??'',100,0),legalName:text(input.legalName,180),registrationNumber:text(input.registrationNumber,80),registerName:text(input.registerName,160),website,representative:text(input.representative,160),capacity:text(input.capacity,160),email,commonControl:text(input.commonControl,2000)};
 need(input.consent===true&&input.terms===true,'Accept the disclosure and operator rules');
 return {domain:DOMAIN,network:NETWORK,terms:TERMS,operatorKey:key,created:now,profile,consent:true};
}
export async function validateApplication(packet,now=Date.now()){
 exact(packet,['body','signature']);const b=packet.body;
 need(JSON.stringify(packet).length<=12000,'Application too large');
 exact(b,['domain','network','terms','operatorKey','created','profile','consent']);
 need(Number.isSafeInteger(b.created)&&b.created<=now+60000&&b.created>=now-86400000,'Application expired');
 need(canonical(b)===canonical(applicationBody({...b.profile,consent:b.consent,terms:true},b.operatorKey,b.created)),'Application contract mismatch');
 need(await verify(b,packet.signature,b.operatorKey),'Application signature invalid');
 return {requestHash:await hash(packet),entityKey:await hash({country:b.profile.country,jurisdiction:b.profile.jurisdiction.normalize('NFKC').toUpperCase(),register:b.profile.registerName.normalize('NFKC').toUpperCase(),number:b.profile.registrationNumber.normalize('NFKC').replace(/[\s-]/g,'').toUpperCase()}),operatorKey:b.operatorKey};
}
export async function validateAction(packet,action,now=Date.now()){
 exact(packet,['body','signature']);const b=packet.body;
 need(b?.domain==='DUEBYTE_OPERATOR_ACTION_V1'&&b.network===NETWORK&&b.action===action,'Invalid action');
 need(Number.isSafeInteger(b.created)&&Math.abs(now-b.created)<=300000,'Action expired');
 need(/^[0-9a-f-]{36}$/.test(b.id)&&/^[a-f0-9]{32}$/.test(b.nonce),'Invalid action reference');
 need(await verify(b,packet.signature,b.operatorKey),'Action signature invalid');return b;
}
