// Disposable CometBFT rehearsal. No production keys, hosts or balances.
import fs from 'node:fs';import assert from 'node:assert/strict';import {join} from 'node:path';
import {keys,hash,sign} from '../crypto.mjs';import {envelope,stateHash} from '../core.mjs';
import {RESERVES,reserveConsent,unrestrictedDevelopmentControls} from '../network-reserves.mjs';
import {ECONOMIC_POLICY_VERSION} from '../economic-policy-v2.mjs';
export async function economicPreparationNetworkQA({homes,config,f,until,send,stopNode,startNode,pass,metrics,local}){
 const state=async(i=0)=>(await local(i,{method:'snapshot'})).value.state;
 const wire=a=>envelope(config,a,f.alice),submit=async a=>{const r=await send(wire(a));assert.equal(r.code,0,r.log);};
 const validators=homes.slice(0,10).map(home=>{const k=JSON.parse(fs.readFileSync(join(home,'config/priv_validator_key.json')));return{publicKey:Buffer.from(k.pub_key.value,'base64').toString('base64url'),privateKey:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(k.priv_key.value,'base64').subarray(0,32)]).toString('base64url')};});
 const approve=b=>validators.slice(0,7).map(k=>({key:k.publicKey,signature:sign(b,k.privateKey)}));
 let s=await state();const founder=keys(),policy={warmup:{allocation:'100000000',dailyFeeBudget:'6',maxPayment:'90',intervalSeconds:5,ttlBlocks:10},development:{allocation:'1000000000',manager:founder.publicKey,controls:unrestrictedDevelopmentControls()}};
 const b={domain:RESERVES+'/PREPARE_NETWORK_RESERVES_V1',network:config.chainId,configHash:s.configHash,generation:0,notBefore:s.height,expires:s.height+50,policy};
 await submit({type:'PREPARE_NETWORK_RESERVES_V1',certificate:{body:b,approvals:approve(b)},founderConsent:sign(reserveConsent(s.configHash,policy),founder.privateKey)});
 await until(async()=>{s=await state();return !!s.networkReserves;});
 const before={supply:s.money.supply,outputs:hash(s.money.outputs),nodes:hash(s.money.nodes),fees:s.money.fees,reserves:hash(s.networkReserves)};
 for(const n of [6,7,8,9])await stopNode(n);await new Promise(r=>setTimeout(r,3000));s=await state();const frozen=s.height;
 const body={domain:'DUEBYTE_ECONOMIC_PREPARATION_V2',network:config.chainId,configHash:s.configHash,generation:0,notBefore:s.height,expires:s.height+80,version:ECONOMIC_POLICY_VERSION,supplyBefore:s.money.supply,unitScale:'1'};
 const action={type:'PREPARE_ECONOMY_V2',certificate:{body,approvals:approve(body)},founderConsent:sign(body,founder.privateKey)};
 assert.notEqual((await send(wire({...action,certificate:{...action.certificate,approvals:action.certificate.approvals.slice(0,6)}}))).code,0);
 await submit(action);await new Promise(r=>setTimeout(r,3000));s=await state();assert.equal(s.height,frozen);assert(!s.economicPreparation);assert.equal(s.money.supply,before.supply);pass('six validators cannot commit economic preparation or mint');
 await startNode(6);await until(async()=>{s=await state();return !!s.economicPreparation;});for(const n of [7,8,9])await startNode(n);
 const planHash=s.economicPreparation.planHash;assert.equal(s.economicPreparation.plan.issuanceEnabled,false);pass('seven validators commit approved preparation without issuance');
 await stopNode(0);await startNode(0);await until(async()=>{s=await state();return s.economicPreparation?.planHash===planHash;});
 await submit(action);await until(async()=>{s=await state();return s.height>frozen+5;});
 const issueBody={domain:RESERVES+'/ISSUE_NETWORK_RESERVES_V1',network:config.chainId,configHash:s.configHash,generation:0,notBefore:s.height,expires:s.height+10,policyHash:hash(policy)};
 assert.notEqual((await send(wire({type:'ISSUE_NETWORK_RESERVES_V1',certificate:{body:issueBody,approvals:approve(issueBody)}}))).code,0);
 assert.equal(s.economicPreparation.planHash,planHash);assert.equal(s.money.supply,before.supply);assert.equal(s.money.fees,before.fees);
 assert.equal(hash(s.money.outputs),before.outputs);assert.equal(hash(s.money.nodes),before.nodes);assert.equal(hash(s.networkReserves),before.reserves);
 assert(!s.rewards&&!s.networkReserves.issued);pass('restart, duplicate submission and legacy issuance rejection preserve all funds');
 const at=s.height;await until(async()=>(await Promise.all(Array.from({length:10},(_,n)=>state(n)))).every(q=>q.height>=at));
 const snapshots=await Promise.all(Array.from({length:10},(_,n)=>local(n,{method:'snapshot',key:String(at)})));
 assert.equal(new Set(snapshots.map(q=>stateHash(q.value.state,config))).size,1);pass('all ten economic preparation application hashes agree');
 metrics.economicPreparation={planHash,supply:s.money.supply,issuance:false,balancesPreserved:true,syntheticOnly:true};
}
