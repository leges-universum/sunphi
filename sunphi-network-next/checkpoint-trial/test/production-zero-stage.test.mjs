// Synthetic ledgers only. The production anchor remains non-isolated.
import test from 'node:test';
import assert from 'node:assert/strict';
import {hash,keys,sign} from '../crypto.mjs';
import {launch} from './founder-advance.test.mjs';
import {pilotFixture,admission} from './zero-stage-consensus.test.mjs';
import {certify} from './century-issuance.test.mjs';
import {subsidyCertificate} from './century-subsidy.test.mjs';
import {ZERO_STAGE_TERMINAL_DEFAULTS} from '../research/zero-stage-plan.mjs';
import {ISSUE_WARMUP_TRANCHE,ISSUE_CENTURY} from '../century-issuance.mjs';
import {issuedTotal} from '../research/bounded-century-context.mjs';
import {queryBounded,verifyBoundedQuery} from '../research/bounded-query.mjs';

test('production pilot: exact 10000, restart and authenticated non-isolated wallet view',()=>{
 const {x,r,original}=launch(false);try{
  assert.equal(BigInt(r.s.money.supply)-BigInt(original),10000000000n);
  assert.equal(issuedTotal(r.s),10000000000n);
  const root=r.db.root;r.reopen();assert.equal(r.db.root,root);
  const request={type:'economy',id:null},reply=queryBounded(r.db,request,root);
  assert.equal(verifyBoundedQuery(reply,request,root,hash(x.c)).isolatedIssuance,false);
  r.reject(x.wire(certify(x,r.s,ISSUE_CENTURY,{supplyBefore:r.s.money.supply})),/issuance forbidden/);
  r.reject(x.wire(subsidyCertificate(x,r.s,{start:r.s.centuryFunds.execution.start})),/issuance forbidden/);
  r.step([],r.s.money.time+604800);assert.equal(issuedTotal(r.s),10000000000n);
 }finally{r.db.close();}
});

test('production pilot: mandate, exact tranche, signatures, atomic rollback and replay',()=>{
 const {x,r}=pilotFixture(false,true,10);try{
  const mint=()=>certify(x,r.s,ISSUE_WARMUP_TRANCHE,{supplyBefore:r.s.money.supply,trancheMicro:'9000000000'});
  r.reject(x.wire(mint()),/terminal pilot admission required/);
  r.step([x.wire(admission(x,r,{settings:{...ZERO_STAGE_TERMINAL_DEFAULTS}}))]);
  const original=r.s.money.supply;
  for(const value of ['8999999999','9000000001','10000000001'])r.reject(x.wire(certify(x,r.s,ISSUE_WARMUP_TRANCHE,{supplyBefore:original,trancheMicro:value})),/pilot tranche/);
  for(const change of [a=>a.certificate.approvals.pop(),a=>a.founderConsent=sign(a.certificate.body,keys().privateKey)]){const a=mint();change(a);r.reject(x.wire(a));}
  const a=mint(),root=r.db.root,request={height:r.s.height+1,time:r.s.money.time,blockHash:hash('production-pilot-crash'),txs:[Buffer.from(JSON.stringify(x.wire(a)))]};
  assert.throws(()=>r.db.commitBlock(request,root,{beforeCommit:()=>{throw Error('simulated disk failure');}}),/simulated disk failure/);
  r.reopen();assert.equal(r.db.root,root);assert.equal(r.s.money.supply,original);
  const committed=r.step([x.wire(a)]);assert(r.db.commitBlock(committed.request,r.db.root).value.duplicate);
  r.step([x.wire(a)]);r.reopen();assert.equal(BigInt(r.s.money.supply)-BigInt(original),9000000000n);
  r.reject(x.wire(mint()));assert.equal(issuedTotal(r.s),9000000000n);
 }finally{r.db.close();}
});

test('production pilot: expired mandate cannot start issuance',()=>{
 const {x,r}=pilotFixture(false,true,10);try{
  r.step([x.wire(admission(x,r,{settings:{...ZERO_STAGE_TERMINAL_DEFAULTS}}))]);
  r.step([],r.s.centuryFunds.zeroStage.body.startsAt+604800);
  r.reject(x.wire(certify(x,r.s,ISSUE_WARMUP_TRANCHE,{supplyBefore:r.s.money.supply,trancheMicro:'9000000000'})),/pilot UTC window/);
  assert.equal(issuedTotal(r.s),0n);
 }finally{r.db.close();}
});
