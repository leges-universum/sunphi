import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {nativeFixture} from './helpers/purchase-native-fixture.mjs';
import {hash,keys} from '../crypto.mjs';
import {origin,validateConfig,envelope} from '../core.mjs';
import {orderId} from '../research/purchase-contract.mjs';
import {purchaseOutput,PURCHASE_ACTION} from '../research/purchase-native.mjs';
import {BoundedNetworkInterpreter} from '../research/bounded-network-interpreter.mjs';
import {BoundedApplication} from '../research/bounded-application.mjs';
import {queryBounded,verifyBoundedQuery} from '../research/bounded-query.mjs';
function rig(){const f=nativeFixture(),dir=fs.mkdtempSync(join(tmpdir(),'purchase-consensus-')),file=join(dir,'state.sqlite');let db=BoundedNetworkInterpreter.create(file,f.s,f.c,hash(f.s));
 const step=(txs,time=1000,options={})=>db.commitBlock({height:db.networkHeader().height+1,time,blockHash:hash([db.networkHeader().height+1,time]),txs},db.root,options);
 return {...f,file,dir,step,get db(){return db;},state:()=>db.snapshotForAudit(),reopen(){const root=db.root;db.close();db=BoundedNetworkInterpreter.open(file,f.c,root);}};}
test('BTC and USDC move native outputs once, preserve supply and index through restart',()=>{
 for(const route of ['BTC','USDC']){const r=rig();try{const q=r.reserve({route}),id=orderId(q.offer),a=r.wire(q,[r.input]);r.step([a]);let s=r.state();
 assert.equal(s.money.outputs[purchaseOutput(s.configHash,id,'escrow')].unlock,Number.MAX_SAFE_INTEGER);assert(!s.money.outputs[r.input]);assert.equal(s.money.fees,'1000');
 r.step([a]);assert.equal(r.state().money.fees,'1000');r.reopen();r.step([r.wire(r.evidence(q))],1010);s=r.state();
 assert.equal(s.money.outputs[purchaseOutput(s.configHash,id,'settlement')].owner,r.buyer.publicKey);assert.equal(s.money.supply,'100000000');assert.equal(s.purchaseBook.supplyMicro,'0');
 r.step([r.wire(r.evidence(q))],1010);r.reopen();assert.equal(r.state().money.fees,'1000');assert.equal(r.state().purchaseBook.orders[id].status,'COMPLETED');
 const page=queryBounded(r.db,{type:'wallet-meta',id:null},r.db.root);assert(page.result.data.money.supply==='100000000');
 const request={type:'wallet-page',id:{owner:r.buyer.publicKey,kind:'outputs',offset:0,limit:32}},outputs=queryBounded(r.db,request,r.db.root);
 assert.equal(verifyBoundedQuery(outputs,request,r.db.root,hash(r.c)).data.items[0].value.value,'10000000');
 const orderRequest={type:'purchase-order',id},proof=queryBounded(r.db,orderRequest,r.db.root);
 assert.equal(verifyBoundedQuery(proof,orderRequest,r.db.root,hash(r.c)).data.status,'COMPLETED');
 proof.result.data.status='AWAITING_PAYMENT';assert.throws(()=>verifyBoundedQuery(proof,orderRequest,r.db.root,hash(r.c)));
 }finally{r.db.close();}}
});
test('native double spend, bad author, bad evidence and partial block are atomic',()=>{
 const r=rig();try{const q=r.reserve(),wire=r.wire(q,[r.input]);const before=r.db.root;
 assert.throws(()=>r.step([r.wire(q,[r.input],keys())]));assert.equal(r.db.root,before);
 assert.throws(()=>r.step([wire],1000,{beforeCommit:()=>{throw Error('power loss');}}),/power loss/);r.reopen();assert.equal(r.db.root,before);
 const q2=r.reserve();assert.throws(()=>r.step([wire,r.wire(q2,[r.input])]));assert.equal(r.db.root,before);
 r.step([wire]);const pin=r.db.root;assert.throws(()=>r.step([r.wire(q2,[r.input])]));assert.equal(r.db.root,pin);
 assert.throws(()=>r.step([r.wire(q2,[purchaseOutput(hash(r.c),orderId(q.offer),'escrow')])]),/locked/);
 const invalid=r.evidence(q);invalid.approvals.pop();assert.throws(()=>r.step([r.wire(invalid)],1010));assert.equal(r.db.root,pin);
 r.reopen();assert.equal(r.state().purchaseBook.orders[orderId(q.offer)].status,'AWAITING_PAYMENT');
 }finally{r.db.close();}
});
test('native refund returns held DUBYT only after full confirmed external refund',()=>{
 const r=rig();try{const q=r.reserve(),id=orderId(q.offer);r.step([r.wire(q,[r.input])]);r.step([r.wire(r.evidence(q,{amountAtomic:'5000'}))],1010);
 let s=r.state();const events=s.purchaseBook.orders[id].received.map(x=>x.event),refund=r.evidence(q,{kind:'REFUND',destination:q.offer.refundDestination,amountAtomic:'5000',txid:hash('refund'),reference:id,refunds:events},1020);
 assert.throws(()=>r.step([r.wire(refund)],1020),/intent/);r.step([r.wire(r.refundIntent(s.purchaseBook.orders[id],1020))],1020);
 const bad=structuredClone(refund);bad.body.amountAtomic='4999';assert.throws(()=>r.step([r.wire(bad)],1020));r.step([r.wire(refund)],1020);r.reopen();s=r.state();
 assert.equal(s.purchaseBook.orders[id].status,'REFUNDED');assert.equal(s.money.outputs[purchaseOutput(s.configHash,id,'settlement')].owner,r.seller.publicKey);assert.equal(s.money.supply,'100000000');
 }finally{r.db.close();}
});
test('real ABCI adapter previews do not persist, finalize commits atomically and replay matches',()=>{
 const r=rig(),app=new BoundedApplication(r.db,{kind:'fresh-genesis'});try{const q=r.reserve(),tx=r.wire(q,[r.input]).toString('base64'),root=r.db.root;
 assert.equal(app.dispatch({method:'check',txs:[tx]}).code,0);assert.equal(r.db.root,root);
 const req={height:1,time:1000,hash:Buffer.from(hash('abci'),'hex').toString('base64'),txs:[tx]};
 assert.deepEqual(app.dispatch({method:'prepare',...req}).txs,[tx]);assert(app.dispatch({method:'process',...req}).accept);const result=app.dispatch({method:'finalize',...req});assert.equal(r.db.root,root);
 app.dispatch({method:'commit'});assert.equal(r.db.root,Buffer.from(result.hash,'base64').toString('hex'));app.dispatch({method:'commit'});
 const other=BoundedNetworkInterpreter.create(join(r.dir,'replay.sqlite'),r.s,r.c,hash(r.s));try{other.commitBlock({height:1,time:1000,blockHash:hash('abci'),txs:[Buffer.from(tx,'base64')]},other.root);assert.equal(other.root,r.db.root);}finally{other.close();}
 }finally{app.close();}
});

test('refund decision rejects immature, stale or forged evidence and quarantines additional deposits',()=>{
 const r=rig();try{const q=r.reserve(),id=orderId(q.offer);r.step([r.wire(q,[r.input])]);
 r.step([r.wire(r.evidence(q,{amountAtomic:'5000',confirmations:1}))],1010);
 assert.throws(()=>r.step([r.wire(r.refundIntent(r.state().purchaseBook.orders[id],1010))],1010),/confirmed fresh/);
 r.step([r.wire(r.evidence(q,{amountAtomic:'5000',paidAt:1010},1020))],1020);
 const intent=r.refundIntent(r.state().purchaseBook.orders[id],1020),bad=structuredClone(intent);bad.approvals.pop();const pinned=r.db.root;
 assert.throws(()=>r.step([r.wire(bad)],1020),/quorum/);assert.equal(r.db.root,pinned);
 assert.throws(()=>r.step([r.wire(r.refundIntent(r.state().purchaseBook.orders[id],1400))],1400),/confirmed fresh/);
 r.step([r.wire(intent)],1020);r.reopen();
 r.step([r.wire(r.evidence(q,{amountAtomic:'5000',txid:hash('second deposit')},1030))],1030);
 const o=r.state().purchaseBook.orders[id];assert.equal(o.status,'PAYMENT_REVIEW');assert.equal(o.escrowMicro,'10000000');
 assert.throws(()=>r.step([r.wire(r.refundIntent(o,1030))],1030),/immutable/);
 assert.throws(()=>r.step([r.wire(r.evidence(q,{kind:'REFUND',amountAtomic:'5000',destination:q.offer.refundDestination,txid:hash('early refund'),reference:id,refunds:intent.body.refunds},1040))],1040),/all observed deposits/);
 assert.equal(r.state().money.supply,'100000000');
 }finally{r.db.close();}
});

test('unpaid closure and subsequent late refund never credit native seller inventory twice',()=>{
 const r=rig();try{const q=r.reserve(),id=orderId(q.offer);r.step([r.wire(q,[r.input])]);
 const patch={kind:'UNPAID',amountAtomic:'0',txid:null,confirmations:0,paidAt:0};
 assert.throws(()=>r.step([r.wire(r.evidence(q,patch,1601))],1601),/grace/);
 r.step([r.wire(r.evidence(q,patch,5201))],5201);const held=JSON.stringify(r.state().money.outputs);
 r.step([r.wire(r.evidence(q,{},5210))],5210);assert.equal(r.state().purchaseBook.orders[id].status,'LATE_PAYMENT_REVIEW');
 const intent=r.refundIntent(r.state().purchaseBook.orders[id],5220);r.step([r.wire(intent)],5220);
 const refund=r.evidence(q,{kind:'REFUND',destination:q.offer.refundDestination,txid:hash('late refund'),reference:id,refunds:intent.body.refunds},5230);r.step([r.wire(refund)],5230);r.reopen();
 assert.equal(r.state().purchaseBook.orders[id].status,'REFUNDED');assert.equal(JSON.stringify(r.state().money.outputs),held);assert.equal(r.state().money.supply,'100000000');assert.equal(r.state().money.fees,'1000');
 }finally{r.db.close();}
});
test('production config cannot enable laboratory purchases; absent gate rejects signed actions',()=>{
 const f=nativeFixture();assert.throws(()=>validateConfig({...f.c,chainId:'duebyte-trial-production'}),/laboratory/);
 const c=structuredClone(f.c);delete c.purchaseLab;const s=origin(c),dir=fs.mkdtempSync(join(tmpdir(),'purchase-gated-')),db=BoundedNetworkInterpreter.create(join(dir,'state.sqlite'),s,c,hash(s));
 try{const a={type:PURCHASE_ACTION,command:f.reserve(),inputs:[f.input]},tx=Buffer.from(JSON.stringify(envelope(c,a,f.seller)));
 assert.throws(()=>db.commitBlock({height:1,time:1000,blockHash:hash('gated'),txs:[tx]},db.root),/disabled/);
 }finally{db.close();}
});
