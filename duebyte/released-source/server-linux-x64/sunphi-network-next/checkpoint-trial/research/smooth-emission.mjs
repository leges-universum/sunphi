import assert from 'node:assert/strict';
import {START,END,DAY,inspectAnnualPlan} from './calendar-node-emission-policy.mjs';

export const SMOOTH_EMISSION='DUEBYTE_ORDINARY_DECADE_CURVE_V1';
// Exact rates in micro-DUBYT per day. Reduce intermediate fractions so that
// the integral is rounded only once, at the requested UTC boundary.
function fraction(n,d=1n){
 assert(d!==0n);if(d<0n){n=-n;d=-d;}
 let x=n<0n?-n:n,y=d;while(y)[x,y]=[y,x%y];
 return [n/x,d/x];
}
const add=([a,b],[c,d])=>fraction(a*d+b*c,b*d);
const sub=([a,b],[c,d])=>fraction(a*d-b*c,b*d);
const mul=([a,b],[c,d])=>fraction(a*c,b*d);
const div=([a,b],[c,d])=>fraction(a*d,b*c);
const half=x=>div(x,[2n,1n]);
function integral(x,length,left,right){
 return add(mul(left,x),half(div(mul(sub(right,left),mul(x,x)),length)));
}
let last;
export function compileOrdinaryCurve(annual){
 const {annualHash,values,total}=inspectAnnualPlan(annual);
 if(last?.annualHash===annualHash)return last;
 const bounds=Array.from({length:11},(_,i)=>Date.UTC(2027+i*10,0,1)/1000);
 const decades=bounds.slice(0,10).map((t,i)=>{
  const length=fraction(BigInt((bounds[i+1]-t)/DAY)),budget=values.slice(i*10,i*10+10).reduce((a,b)=>a+b,0n);
  return {length,budget,mean:div(fraction(budget),length)};
 });
 const means=decades.map(d=>d.mean),edges=[add(means[0],half(sub(means[0],means[1])))];
 for(let i=1;i<10;i++)edges.push(half(add(means[i-1],means[i])));
 edges.push(fraction(0n));let prior=0n;
 const segments=decades.map(({length,budget,mean},i)=>{
  const left=edges[i],right=edges[i+1];assert(sub(left,mean)[0]>0n&&sub(mean,right)[0]>0n,'decade curve must descend');
  const split=mul(length,div(sub(mean,right),sub(left,right))),tail=sub(length,split),first=integral(split,split,left,mean);
  const [n,d]=add(first,integral(tail,tail,mean,right));assert.equal(n,budget*d);
  const offset=prior;prior+=budget;
  return day=>{const x=fraction(BigInt(day));const [n,d]=sub(x,split)[0]<=0n?integral(x,split,left,mean):add(first,integral(sub(x,split),tail,mean,right));return offset+n/d;};
 });
 const cumulative=at=>{
  assert(Number.isSafeInteger(at)&&at%DAY===0,'UTC midnight required');
  if(at<=START)return 0n;if(at>=END)return total;
  const i=Math.floor((new Date(at*1000).getUTCFullYear()-2027)/10);
  return segments[i]((at-bounds[i])/DAY);
 };
 last=Object.freeze({annualHash,cumulative});return last;
}
