// Compare exact prior shipped interpreters, not a reimplementation of legacy rules.
import fs from 'node:fs';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
import {fragmentedFixture,inputRig} from '../test/helpers/payment-input-fixture.mjs';import {Wallet} from '../wallet.mjs';import {block,stateHash} from '../core.mjs';import {hash} from '../crypto.mjs';
const oldRoot='F:/DueByteWork/compatible-packages82-r1/DueByte-Home-0.3.82-Windows-x64/resources/app/sunphi-network-next/checkpoint-trial',old=await import(pathToFileURL(oldRoot+'/core.mjs')),oldModel=await import(pathToFileURL(oldRoot+'/payment-model.mjs')),model=await import('../payment-model.mjs');
const x=fragmentedFixture(['4000000']),r=inputRig(x),home=r.directory+'/wallet';fs.mkdirSync(home);const w=new Wallet({client:{config:x.c,sync:async()=>({state:r.state,certificate:{height:r.state.height+1,appHeight:r.state.height,appHash:stateHash(r.state,x.c)}})},home,key:x.f.alice,url:'http://127.0.0.1:1'}),checks=[];
try{
 assert.deepEqual(model.policy,oldModel.policy);assert.equal(model.policyId,oldModel.policyId);assert.equal(stateHash(x.s,x.c),old.stateHash(x.s,x.c));
 const q=await w.quote('3','1000000'),p=await w.prepareTokens({recipient:x.f.bob.publicKey,value:'3',unitScale:q.unitScale,fee:q.fee,abortFee:q.abortFee,feeSchedule:q.feeSchedule,partsCount:q.partsCount}),t=JSON.parse(w.db.prepare('select body from outgoing where pid=?').get(p.pid).body),i=t.body.action.signed.intent;assert(!Object.hasOwn(i,'inputPolicy'));
 let s=x.s;
 for(const stage of ['reserve','finalize','empty']){const wires=stage==='reserve'?[t]:stage==='finalize'?[x.finish(s,i)]:[],request={height:s.height+1,blockHash:hash(['legacy83',stage]),time:s.money.time,txs:wires.map(t=>Buffer.from(JSON.stringify(t)))},before=old.block(s,x.c,request),after=block(s,x.c,request);assert.deepEqual(after,before);assert.equal(stateHash(after.state,x.c),old.stateHash(before.state,x.c));s=after.state;checks.push(stage);}
 fs.writeFileSync('F:/DueByteWork/payment83/legacy.json',JSON.stringify({passed:true,exactPrior:'0.3.82',policyHash: model.policyId,checks,productionTransfers:0},null,2));console.log('PASS exact82 policy, state hashes and old-format payment transitions retained');
}finally{w.close();r.close();}
