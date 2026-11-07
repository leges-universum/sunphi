import test from 'node:test';import assert from 'node:assert/strict';
import {setupReserves} from './network-reserves.test.mjs';
import {keys,sign,hash} from '../crypto.mjs';import {origin,stateHash} from '../core.mjs';
import {reserveConsent,reserveSummary} from '../network-reserves.mjs';
import {recoveryBody} from '../reserve-recovery.mjs';
import {createReserveManagement,restoreReserveManagement,prepareRecoveryRequest} from '../reserve-management-vault.mjs';
function ready(){
 const x=setupReserves(),backup=Array.from({length:3},keys);x.policy.development.recovery={keys:backup.map(k=>k.publicKey).sort(),threshold:2,delaySeconds:172800};
 let s=origin(x.c);const body=reserveConsent(s.configHash,x.policy);
 s=x.run(s,[x.wire({type:'PREPARE_NETWORK_RESERVES_V1',certificate:x.cert(s,'PREPARE_NETWORK_RESERVES_V1',{policy:x.policy}),founderConsent:sign(body,x.founder.privateKey),recoveryConsents:backup.map(k=>({key:k.publicKey,signature:sign(body,k.privateKey)}))})]);
 s=x.run(s,[x.enable(s)]);while(!s.rewards)s=x.run(s);s=x.run(s,[x.issue(s)]);
 const control=(state,key=x.founder)=>x.wire({...x.control(state).body.action,managementEpoch:state.networkReserves.development.access.epoch},key);
 return {...x,s,backup,active:state=>x.run(state,[control(state)]),control};
}
test('2-of-3 recovery freezes pending spends, survives state serialization, replaces lost keys and rejects old authority',()=>{
 const x=ready();let s=x.active(x.s);s=x.run(s,[x.wire({...x.queue(s).body.action,managementEpoch:0},x.founder)]);const money=structuredClone(s.money);
 const manager=keys(),recoveryKeys=Array.from({length:3},keys),a=prepareRecoveryRequest({state:s,manager,recoveryKeys,authorizingKeys:x.backup.slice(0,2),expiresAt:s.money.time+300});
 assert.throws(()=>x.run(s,[x.wire({...a,approvals:a.approvals.slice(0,1)})]),/assert|false/i);
 assert.throws(()=>x.run(s,[x.wire({...a,approvals:[a.approvals[0],a.approvals[0]]})]),/unique/);
 const wrong=structuredClone(a);wrong.body.manager=keys().publicKey;assert.throws(()=>x.run(s,[x.wire(wrong)]),/signature/);
 s=x.run(s,[x.wire(a)]);assert.equal(s.networkReserves.development.mode,'PAUSED');assert.equal(s.networkReserves.development.pending,null);assert.deepEqual({...s.money,height:money.height},money);
 assert.throws(()=>x.run(s,[x.control(s)]),/recovery pending/);
 const p=s.networkReserves.development.access.pending,execute={type:'EXECUTE_DEVELOPMENT_RECOVERY_V1',managementEpoch:0,sequence:p.sequence,requestHash:p.requestHash};
 assert.throws(()=>x.run(s,[x.wire(execute)]),/delay/);s=JSON.parse(JSON.stringify(s));stateHash(s,x.c);
 while(s.money.time<p.notBefore)s=x.run(s,[],Math.min(p.notBefore,s.money.time+3600));
 s=x.run(s,[x.wire(execute)]);assert.equal(reserveSummary(s).manager,manager.publicKey);assert.equal(s.networkReserves.development.mode,'PAUSED');assert.deepEqual(s.money.outputs,money.outputs);assert.equal(s.money.supply,money.supply);
 assert.throws(()=>x.run(s,[x.control(s)]),/management signature/);assert.throws(()=>x.run(s,[x.wire(execute)]),/equal|match/);
 s=x.run(s,[x.control(s,manager)]);assert.equal(s.networkReserves.development.mode,'ACTIVE');stateHash(s,x.c);
});
test('normal manager rotation keeps recovery authority and invalidates pre-signed old epoch commands',()=>{
 const x=ready();let s=x.active(x.s);const manager=keys(),a={type:'ROTATE_DEVELOPMENT_MANAGER_V1',managementEpoch:0,manager:manager.publicKey};a.newConsent=sign(recoveryBody(s,a.type,{manager:a.manager}),manager.privateKey);
 const old=x.control(s);s=x.run(s,[x.wire(a,x.founder)]);assert.equal(s.networkReserves.development.access.epoch,1);assert.equal(s.networkReserves.development.mode,'PAUSED');assert.deepEqual(s.networkReserves.development.access.recovery,x.policy.development.recovery);assert.throws(()=>x.run(s,[old]),/management signature/);
 assert.throws(()=>x.run(s,[x.wire({...x.control(s,manager).body.action,managementEpoch:0},manager)]),/epoch/);
});
test('only recovery quorum may cancel a recovery; cancellation never resumes spending',()=>{
 const x=ready();let s=x.active(x.s);const a=prepareRecoveryRequest({state:s,manager:keys(),recoveryKeys:Array.from({length:3},keys),authorizingKeys:x.backup.slice(1),expiresAt:s.money.time+300});s=x.run(s,[x.wire(a)]);
 const p=s.networkReserves.development.access.pending,body=recoveryBody(s,'CANCEL_DEVELOPMENT_RECOVERY_V1',{sequence:p.sequence,requestHash:p.requestHash});
 const action={type:'CANCEL_DEVELOPMENT_RECOVERY_V1',body,approvals:x.backup.slice(0,2).map(k=>({key:k.publicKey,signature:sign(body,k.privateKey)}))};
 s=x.run(s,[x.wire(action)]);assert.equal(s.networkReserves.development.access.pending,null);assert.equal(s.networkReserves.development.mode,'PAUSED');assert.throws(()=>x.run(s,[x.wire(action)]),/pending/);
});
test('portable management backups restore distinct keys and reject wrong password, network, identity and tampering',()=>{
 const x=setupReserves(),passwords=Array.from({length:4},(_,i)=>'isolated-test-password-'+i),b=createReserveManagement(x.c,passwords);assert.equal(new Set(b.backups.map(k=>k.publicKey)).size,4);
 for(let i=0;i<4;i++){const v=JSON.parse(JSON.stringify(b.backups[i]));assert.equal(restoreReserveManagement(v,x.c,passwords[i],v.publicKey).publicKey,v.publicKey);assert.throws(()=>restoreReserveManagement(v,x.c,'incorrect-password',v.publicKey));assert.throws(()=>restoreReserveManagement(v,{...x.c,chainId:'other'},passwords[i],v.publicKey));assert.throws(()=>restoreReserveManagement(v,x.c,passwords[i],keys().publicKey));v.vault.ciphertext=v.vault.ciphertext.slice(0,-4)+'AAAA';assert.throws(()=>restoreReserveManagement(v,x.c,passwords[i],v.publicKey));}
});
