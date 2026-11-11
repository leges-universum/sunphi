// Monetary values stay integer strings on the wire. No floating-point balances.
import assert from 'node:assert/strict';
export const FRACTION_SCALE=1000000n;
export function unitScale(value){const m=value?.money??value;const scale=m?.unitScale??'1';assert(['1','1000000'].includes(scale),'supported token scale');return BigInt(scale);}
// Historical unprepared states retain the original cap; prepared policy is in micro-units.
export const tokenCap=s=>s?.economicPreparation?BigInt(s.economicPreparation.plan.capMicro)*unitScale(s)/FRACTION_SCALE:100000000000n*unitScale(s);
export const tokenUnits=(s,whole)=>BigInt(whole)*unitScale(s);
export function parseToken(text,scale='1'){
 assert(['1','1000000'].includes(String(scale)));assert(typeof text==='string'&&text.length<=27,'invalid token amount');
 const places=String(scale)==='1'?0:6;assert(new RegExp('^(0|[1-9][0-9]*)(\\.[0-9]{1,'+(places||1)+'})?$').test(text),'invalid token amount');
 const [whole,fraction='']=text.split('.');assert(fraction.length<=places,'fractional precision exceeded');const n=BigInt(whole)*BigInt(scale)+BigInt(fraction.padEnd(places,'0')||'0');assert(n<(1n<<64n),'amount overflow');return String(n);
}
export function formatToken(text,scale='1'){
 assert(/^(0|[1-9][0-9]*)$/.test(String(text)));assert(['1','1000000'].includes(String(scale)));const n=BigInt(text),d=BigInt(scale);if(d===1n)return String(n);const fraction=String(n%d).padStart(6,'0').replace(/0+$/,'');return String(n/d)+(fraction?'.'+fraction:'');
}
export const intentUnits=(i,value,targetScale)=>{const from=BigInt(i.unitScale??'1'),to=BigInt(targetScale);assert(to>=from&&to%from===0n);return String(BigInt(value)*to/from);};
