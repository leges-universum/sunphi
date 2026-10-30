// Public control-plane certificates. These never issue or move money.
import { sign } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { canonical,digest,exact } from './protocol.mjs';
const domain='sunphi-isolated-key-rotation/1';
const hex=(s,n)=>typeof s==='string'&&new RegExp(`^[0-9a-f]{${n}}$`).test(s);
const positive=n=>Number.isSafeInteger(n)&&n>0;
const checkedKeys=new Map();
export function validateSigningKey(s){
  if(!hex(s,64))throw new Error('invalid key encoding');
  if(checkedKeys.has(s))return;
  const p=ed25519.Point.fromBytes(Buffer.from(s,'hex'),false);
  if(p.isSmallOrder()||!p.isTorsionFree()||Buffer.from(p.toBytes()).toString('hex')!==s)throw new Error('invalid signing subgroup');
  checkedKeys.set(s,true);if(checkedKeys.size>128)checkedKeys.delete(checkedKeys.keys().next().value);
}
export const rawPublicKey=k=>k.export({format:'der',type:'spki'}).subarray(-32).toString('hex');
export function rotationMessage(body,purpose){return Buffer.from(canonical({domain,purpose,body}));}
export const signRotation=(body,purpose,key)=>sign(null,rotationMessage(body,purpose),key).toString('hex');
function signed(key,body,purpose,sig){
  validateSigningKey(key);
  if(!hex(sig,128)||!ed25519.verify(Buffer.from(sig,'hex'),rotationMessage(body,purpose),Buffer.from(key,'hex'),{zip215:false}))throw new Error('invalid rotation signature');
}
export function initialGovernance(config){
  exact(config,['version','members']);
  if(config.version!==1||!Array.isArray(config.members)||config.members.length!==10)throw new Error('10 equal validator seats required');
  const all=[];
  const members=config.members.map((m,i)=>{
    exact(m,['slot','key','recovery']);
    if(m.slot!==i||!hex(m.key,64)||!hex(m.recovery,64))throw new Error('invalid validator identity');
    validateSigningKey(m.key);validateSigningKey(m.recovery);
    all.push(m.key,m.recovery);return {...m,generation:0};
  });
  if(new Set(all).size!==20)throw new Error('validator and recovery keys must be independent');
  return {version:1,members,usedKeys:members.map(m=>m.key).sort(),pending:null,changes:0};
}
export function activateGovernance(g,height){
  if(!g?.pending)return g;
  if(height<g.pending.activation)return g;
  if(height!==g.pending.activation)throw new Error('missed validator activation');
  const next=structuredClone(g),p=next.pending;
  next.members[p.slot].key=p.newKey;next.members[p.slot].generation++;
  next.pending=null;next.changes++;return next;
}
export function acceptRotation(g,certificate,{chainId,genesis,height}){
  if(!positive(height))throw new Error('invalid rotation height');
  if(!g||g.pending)throw new Error('rotation unavailable or already pending');
  exact(certificate,['body','proofOfPossession','consent','approvals']);
  const b=certificate.body;
  exact(b,['chainId','genesis','slot','generation','oldKey','newKey','kind','notBefore','expires']);
  if(b.chainId!==chainId||b.genesis!==genesis||!Number.isSafeInteger(b.slot)||b.slot<0||b.slot>9||
    !Number.isSafeInteger(b.generation)||!hex(b.oldKey,64)||!hex(b.newKey,64)||
    !['rotate','recover'].includes(b.kind)||!positive(b.notBefore)||!positive(b.expires)||
    b.expires<b.notBefore||b.expires-b.notBefore>100||height<b.notBefore||height>b.expires)throw new Error('invalid rotation context');
  const m=g.members[b.slot];
  if(m.key!==b.oldKey||m.generation!==b.generation||g.usedKeys.includes(b.newKey)||g.members.some(x=>x.recovery===b.newKey))throw new Error('stale generation or reused key');
  signed(b.newKey,b,'possession',certificate.proofOfPossession);
  signed(b.kind==='recover'?m.recovery:m.key,b,'consent',certificate.consent);
  if(!Array.isArray(certificate.approvals)||certificate.approvals.length<7||certificate.approvals.length>10)throw new Error('7 distinct approvals required');
  let last=-1;
  for(const a of certificate.approvals){
    exact(a,['slot','signature']);
    if(!Number.isSafeInteger(a.slot)||a.slot<=last||a.slot>9)throw new Error('approvals must be unique and sorted');
    signed(g.members[a.slot].key,b,'approve',a.signature);last=a.slot;
  }
  const next=structuredClone(g);
  // CometBFT updates returned at H sign blocks starting at H+2.
  next.pending={slot:b.slot,newKey:b.newKey,activation:height+2,certificate:digest(certificate)};
  next.usedKeys.push(b.newKey);next.usedKeys.sort();
  return {governance:next,updates:[{key:b.oldKey,power:0},{key:b.newKey,power:10}]};
}
export function isRotation(raw){return raw.subarray(0,4).toString()==='SRK3';}
export function encodeRotation(certificate){
  const b=Buffer.from('SRK3'+canonical(certificate));if(b.length>16000)throw new Error('rotation size');return b;
}
export function decodeRotation(raw){
  if(!isRotation(raw)||raw.length>16000)throw new Error('rotation frame');
  const text=raw.subarray(4).toString('utf8'),c=JSON.parse(text);
  if(canonical(c)!==text)throw new Error('noncanonical rotation');return c;
}
