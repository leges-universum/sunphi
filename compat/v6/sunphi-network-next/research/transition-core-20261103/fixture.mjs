import {keys} from '../../../sunphi-wander-lab/src/crypto.mjs';
import {DOMAIN,hash,policy,policyId,audit,feeFor,authorize,root,transition} from './model.mjs';
export function fixture(){
  const alice=keys(),bob=keys(),workers=Array.from({length:6},()=>keys()),nodeKeys={};
  const ids=workers.map((_,i)=>hash({worker:i}));const nodes=Object.fromEntries(workers.map((k,i)=>{nodeKeys[ids[i]]=k.privateKey;return [ids[i],{key:k.publicKey,operator:hash({operator:i}),stake:'100',consensusHeld:'2',taskHeld:'0',tier:'90'}];}));
  const input=hash({genesisOutput:1});
  const state={domain:DOMAIN,policy:policyId,height:0,epoch:0,time:0,supply:'1600',outputs:{[input]:{owner:alice.publicKey,value:'1000',unlock:0}},requests:{},nodes,fees:'0'};audit(state);
  function intent(over={}){return {domain:DOMAIN+'/INTENT',policy:policyId,network:policy.network,pid:hash({payment:1}),sender:alice.publicKey,recipient:bob.publicKey,inputs:[input],value:'100',fee:String(feeFor('100')),abortFee:'1',epoch:0,lastReserve:2,deadline:4,delay:0,parts:[{value:'50',nodes:ids.slice(0,3)},{value:'50',nodes:ids.slice(3)}],...over};}
  return {alice,bob,workers,ids,nodeKeys,input,state,intent,sign:i=>authorize(i,alice.privateKey)};
}
export const event=(s,action,time=s.time)=>({parent:root(s),epoch:s.epoch,time,action});
export const step=(s,a,time=s.time)=>transition(s,event(s,a,time)).state;
