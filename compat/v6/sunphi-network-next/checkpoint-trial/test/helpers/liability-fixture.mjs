// Synthetic fixture only: no production keys, funds or network connections.
import {fixture} from '../../../research/transition-core-20261103/fixture.mjs';
import {PROFILE,origin,block,envelope,workReceipt} from '../../core.mjs';
import {keys,hash,sign} from '../../crypto.mjs';
import {CONTROL,RESOURCE_FEATURE} from '../../authority.mjs';
import {resourcePaymentId} from '../../resource-limits.mjs';
import {RESERVES,reserveConsent,unrestrictedDevelopmentControls} from '../../network-reserves.mjs';
import {LIABILITY,liabilityConsent,attestationBody} from '../../payment-liability.mjs';
import {SCHEDULE_DOMAIN} from '../../payment-model.mjs';
import {UTC_OBLIGATIONS} from '../../obligation-clock.mjs';
import assert from 'node:assert/strict';
export function setup({utc=false,expanded=false,maxOpen=expanded?256:32,maxAssignments=768,prepare=true,consent=true,founderNodes=[],sameGroup=false,penaltyBps=2000,challengeBlocks=3,suspensionBlocks=8,startTime=1000,chainId='duebyte-trial-protection-tests'}={}){
 const f=fixture(),validators=Array.from({length:10},keys),members=Array.from({length:4},keys),founder=keys(),backups=Array.from({length:3},keys);f.state.time=startTime;
 if(sameGroup)for(const n of Object.values(f.state.nodes))n.operator=hash('one-owner');
 const c={profile:PROFILE,chainId,trialOnly:true,...(utc?{obligationClock:UTC_OBLIGATIONS}:{}),initial:f.state,control:{validators:validators.map((k,i)=>({key:k.publicKey,group:hash({i})})),policy:{version:1,members:members.map((k,i)=>({key:k.publicKey,group:hash({i})})),threshold:3,maxAge:3600,notAfter:Math.max(200000,startTime+86400)}}};
 const wire=(a,k=f.alice)=>envelope(c,a,k),run=(s,txs=[],time=s.money.time)=>block(s,c,{height:s.height+1,blockHash:hash({height:s.height+1}),time,txs:txs.map(t=>Buffer.from(JSON.stringify(t)))}).state;
 const approvals=b=>validators.slice(0,7).map(k=>({key:k.publicKey,signature:sign(b,k.privateKey)}));
 const resourceBody={domain:CONTROL+'/FEATURE',network:c.chainId,configHash:hash(c),generation:0,feature:RESOURCE_FEATURE,activation:4,notBefore:1,expires:2};
 const reservePolicy={warmup:{allocation:'100000000',dailyFeeBudget:'6',maxPayment:'90',intervalSeconds:5,ttlBlocks:10},development:{allocation:'1000000000',manager:founder.publicKey,controls:unrestrictedDevelopmentControls(),recovery:{keys:backups.map(k=>k.publicKey).sort(),threshold:2,delaySeconds:86400}}};
 const rb={domain:RESERVES+'/PREPARE_NETWORK_RESERVES_V1',network:c.chainId,configHash:hash(c),generation:0,notBefore:1,expires:3,policy:reservePolicy},rc=reserveConsent(hash(c),reservePolicy);
 let s=run(origin(c),[wire({type:'ENABLE_RESOURCE_LIMITS',certificate:{body:resourceBody,approvals:approvals(resourceBody)}}),wire({type:'PREPARE_NETWORK_RESERVES_V1',certificate:{body:rb,approvals:approvals(rb)},founderConsent:sign(rc,founder.privateKey),recoveryConsents:backups.map(k=>({key:k.publicKey,signature:sign(rc,k.privateKey)})).sort((a,b)=>a.key<b.key?-1:1)})]);while(s.height<4)s=run(s);
 const policy={...(utc?{version:expanded?3:2,...(expanded?{maxAssignments}:{}),challengeSeconds:challengeBlocks*10,suspensionSeconds:suspensionBlocks*10}:{version:1,challengeBlocks,suspensionBlocks}),activation:10,exceptionDelaySeconds:86400,penaltyBps,maxOpen,founderKey:founder.publicKey,founderGroup:hash('founder-group'),founderNodes:founderNodes.map(i=>f.ids[i])};
 const body={domain:LIABILITY+'/POLICY',network:c.chainId,configHash:hash(c),generation:0,notBefore:5,expires:7,policy},prepareAction={type:'PREPARE_PAYMENT_LIABILITY_V1',certificate:{body,approvals:approvals(body)},founderConsent:sign(body,founder.privateKey)};
 const key=node=>({publicKey:s.money.nodes[node].key,privateKey:f.nodeKeys[node]});
 if(prepare){s=run(s,[wire(prepareAction)]);if(consent)s=run(s,f.ids.map(node=>wire({type:'ACCEPT_PAYMENT_LIABILITY_V1',node,signature:sign(liabilityConsent(s.money,node),f.nodeKeys[node])},key(node))));while(s.height<policy.activation)s=run(s);}
 const intent=(state,over={})=>{const i=f.intent({...(utc?{timeBasis:UTC_OBLIGATIONS,lastReserve:state.money.time+40,deadline:state.money.time+200}:{lastReserve:state.money.height+4,deadline:state.money.height+20}),...over});i.pid=resourcePaymentId(i,hash(c));return i;};
 const reserve=i=>wire({type:i.domain===SCHEDULE_DOMAIN?'SCHEDULE_PAYMENT_V1':'RESERVE',signed:f.sign(i)});
 const finish=(state,i)=>wire({type:'FINALIZE',pid:i.pid,request:hash(i),receipts:i.parts.flatMap((p,index)=>p.nodes.map(node=>workReceipt(state,i.pid,index,node,key(node))))});
 const fault=(state,i,index=0,node=i.parts[index].nodes[0],claim={recipient:f.bob.publicKey,value:'999',partValue:i.parts[index].value})=>{const body=attestationBody(state.money,i.pid,index,node,claim);return {type:'REPORT_PAYMENT_FAULT_V1',attestation:{body,signature:sign(body,f.nodeKeys[node])}};};
 const drain=(state,pid)=>{let guard=0;while(state.money.liability.records[pid]){assert(guard++<200);state=run(state);}return state;};
 const queue=(state,over={})=>({type:'QUEUE_PROTECTION_PAYMENT_V1',managementEpoch:state.networkReserves.development.access.epoch,sequence:state.money.liability.protection.sequence+1,recipient:f.bob.publicKey,value:'2',purpose:'Exceptional incident support',reference:hash('public incident evidence'),validUntil:state.money.time+300,...over});
 const funded=()=>{const i=intent(s);let state=run(s,[reserve(i)]);state=run(state,[wire(fault(state,i))]);state=drain(state,i.pid);return {s:state,i};};
 return {f,c,validators,founder,backups,s,policy,run,wire,key,intent,reserve,finish,fault,drain,queue,funded,prepareAction,approvals};
}
