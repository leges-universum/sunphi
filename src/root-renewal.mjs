// Renewal candidates may be authorized more than once. ONLY finalized chain
// inclusion selects a candidate; authorization is not activation or a seal.
import { canonical,digest,exact } from './protocol.mjs';
import { checkPolicy,firstEpoch,epochSpan,isHash,verifyEpoch,verifySealQuorum,ZERO } from './epoch-seal.mjs';
export const isRenewal=b=>b.subarray(0,4).toString()==='SWR6';
export function encodeRenewal(c){const b=Buffer.from('SWR6'+canonical(c));if(b.length>90000)throw new Error('renewal bound');return b;}
export function decodeRenewal(b){if(!isRenewal(b)||b.length>90000)throw new Error('renewal frame');const text=b.subarray(4).toString(),c=JSON.parse(text);if(canonical(c)!==text)throw new Error('noncanonical renewal');return c;}
export function nextPolicy(p,b){checkPolicy(p);return {...p,history:{...p.history,generation:b.nextGeneration,roots:[...b.roots]}};}
export function checkRenewalBody(b,p,used=p.history.roots){
 checkPolicy(p);if(p.history.version!==3)throw new Error('renewal disabled');
 exact(b,['version','chainId','genesis','generation','nextGeneration','activationEpoch','authorizationEpoch','head','roots']);
 if(b.version!==1||b.chainId!==p.chainId||b.genesis!==p.genesis||b.generation!==p.history.generation||b.nextGeneration!==b.generation+1||b.activationEpoch!==firstEpoch(p)+epochSpan(p)||!Number.isSafeInteger(b.authorizationEpoch)||b.authorizationEpoch<firstEpoch(p)||b.authorizationEpoch>=b.activationEpoch||!isHash(b.head)||!Array.isArray(b.roots)||b.roots.length!==10||b.roots.some(r=>!isHash(r)||used.includes(r))||new Set(b.roots).size!==10)throw new Error('renewal context or reused root');
 checkPolicy(nextPolicy(p,b));return true;
}
function quorum(signatures,purpose,p,b,leaf){if(!Array.isArray(signatures)||signatures.length<7||signatures.length>10)throw new Error('renewal quorum');let last=-1;for(const s of signatures){if(s.slot<=last||s.epoch!==leaf)throw new Error('duplicate or wrong renewal signer');verifyEpoch(s,purpose,p,b);last=s.slot;}}
export function verifyReady(c,p,used){checkRenewalBody(c.body,p,used);quorum(c.ready,'root-ready',nextPolicy(p,c.body),c.body,0);}
export function verifyRenewal(c,p,used){
 exact(c,['body','anchor','approvals','ready']);verifyReady(c,p,used);const b=c.body;
 if(b.authorizationEpoch===0){if(c.anchor!==null||b.head!==ZERO)throw new Error('initial renewal anchor');}
 else{if(!c.anchor||c.anchor.body.epoch!==b.authorizationEpoch-1||digest(c.anchor.body)!==b.head)throw new Error('renewal anchor');
  // First-key authorization of later generations anchors the preceding generation.
  if(b.authorizationEpoch===firstEpoch(p))throw new Error('renewal requires a seal in this generation');
  verifySealQuorum(c.anchor,p);
 }
 quorum(c.approvals,'root-authorize',p,b,b.authorizationEpoch-firstEpoch(p));return nextPolicy(p,b);
}
export function initialRoots(config){if(config?.version!==3)return null;if(config.generation!==0)throw new Error('genesis witness generation');return {generation:0,roots:[...config.roots],usedRoots:[...config.roots],pending:null,changes:0};}
export const rootPolicy=(config,genesis,state)=>({chainId:config.chainId,genesis,history:{...config.history,generation:state.generation,roots:state.roots}});
export function activateRoots(s,height,span){if(!s?.pending||height<(s.generation+1)*span*8+1)return s;if(height!==(s.generation+1)*span*8+1)throw new Error('missed root activation');return {...s,generation:s.generation+1,roots:s.pending.body.roots,pending:null,changes:s.changes+1};}
export function acceptRoots(s,c,{config,genesis,height,lookup}){
 if(!s||s.pending)throw new Error('renewal disabled or already selected');const p=rootPolicy(config,genesis,s);verifyRenewal(c,p,s.usedRoots);
 if(height>=c.body.activationEpoch*8||height<=firstEpoch(p)*8)throw new Error('late or premature renewal inclusion');
 if(c.anchor){const a=c.anchor.body,end=lookup(a.endHeight),header=lookup(a.headerHeight);if(a.headerHeight>=height||!end||!header||end.root!==a.appHash||Buffer.from(header.block_hash,'base64').toString('hex')!==a.headerHash)throw new Error('renewal anchor not in local finalized chain');}
 return {...s,pending:structuredClone(c),usedRoots:[...s.usedRoots,...c.body.roots]};
}
