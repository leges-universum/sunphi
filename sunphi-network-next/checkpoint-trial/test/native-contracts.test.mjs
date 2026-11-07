import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {issuanceFixture,certify} from './century-issuance.test.mjs';
import {keys,hash,sign} from '../crypto.mjs';import {stateHash,applyTx} from '../core.mjs';
import {NATIVE_ACTIONS,NATIVE_CONTRACTS,SATOSHI_TEMPLATE,satoshiContractId,applyNativeContract} from '../native-contracts.mjs';
import {applyCenturyIssuance,ISSUE_CENTURY} from '../century-issuance.mjs';
import {applyMemorialAction} from '../memorial-custody.mjs';import {anniversary} from '../economic-policy-v2.mjs';import {Store} from '../store.mjs';
const [REGISTER,PROPOSE,CANCEL,EXECUTE]=NATIVE_ACTIONS;
const at=(s,time)=>({...s,money:{...s.money,time}});
const row=s=>s.nativeContracts.records[satoshiContractId(s)];
const owned=(s,key)=>Object.values(s.money.outputs).filter(o=>o.owner===key).reduce((n,o)=>n+BigInt(o.value),0n);
function certificate(x,s,type,extra,recipient,manager=x.founder){
 const body={domain:NATIVE_CONTRACTS+'/'+type,configHash:s.configHash,planHash:s.economicPreparation.planHash,contractId:satoshiContractId(s),generation:s.authority.generation,managementEpoch:s.economicPreparation.memorial.epoch,notBefore:s.height,expires:s.height+100,...extra};
 return {type,certificate:{body,approvals:x.approvals(body)},managerSignature:sign(body,manager.privateKey),...(recipient?{recipientSignature:sign(body,recipient.privateKey)}:{})};
}
const registration=(x,s,extra={})=>certificate(x,s,REGISTER,{template:SATOSHI_TEMPLATE,version:1,policy:{reviewSeconds:30*86400,executionWindowSeconds:7*86400},...extra});
const proposal=(x,s,extra={},recipient=x.recipient,manager=x.founder)=>certificate(x,s,PROPOSE,{sequence:row(s).sequence+1,kind:'BITCOIN_CREATOR_PERSON',recipient:recipient.publicKey,valueMicro:s.economicPreparation.plan.memorialMicro,settlement:'DUBYT_DIRECT',evidenceHash:hash('synthetic reviewed authorship evidence'),mandateHash:null,publicDecision:'Synthetic qualified beneficiary decision; not a real identity assertion',...extra},recipient,manager);
const command=(s,type)=>({type,contractId:satoshiContractId(s),sequence:row(s).pending.action.certificate.body.sequence,proposalHash:hash(row(s).pending.action)});
const apply=(x,s,a,author=x.founder.publicKey)=>{const next=applyNativeContract(s,a,author);stateHash(next,x.c);return next;};
function prepared(issued=true){const x=issuanceFixture();let s=x.s;if(issued)s=applyCenturyIssuance(s,certify(x,s,ISSUE_CENTURY,{supplyBefore:s.money.supply}),x.c,x.founder.publicKey);s=apply(x,s,registration(x,s));return {...x,s};}
function succession(x,s,next){const m=s.economicPreparation.memorial,body={domain:'DUEBYTE_MEMORIAL_SUCCESSION_V1',configHash:s.configHash,planHash:s.economicPreparation.planHash,managerEpoch:m.epoch,sequence:m.sequence+1,successor:next.publicKey,effectiveAt:s.money.time+10,expiresAt:s.money.time+100,publicDecision:'Synthetic published succession',reference:hash('succession evidence')};
 s=applyMemorialAction(s,{type:'PUBLISH_MEMORIAL_SUCCESSION_V1',body,signature:sign(body,x.founder.privateKey),successorConsent:sign(body,next.privateKey)},x.founder.publicKey);
 s=at(s,body.effectiveAt);s=applyMemorialAction(s,{type:'EXECUTE_MEMORIAL_SUCCESSION_V1',managementEpoch:m.epoch,sequence:body.sequence,decisionHash:hash(s.economicPreparation.memorial.pending)},next.publicKey);stateHash(s,x.c);return s;
}

test('native registration is inert, deterministic, immutable and closed to public admission',()=>{
 const x=prepared(false),s=x.s;assert.equal(row(s).paidMicro,'0');assert.equal(s.economicPreparation.memorial.issued,false);assert.deepEqual(s.money,x.s.money);
 assert.equal(apply(x,s,row(s).registration),s);
 assert.throws(()=>apply(x,s,registration(x,s,{policy:{reviewSeconds:7*86400,executionWindowSeconds:86400}})),/already pinned/);
 for(const type of NATIVE_ACTIONS)assert.throws(()=>applyTx(s,Buffer.from(JSON.stringify(x.wire({type},x.founder))),x.c,s.money.time),/public action/);
 for(const extra of [{template:'UNTRUSTED_VM'},{version:2},{policy:{reviewSeconds:0,executionWindowSeconds:86400}}])assert.throws(()=>apply(x,s,registration(x,s,extra)));
});
test('proposal requires manager, seven unique validators, recipient possession and scoped certificates',()=>{
 const x=prepared(),s=x.s,a=proposal(x,s),before=stateHash(s,x.c);
 for(const mutate of [q=>q.certificate.approvals.pop(),q=>q.certificate.approvals[6]=q.certificate.approvals[0],q=>q.managerSignature=sign(q.certificate.body,keys().privateKey),q=>q.recipientSignature=sign(q.certificate.body,keys().privateKey),q=>q.certificate.body.configHash=hash('another chain'),q=>q.certificate.body.contractId=hash('another contract'),q=>q.certificate.body.managementEpoch++,q=>q.certificate.body.generation++]){const bad=structuredClone(a);mutate(bad);assert.throws(()=>apply(x,s,bad));assert.equal(stateHash(s,x.c),before);}
 assert.throws(()=>apply(x,s,a,keys().publicKey));assert.throws(()=>apply(x,{...s,height:s.height+101},a),/inclusion window/);
});
test('tiny Bitcoin transfers, partial awards and unsupported routes cannot authorize a payout',()=>{
 const x=prepared(),s=x.s;
 for(const extra of [{settlement:'BTC_AUTOMATIC'},{valueMicro:'1'},{kind:'SAME_NAME_PERSON'},{evidenceHash:'0'.repeat(64)},{publicDecision:''},{kind:'BITCOIN_CREATOR_GROUP',mandateHash:null}])assert.throws(()=>apply(x,s,proposal(x,s,extra)));
 for(const recipient of [s.centuryFunds.manifest.memorial.account,s.centuryFunds.manifest.development.account,s.centuryFunds.manifest.founder.account,...s.centuryFunds.manifest.warmup.accounts])assert.throws(()=>apply(x,s,proposal(x,s,{recipient})));
});
test('review boundary, atomic settlement, exact-once replay and supply conservation',()=>{
 const x=prepared();let s=apply(x,x.s,proposal(x,x.s));const a=command(s,EXECUTE),p=row(s).pending,supply=s.money.supply,fees=s.money.fees,outputs=structuredClone(s.money.outputs);
 assert.throws(()=>apply(x,at(s,p.executeAt-1),a),/review\/execution/);
 const equal=apply(x,at(s,p.executeAt),a,keys().publicKey);assert.equal(stateHash(equal,x.c),stateHash(apply(x,at(s,p.executeAt),a),x.c));s=equal;
 assert.equal(owned(s,x.recipient.publicKey),10000000000000n);assert.equal(s.money.supply,supply);assert.equal(s.money.fees,fees);assert.equal(s.economicPreparation.memorial.balanceMicro,'0');assert.equal(apply(x,s,a),s);
 for(const [id,o] of Object.entries(outputs))if(o.owner!==s.centuryFunds.manifest.memorial.account)assert.deepEqual(s.money.outputs[id],o);
 assert.throws(()=>apply(x,s,proposal(x,s)),/already settled/);assert.throws(()=>apply(x,s,{...a,sequence:a.sequence+1}));
});
test('unissued allocation cannot be paid; issuance after registration preserves the contract',()=>{
 const x=prepared(false);let s=apply(x,x.s,proposal(x,x.s)),a=command(s,EXECUTE);s=at(s,row(s).pending.executeAt);
 assert.throws(()=>apply(x,s,a),/unissued/);const before=hash(s.nativeContracts);
 s=applyCenturyIssuance(s,certify(x,s,ISSUE_CENTURY,{supplyBefore:s.money.supply}),x.c,x.founder.publicKey);assert.equal(hash(s.nativeContracts),before);stateHash(s,x.c);s=apply(x,s,a);assert.equal(row(s).paidMicro,'10000000000000');
});
test('expiry, cancellation, fresh sequence and stale replay preserve funds',()=>{
 const x=prepared();let s=apply(x,x.s,proposal(x,x.s)),pay=command(s,EXECUTE),cancel=command(s,CANCEL),before=hash(s.money);s=at(s,row(s).pending.expiresAt+1);
 assert.throws(()=>apply(x,s,pay),/review\/execution/);assert.throws(()=>apply(x,s,cancel,keys().publicKey));const financial=hash(s.money);s=apply(x,s,cancel);assert.equal(hash(s.money),financial);assert.equal(apply(x,s,cancel),s);
 s=apply(x,s,proposal(x,s));assert.equal(row(s).sequence,2);assert.throws(()=>apply(x,s,pay));assert.throws(()=>apply(x,s,cancel));assert.notEqual(hash(s.money),before);
});
test('published management succession keeps historical certificates valid but cancels old execution authority',()=>{
 const x=prepared(),manager=keys();let s=apply(x,x.s,proposal(x,x.s)),pay=command(s,EXECUTE);s=succession(x,s,manager);s=at(s,row(s).pending.executeAt);
 assert.throws(()=>apply(x,s,pay),/stale contract management/);assert.throws(()=>apply(x,s,command(s,CANCEL)),/current memorial manager/);
 s=apply(x,s,command(s,CANCEL),manager.publicKey);s=apply(x,s,proposal(x,s,{},x.recipient,manager),manager.publicKey);s=at(s,row(s).pending.executeAt);s=apply(x,s,command(s,EXECUTE));assert.equal(row(s).paidMicro,'10000000000000');
});
test('validator generation changes invalidate pending execution without invalidating history',()=>{
 const x=prepared();let s=apply(x,x.s,proposal(x,x.s)),pay=command(s,EXECUTE);s=structuredClone(s);s.authority.generation++;s=at(s,row(s).pending.executeAt);stateHash(s,x.c);
 assert.throws(()=>apply(x,s,pay),/stale validator/);s=apply(x,s,command(s,CANCEL));stateHash(s,x.c);
});
test('museum publication starts only at the actual hundredth anniversary, then observes review',()=>{
 const x=prepared(),boundary=anniversary(x.s.centuryFunds.execution.start,100);let s=at(x.s,boundary-1);
 assert.throws(()=>apply(x,s,proposal(x,s,{kind:'CRYPTO_HISTORY_MUSEUM'})),/100-year/);s=at(s,boundary);s=apply(x,s,proposal(x,s,{kind:'CRYPTO_HISTORY_MUSEUM'}));const a=command(s,EXECUTE);assert.throws(()=>apply(x,s,a),/review\/execution/);
 s=apply(x,at(s,row(s).pending.executeAt),a);assert.equal(row(s).paidMicro,'10000000000000');
});
test('a group requires an indivisible mandate and one recipient acceptance',()=>{
 const x=prepared();let s=apply(x,x.s,proposal(x,x.s,{kind:'BITCOIN_CREATOR_GROUP',mandateHash:hash('synthetic group authorization')}));s=apply(x,at(s,row(s).pending.executeAt),command(s,EXECUTE));assert.equal(owned(s,x.recipient.publicKey),10000000000000n);
});
test('restart before commit retains funds; restart after commit retains the exact payout and replay protection',()=>{
 const x=prepared();let s=apply(x,x.s,proposal(x,x.s)),a=command(s,EXECUTE);s=at(s,row(s).pending.executeAt);
 const file=join(mkdtempSync(join(tmpdir(),'native-contract-')),'state.sqlite');let db=new Store(file,x.c);db.restore(s);const settled=apply(x,s,a);db.close();db=new Store(file,x.c);assert.equal(stateHash(db.state,x.c),stateHash(s,x.c));db.close();db=new Store(file+'.settled',x.c);db.restore(settled);db.close();db=new Store(file+'.settled',x.c);assert.equal(stateHash(db.state,x.c),stateHash(settled,x.c));assert.equal(apply(x,db.state,a),db.state);db.close();
});
test('snapshot reconciliation rejects altered paid balance, output, authority and template version',()=>{
 const x=prepared();let s=apply(x,x.s,proposal(x,x.s));s=apply(x,at(s,row(s).pending.executeAt),command(s,EXECUTE));
 for(const mutate of [q=>row(q).paidMicro='1',q=>row(q).version=2,q=>q.economicPreparation.memorial.balanceMicro='1',q=>row(q).registrationAuthority.manager=keys().publicKey,q=>q.money.outputs[row(q).last.outputId].value='1']){const bad=structuredClone(s);mutate(bad);assert.throws(()=>stateHash(bad,x.c));}
});
