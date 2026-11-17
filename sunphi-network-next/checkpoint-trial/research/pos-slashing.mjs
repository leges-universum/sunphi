// CometBFT/Cosmos-style slashing kernel. The caller supplies authenticated ABCI
// context and commits its result together with collateral and validator updates.
// No RPC uptime inference, discretionary fault certificate, or monetary mint.
import assert from 'node:assert/strict';
import {exact,integer,hash,publicKey} from '../crypto.mjs';
import {consensusAddress,validateConsensusContext} from '../consensus-context.mjs';

// Cosmos SDK v0.50.14 defaults, expressed as integer basis points. Deployment
// must also bind Comet's actual evidence ages to the unbonding delay.
export const STANDARD_SLASHING=Object.freeze({signedBlocksWindow:100,minSignedBps:5000,doubleSignBps:500,downtimeBps:100,downtimeJailSeconds:600});
export function validateSlashingPolicy(p){
 exact(p,[...Object.keys(STANDARD_SLASHING),'evidenceMaxAgeBlocks','evidenceMaxAgeSeconds']);
 integer(p.signedBlocksWindow,1);assert(p.signedBlocksWindow<=100000);
 for(const k of ['minSignedBps','doubleSignBps','downtimeBps']){integer(p[k]);assert(p[k]<=10000);}
 integer(p.downtimeJailSeconds,1);assert(p.downtimeJailSeconds<=31*86400);
 integer(p.evidenceMaxAgeBlocks,1);integer(p.evidenceMaxAgeSeconds,1);
 return p;
}
const amount=x=>{assert(typeof x==='string'&&/^(0|[1-9][0-9]*)$/.test(x));const n=BigInt(x);assert(n<1n<<64n);return n;};
export function newSigningInfo(key,{height,time,bond}){
 publicKey(key);integer(height,1);integer(time,1);assert(amount(bond)>0n);
 return {key,address:consensusAddress(key),bondedHeight:height,startHeight:height,lastHeight:height-1,index:0,observations:0,missed:0,
  jailed:false,jailedUntil:0,tombstoned:false,removedHeight:null,removedTime:null,bond,initialBond:bond,slashed:'0',sequence:0};
}
export function auditSigningInfo(info,p){
 exact(info,['key','address','bondedHeight','startHeight','lastHeight','index','observations','missed','jailed','jailedUntil','tombstoned','removedHeight','removedTime','bond','initialBond','slashed','sequence']);
 assert.equal(info.address,consensusAddress(info.key));integer(info.bondedHeight,1);integer(info.startHeight,info.bondedHeight);integer(info.lastHeight);integer(info.index);assert(info.index<p.signedBlocksWindow);
 integer(info.observations);assert(info.observations<=p.signedBlocksWindow);integer(info.missed);assert(info.missed<=info.observations);integer(info.jailedUntil);integer(info.sequence);
 assert(typeof info.jailed==='boolean'&&typeof info.tombstoned==='boolean');assert(!info.tombstoned||info.jailed);
 assert.equal(amount(info.bond)+amount(info.slashed),amount(info.initialBond),'bond conservation');
 if(info.removedHeight===null)assert.equal(info.removedTime,null);else{integer(info.removedHeight,info.startHeight);integer(info.removedTime,1);}
}
function fine(info,bps,reason,height,time,reference,basis=info.bond){
 // Truncate toward zero, as with standard fixed-point stake deductions; no
 // minimum fine which could unexpectedly consume a small holder's whole bond.
 const current=amount(info.bond),historical=amount(basis);assert(historical<=amount(info.initialBond),'historical bond exceeds original deposit');
 const requested=historical*BigInt(bps)/10000n,value=requested<current?requested:current;
 info.bond=String(current-value);info.slashed=String(amount(info.slashed)+value);info.sequence++;
 return {id:hash({domain:'DUEBYTE_POS_SLASH_V1',address:info.address,sequence:info.sequence}),address:info.address,reason,height,time,reference,value:String(value)};
}
// Bitmap storage is chunked: only one 64-bit word is read/written per validator
// per observed block. Reset uses a generation, not a scan or unbounded deletion.
// Caller reuses the same word keys with an epoch tag; no history-sized sweep.
export function signingObservation(info,p,{height,time,flag},bitmap){
 auditSigningInfo(info,p);integer(height,1);integer(time,1);assert([1,2,3].includes(flag));
 if(info.jailed||height<info.startHeight)return {info,fine:null,reset:false};
 assert(height>info.lastHeight,'duplicate or reordered last-commit observation');
 const slot=info.index,word=Math.floor(slot/64),bit=1n<<BigInt(slot%64),raw=bitmap.get(word)??'0';
 assert(typeof raw==='string'&&/^(0|[1-9a-f][0-9a-f]{0,15})$/.test(raw),'missed bitmap word');
 const bits=BigInt('0x'+raw),wasMissed=(bits&bit)!==0n,missed=flag===1; // NIL votes still prove participation.
 if(wasMissed!==missed){bitmap.set(word,(missed?bits|bit:bits&~bit).toString(16));info.missed+=missed?1:-1;}
 info.index=(slot+1)%p.signedBlocksWindow;info.observations=Math.min(p.signedBlocksWindow,info.observations+1);info.lastHeight=height;
 const minSigned=Math.round(p.signedBlocksWindow*p.minSignedBps/10000),maxMissed=p.signedBlocksWindow-minSigned;
 // Give each admission a complete warm-up window, as the SDK signing-info rule.
 if(height>info.startHeight+p.signedBlocksWindow&&info.missed>maxMissed){
  const event=fine(info,p.downtimeBps,'DOWNTIME',height,time,hash({address:info.address,height,missed:info.missed,window:p.signedBlocksWindow}));
  info.jailed=true;info.jailedUntil=integer(time+p.downtimeJailSeconds,1);info.index=0;info.observations=0;info.missed=0;
  auditSigningInfo(info,p);return {info,fine:event,reset:true};
 }
 auditSigningInfo(info,p);return {info,fine:null,reset:false};
}
export function evidenceInfraction(info,p,e,{height,time,activation,bondAt}){
 auditSigningInfo(info,p);validateConsensusContext({round:0,votes:[],misbehavior:[e]});
 integer(height,1);integer(time,1);integer(activation,1);assert.equal(e.address,info.address);
 assert(e.height<height&&e.time<=time,'future evidence');
 if(e.height<activation||e.height<info.bondedHeight)return {info,fine:null};
 // Comet expires evidence only when BOTH limits have been exceeded.
 if(height-e.height>p.evidenceMaxAgeBlocks&&time-e.time>p.evidenceMaxAgeSeconds)return {info,fine:null};
 if(info.removedHeight!==null&&e.height>=info.removedHeight)return {info,fine:null};
 // Permanent tombstone applies to the signing key, not to an order/proof ID.
 if(info.tombstoned)return {info,fine:null};
 // The caller must read the authenticated stake at the infraction height.
 // Neither today's remaining bond nor the original deposit is necessarily it.
 assert.equal(typeof bondAt,'function','historical bonded stake reader required');
 const event=fine(info,p.doubleSignBps,e.type===1?'DOUBLE_SIGN':'LIGHT_CLIENT_ATTACK',height,time,hash(e),bondAt(e.height));
 info.tombstoned=true;info.jailed=true;info.jailedUntil=0;auditSigningInfo(info,p);return {info,fine:event};
}
export function unjailSigningInfo(info,p,{height,time}){
 auditSigningInfo(info,p);integer(height,1);integer(time,1);
 assert(info.jailed&&!info.tombstoned,'cannot unjail tombstoned or active validator');
 assert(time>=info.jailedUntil,'jail period not finished');assert(amount(info.bond)>0n,'empty consensus bond');
 assert(info.removedHeight!==null,'wait for consensus removal');
 assert(height>info.removedHeight&&height>info.lastHeight&&time>=info.removedTime,'unjail must follow removal');
 // Unjailing makes a signer eligible, not active. Preserve the real removal
 // boundary until the existing membership protocol actually re-admits it.
 info.jailed=false;info.jailedUntil=0;
 return info;
}
export function admitSigningInfo(info,p,{height,time}){
 auditSigningInfo(info,p);integer(height,1);integer(time,1);
 assert(!info.jailed&&!info.tombstoned&&amount(info.bond)>0n,'ineligible consensus signer');
 if(info.removedHeight!==null)assert(height>info.removedHeight&&time>=info.removedTime,'admission follows removal');
 info.startHeight=height;info.lastHeight=height-1;info.index=0;info.observations=0;info.missed=0;
 info.removedHeight=null;info.removedTime=null;return info;
}
export function bondReleaseAllowed(info,p,{height,time}){
 auditSigningInfo(info,p);integer(height,1);integer(time,1);
 return info.removedHeight!==null&&height-info.removedHeight>p.evidenceMaxAgeBlocks&&time-info.removedTime>p.evidenceMaxAgeSeconds;
}
