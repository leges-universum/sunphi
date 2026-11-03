import {createHash,generateKeyPairSync,createPrivateKey,createPublicKey,sign as signRaw,verify as verifyRaw} from 'node:crypto';
import assert from 'node:assert/strict';
export function canonical(v){
 if(v===null||typeof v==='boolean'||typeof v==='string')return JSON.stringify(v);
 if(typeof v==='number'){assert(Number.isSafeInteger(v),'integer required');return String(v);}
 if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
 assert(v&&Object.getPrototypeOf(v)===Object.prototype,'plain value required');
 return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
}
export const hash=v=>createHash('sha256').update(canonical(v)).digest('hex');
export const digest=b=>createHash('sha256').update(b).digest('hex');
export function keys(){const k=generateKeyPairSync('ed25519');return {publicKey:k.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64url'),privateKey:k.privateKey.export({format:'der',type:'pkcs8'}).toString('base64url')};}
export function publicKey(raw){assert(typeof raw==='string'&&/^[A-Za-z0-9_-]{43}$/.test(raw)&&Buffer.from(raw,'base64url').toString('base64url')===raw);return createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(raw,'base64url')]),format:'der',type:'spki'});}
export function sign(body,secret){return signRaw(null,Buffer.from(canonical(body)),createPrivateKey({key:Buffer.from(secret,'base64url'),format:'der',type:'pkcs8'})).toString('base64url');}
export function verify(body,sig,key){try{return typeof sig==='string'&&/^[A-Za-z0-9_-]{86}$/.test(sig)&&Buffer.from(sig,'base64url').toString('base64url')===sig&&verifyRaw(null,Buffer.from(canonical(body)),publicKey(key),Buffer.from(sig,'base64url'));}catch{return false;}}
export function exact(v,fields){assert(v&&Object.getPrototypeOf(v)===Object.prototype,'object');assert.deepEqual(Object.keys(v).sort(),[...fields].sort(),'exact fields');}
export const integer=(x,min=0)=>{assert(Number.isSafeInteger(x)&&x>=min,'integer bound');return x;};
export const hex=x=>{assert(typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),'hash');return x;};
