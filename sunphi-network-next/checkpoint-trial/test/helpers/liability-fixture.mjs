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
import {validatorApprovalBody,validatorSet} from '../../validator-authority.mjs';
import assert from 'node:assert/strict';
export function setup({utc=false,expanded=false,terminal=false,workerCount=6,loadPayments=0,maxOpen=expanded?256:32,maxAssignments=768,prepare=true,consent=true,founderNodes=[],sameGroup=false,penaltyBps=2000,challengeBlocks=3,suspensionBlocks=8,startTime=1000,chainId='duebyte-trial-protection-tests',validatorPowers=null}={}){
 const f=fixture(),validators=Array.from({length:validatorPowers?.length??10},keys),members=Array.from({length:4},keys),founder=keys(),backups=Array.from({length:3},keys);f.state.time=startTime;
 assert(Number.isInteger(workerCount)&&workerCount>=6&&workerCount<=10);
 for(let i=6;i<workerCount;i++){const k=keys(),id=hash({worker:i});f.ids.push(id);f.workers.push(k);f.nodeKeys[id]=k.privateKey;f.state.nodes[id]={key:k.publicKey,operator:hash({operator:i}),stake:'100',consensusHeld:'2',taskHeld:'0',tier:'90'};f.state.supply=String(BigInt(f.state.supply)+100n);}
 if(sameGroup)for(const n of Object.values(f.state.nodes))n.operator=hash('one-owner');
 assert(Number.isInteger(loadPayments)&&loadPayments>=0&&loadPayments<=32);
 const loadAccounts=Array.from({length:loadPayments},(_,i)=>({key:keys(),input:hash(['synthetic-load',i])}));
 for(const a of loadAccounts)f.state.outputs[a.input]={owner:a.key.publicKey,value:'3',unlock:0};
 f.state.outputs[f.input].value=String(BigInt(f.state.outputs[f.input].value)-3n*BigInt(loadPayments));
 const c={profile:PROFILE,chainId,trialOnly:true,...(utc?{obligationClock:UTC_OBLIGATIONS}:{}),initial:f.state,control:{validators:validators.map((k,i)=>({key:k.publicKey,group:hash({i})})),policy:{version:1,members:members.map((k,i)=>({key:k.publicKey,group:hash({i})})),threshold:3,maxAge:3600,notAfter:Math.max(200000,startTime+86400)}}};
 if(validatorPowers){c.control.version=2;c.control.validators=c.control.validators.map((v,i)=>({...v,power:validatorPowers[i]}));}
 const wire=(a,k=f.alice)=>envelope(c,a,k),run=(s,txs=[],time=s.money.time)=>block(s,c,{height:s.height+1,blockHash:hash({height:s.height+1}),time,txs:txs.map(t=>Buffer.from(JSON.stringify(t)))}).state;
 const approvals=b=>{let power=0n;return validators.filter((k,i)=>{if(power>=validatorSet(c.control.validators).threshold)return false;power+=BigInt(validatorPowers?.[i]??10);return true;}).map(k=>({key:k.publicKey,signature:sign(validatorApprovalBody(b,c.control.validators),k.privateKey)}));};
 const resourceBody={domain:CONTROL+'/FEATURE',network:c.chainId,configHash:hash(c),generation:0,feature:RESOURCE_FEATURE,activation:4,notBefore:1,expires:2};
 const reservePolicy={warmup:{allocation:'100000000',dailyFeeBudget:'6',maxPayment:'90',intervalSeconds:5,ttlBlocks:10},development:{allocation:'1000000000',manager:founder.publicKey,controls:unrestrictedDevelopmentControls(),recovery:{keys:backups.map(k=>k.publicKey).sort(),threshold:2,delaySeconds:86400}}};
 const rb={domain:RESERVES+'/PREPARE_NETWORK_RESERVES_V1',network:c.chainId,configHash:hash(c),generation:0,notBefore:1,expires:3,policy:reservePolicy},rc=reserveConsent(hash(c),reservePolicy);
 let s=run(origin(c),[wire({type:'ENABLE_RESOURCE_LIMITS',certificate:{body:resourceBody,approvals:approvals(resourceBody)}}),wire({type:'PREPARE_NETWORK_RESERVES_V1',certificate:{body:rb,approvals:approvals(rb)},founderConsent:sign(rc,founder.privateKey),recoveryConsents:backups.map(k=>({key:k.publicKey,signature:sign(rc,k.privateKey)})).sort((a,b)=>a.key<b.key?-1:1)})]);while(s.height<4)s=run(s);
 const policy={...(utc?{version:expanded?3:2,...(expanded?{maxAssignments}:{}),challengeSeconds:challengeBlocks*10,suspensionSeconds:suspensionBlocks*10}:{version:1,challengeBlocks,suspensionBlocks}),activation:10,exceptionDelaySeconds:86400,penaltyBps,maxOpen,founderKey:founder.publicKey,founderGroup:hash('founder-group'),founderNodes:founderNodes.map(i=>f.ids[i])};
 if(terminal){assert(utc&&expanded);policy.version=4;policy.challengeSeconds=0;}
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
 return {f,c,validators,founder,backups,s,policy,run,wire,key,intent,reserve,finish,fault,drain,queue,funded,prepareAction,approvals,loadAccounts};
}
