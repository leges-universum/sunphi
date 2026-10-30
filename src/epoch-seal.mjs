// Experimental bounded key-evolving checkpoint wrapper, NOT LMS/XMSS, not a
// replacement for CometBFT signing. Past-key protection assumes erased old seeds.
import { createHash,randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { canonical,digest,exact } from './protocol.mjs';
import { validateSigningKey } from './rotation.mjs';
export const ZERO='0'.repeat(64);
export const isHash=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
const hashBytes=(domain,b)=>createHash('sha256').update(domain).update(b).digest();
export const nextSecret=s=>hashBytes('sunphi-history-next-v1\0',s);
export const signingSeed=s=>hashBytes('sunphi-history-sign-v1\0',s);
const leaf=(epoch,key)=>digest({domain:'sunphi-history-leaf-v1',epoch,key});
const branch=(left,right)=>digest({domain:'sunphi-history-branch-v1',left,right});
const trees=new WeakMap();
export function keyTree(keys){
 if(!Array.isArray(keys)||keys.length!==256)throw new Error('256 epoch keys required');
 if(Object.isFrozen(keys)&&trees.has(keys))return trees.get(keys);
 const layers=[keys.map((k,i)=>{validateSigningKey(k);return leaf(i,k);})];
 while(layers.at(-1).length>1){const a=layers.at(-1),b=[];for(let i=0;i<a.length;i+=2)b.push(branch(a[i],a[i+1]));layers.push(b);}
 const tree={root:layers.at(-1)[0],path:epoch=>{if(!Number.isInteger(epoch)||epoch<0||epoch>255)throw new Error('epoch bounds');let i=epoch;return layers.slice(0,-1).map(a=>{const sibling=a[i^1];i>>=1;return sibling;});}};
 if(Object.isFrozen(keys))trees.set(keys,tree);return tree;
}
export function createEpochKeys(){
 const secret=randomBytes(32),keys=[];let cursor=Buffer.from(secret);
 for(let i=0;i<256;i++){const seed=signingSeed(cursor);keys.push(Buffer.from(ed25519.getPublicKey(seed)).toString('hex'));seed.fill(0);const next=nextSecret(cursor);cursor.fill(0);cursor=next;}
 cursor.fill(0);Object.freeze(keys);return {secret,keys,root:keyTree(keys).root};
}
export function checkHistoryConfig(h){
 exact(h,['version','epochBlocks','epochs','quorum','roots',...(h.version===3?['generation','span']:[])]);
 if(![1,2,3].includes(h.version)||h.epochBlocks!==8||h.epochs!==256||h.quorum!==7||!Array.isArray(h.roots)||h.roots.length!==10||h.roots.some(x=>!isHash(x))||new Set(h.roots).size!==10)throw new Error('unsupported isolated history policy');
 if(h.version===3&&(!Number.isSafeInteger(h.generation)||h.generation<0||h.generation>1000000||![4,255].includes(h.span)))throw new Error('invalid renewable history policy');
}
export const firstEpoch=p=>p.history.version===3?p.history.generation*p.history.span:0;
export const epochSpan=p=>p.history.version===3?p.history.span:255;
export function checkPolicy(p){exact(p,['chainId','genesis','history']);checkHistoryConfig(p.history);if(!/^sunphi-lab-[a-z0-9-]{1,48}$/.test(p.chainId)||!isHash(p.genesis))throw new Error('invalid history identity');}
export function checkSealBody(b,p){
 checkPolicy(p);exact(b,['version','chainId','genesis','epoch','fromHeight','endHeight','headerHeight','headerHash','appHash','previous','archiveRoot','archiveBytes',...(p.history.version===3?['generation']:[])]);
 if(b.version!==p.history.version||(b.version===3&&b.generation!==p.history.generation)||b.chainId!==p.chainId||b.genesis!==p.genesis||!Number.isSafeInteger(b.epoch)||b.epoch<firstEpoch(p)||b.epoch>=firstEpoch(p)+epochSpan(p)||b.fromHeight!==b.epoch*8+1||b.endHeight!==(b.epoch+1)*8||b.headerHeight!==b.endHeight+1||![b.headerHash,b.appHash,b.previous,b.archiveRoot].every(isHash)||!Number.isSafeInteger(b.archiveBytes)||b.archiveBytes<1||b.archiveBytes>16*1024*1024)throw new Error('invalid seal body');
 if(b.epoch===0&&b.previous!==ZERO)throw new Error('initial seal predecessor');
}
function message(purpose,policy,body){return Buffer.from(canonical({domain:'sunphi-history-signature-v1',purpose,policy:digest(policy),body}));}
export function signEpoch(secret,keys,slot,epoch,purpose,policy,body){
 if(!Number.isInteger(slot)||slot<0||slot>9||!Number.isInteger(epoch)||epoch<0||epoch>255)throw new Error('signer horizon');
 const seed=signingSeed(secret),publicKey=Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
 try{if(keys[epoch]!==publicKey)throw new Error('ratchet key mismatch');return {slot,epoch,publicKey,path:keyTree(keys).path(epoch),signature:Buffer.from(ed25519.sign(message(purpose,policy,body),seed)).toString('hex')};}finally{seed.fill(0);}
}
export function verifyEpoch(s,purpose,policy,body){
 checkPolicy(policy);exact(s,['slot','epoch','publicKey','path','signature']);
 if(!Number.isInteger(s.slot)||s.slot<0||s.slot>9||!Number.isInteger(s.epoch)||s.epoch<0||s.epoch>255||!Array.isArray(s.path)||s.path.length!==8||s.path.some(x=>!isHash(x))||typeof s.signature!=='string'||!/^[0-9a-f]{128}$/.test(s.signature))throw new Error('invalid epoch signature');
 validateSigningKey(s.publicKey);let h=leaf(s.epoch,s.publicKey),i=s.epoch;
 for(const sibling of s.path){h=i%2?branch(sibling,h):branch(h,sibling);i>>=1;}
 if(h!==policy.history.roots[s.slot]||!ed25519.verify(Buffer.from(s.signature,'hex'),message(purpose,policy,body),Buffer.from(s.publicKey,'hex'),{zip215:false}))throw new Error('invalid epoch authorization');
 return true;
}
export function verifySeal(c,p,previous=null){
 verifySealQuorum(c,p);
 if(previous&&(c.body.epoch!==previous.body.epoch+1||c.body.previous!==digest(previous.body)))throw new Error('broken seal chain');
 if(!previous&&c.body.epoch!==0)throw new Error('previous trusted seal required');
 return true;
}
// Quorum only: callers MUST also bind an authenticated predecessor or local chain.
export function verifySealQuorum(c,p){exact(c,['body','signatures']);checkSealBody(c.body,p);if(!Array.isArray(c.signatures)||c.signatures.length<7||c.signatures.length>10)throw new Error('seal quorum required');let last=-1;for(const s of c.signatures){if(s.slot<=last||s.epoch!==c.body.epoch-firstEpoch(p))throw new Error('duplicate or wrong epoch');verifyEpoch(s,'seal',p,c.body);last=s.slot;}return true;}
export function verifyHead(r,p,nonce,certificate){
 exact(r,['body','signature']);exact(r.body,['nonce','epoch','head',...(p.history.version===3?['generation']:[])]);
 if(!isHash(nonce)||(p.history.version===3&&r.body.generation!==p.history.generation)||r.body.nonce!==nonce||r.body.epoch!==certificate.body.epoch+1||r.body.head!==digest(certificate.body)||r.signature.epoch!==r.body.epoch-firstEpoch(p))throw new Error('stale or conflicting head');
 verifyEpoch(r.signature,'head',p,r.body);return true;
}
export function verifyFreshHeads(receipts,p,nonce,certificate){
 if(!isHash(nonce)||!Array.isArray(receipts)||receipts.length<7||receipts.length>10)throw new Error('fresh quorum required');
 const slots=new Set();for(const r of receipts){verifyHead(r,p,nonce,certificate);
  if(slots.has(r.signature.slot))throw new Error('repeated head');slots.add(r.signature.slot);
 }return true;
}
