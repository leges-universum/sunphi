// Browser-owned keys. Only encrypted backups may leave this device.
// Shared contract uses WebCrypto and contains no server credential.
import{b64,bytes,canonical,sign,hash,verify}from'./approval-crypto.mjs';
import{paymentDisplay}from'./payment-amounts.mjs';
const encoder=new TextEncoder();
async function passwordKey(password,salt,usage){
 if(typeof password!=='string'||password.length<12||password.length>1024)throw Error('Use an approval password of at least 12 characters.');
 const raw=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:600000,hash:'SHA-256'},raw,{name:'AES-GCM',length:256},false,[usage]);
}
export async function sealDevice(material,password){
 const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),key=await passwordKey(password,salt,'encrypt');
 const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode('DUEBYTE_APPROVAL_DEVICE_V1')},key,encoder.encode(canonical(material)));
 return{version:1,kdf:'PBKDF2-SHA256',iterations:600000,salt:b64(salt),iv:b64(iv),ciphertext:b64(ciphertext)};
}
export async function openDevice(vault,password){
 if(!vault||vault.version!==1||vault.kdf!=='PBKDF2-SHA256'||vault.iterations!==600000||typeof vault.ciphertext!=='string'||vault.ciphertext.length>16000)throw Error('Invalid approval backup.');
 const salt=bytes(vault.salt),iv=bytes(vault.iv);if(salt.length!==16||iv.length!==12)throw Error('Invalid approval backup.');
 const key=await passwordKey(password,salt,'decrypt');
 const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:encoder.encode('DUEBYTE_APPROVAL_DEVICE_V1')},key,bytes(vault.ciphertext));
 return JSON.parse(new TextDecoder().decode(clear));
}
async function pair(){const key=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);return{publicKey:b64(await crypto.subtle.exportKey('raw',key.publicKey)),privateKey:b64(await crypto.subtle.exportKey('pkcs8',key.privateKey))};}
const importPrivate=k=>crypto.subtle.importKey('pkcs8',bytes(k.privateKey),'Ed25519',false,['sign']);
export async function createDevice(context,password){
 const {wallet,network,configHash}=context.request.body,approver=await pair(),recovery=await pair();
 const material={domain:'DUEBYTE_APPROVAL_DEVICE_V1',wallet,network,configHash,approver};
 return{material,recovery,device:await sealDevice(material,password),backup:await sealDevice({...material,recovery},password)};
}
export async function deviceDecision(context,material,{decision='approve',recovery=null}={}){
 const q=context.request.body;if(await hash(context.request)!==context.id||!await verify(q,context.request.signature,q.wallet)||q.domain!=='DUEBYTE_SUNPHI_APPROVAL_TRANSPORT_V1/REQUEST')throw Error('The wallet request signature could not be verified.');
 if(Math.floor(Date.now()/1000)>=q.expires)throw Error('This approval request has expired.');
 if(material.domain!=='DUEBYTE_APPROVAL_DEVICE_V1'||material.wallet!==q.wallet||material.network!==q.network||material.configHash!==q.configHash)throw Error('This approval key belongs to another wallet or network.');
 if(context.policy&&context.policy.approver!==material.approver.publicKey)throw Error('This device is not the current approval device.');
 const key=await importPrivate(material.approver),result={request:context.id,decision,body:null,signatures:{approver:null,current:null,recovery:null}};
 if(decision==='reject'){result.signatures.approver=context.policy?await sign({domain:'DUEBYTE_SUNPHI_APPROVAL_TRANSPORT_V1/REJECT',request:context.id},key):null;return result;}
 if(decision!=='approve')throw Error('Unknown decision.');
 if(q.kind==='payment'){
  const i=q.payload.intent,b=q.payload.approval;paymentDisplay(i);
  if(i.sender!==q.wallet||b.domain!=='DUEBYTE_SPEND_PROTECTION_V1/PAYMENT'||
     b.configHash!==q.configHash||b.wallet!==q.wallet||b.policyVersion!==context.policy?.version||
     b.intentHash!==await hash(i)||!Number.isSafeInteger(b.issuedAt)||!Number.isSafeInteger(b.expires)||
     b.issuedAt>Math.floor(Date.now()/1000)+30||b.expires<=Math.floor(Date.now()/1000)||
     b.expires>b.issuedAt+600||b.expires>q.expires)
   throw Error('Approval does not match the displayed payment.');
  result.body=b;result.signatures.approver=await sign(result.body,key);return result;
 }
 if(q.kind!=='policy')throw Error('Unknown request.');
 const recoveryKey=context.policy?.recovery??recovery?.publicKey;if(!recoveryKey)throw Error('Save the recovery backup before enabling approval.');
 result.body={domain:'DUEBYTE_SPEND_PROTECTION_V1/SET_SPEND_POLICY_V1',configHash:q.configHash,wallet:q.wallet,version:q.payload.version,issuedAt:q.issuedAt,expires:q.expires,policy:{version:q.payload.version,enabled:q.payload.enabled,approver:material.approver.publicKey,recovery:recoveryKey,recoveryDelay:q.payload.recoveryDelay}};
 result.signatures.approver=await sign(result.body,key);if(context.policy)result.signatures.current=result.signatures.approver;else result.signatures.recovery=await sign(result.body,await importPrivate(recovery));return result;
}
