import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {setup} from './payment-liability.test.mjs';
import {block,stateHash} from '../core.mjs';
import {hash,keys,sign,canonical} from '../crypto.mjs';
import {CONTROL,DELAYED_FEATURE,SPEND_FEATURE} from '../authority.mjs';
import {SCHEDULE_DOMAIN,oid} from '../payment-model.mjs';
import {PROTECTION,approvalBody} from '../spend-protection.mjs';
import {DatabaseSync} from 'node:sqlite';
import {migrateBoundedArchive,verifyBoundedArchive} from '../research/bounded-archive-migration.mjs';
import {previewTokenPrecision} from '../precision-preview.mjs';
import {recoveryBody} from '../reserve-recovery.mjs';
import {BoundedNetworkInterpreter,boundedRecordReads} from '../research/bounded-network-interpreter.mjs';
test('block read cache isolates callers, invalidates writes and never carries trust between blocks',()=>{
 const data=new Map([['a',{nested:{value:1}}]]);let reads=0,fail=false;
 const parent={get:k=>{reads++;if(fail)throw Error('corrupt authenticated path');return structuredClone(data.get(k));},set:(k,v)=>data.set(k,structuredClone(v)),delete:k=>data.delete(k)};
 const first=boundedRecordReads(parent);first.get('a').nested.value=99;assert.equal(first.get('a').nested.value,1);assert.equal(reads,1);
 assert.equal(first.get('absent'),undefined);assert.equal(first.get('absent'),undefined);assert.equal(reads,2);
 first.set('absent',{value:2});assert.deepEqual(first.get('absent'),{value:2});first.set('a',{value:3});assert.deepEqual(first.get('a'),{value:3});first.delete('a');assert.equal(first.get('a'),undefined);
 fail=true;assert.throws(()=>boundedRecordReads(parent).get('absent'),/corrupt authenticated path/);
});
test('block read cache is bounded for both many keys and large records',()=>{
 let reads=0;const source={get:key=>{reads++;return {key,text:'x'.repeat(60000)};},set(){},delete(){}},cache=boundedRecordReads(source);
 cache.get('first');cache.get('first');assert.equal(reads,1);for(let n=0;n<100;n++)cache.get('key'+n);cache.get('first');assert.equal(reads,102);
 reads=0;const small=boundedRecordReads({...source,get:key=>{reads++;return {key};}});small.get('first');for(let n=0;n<8192;n++)small.get('key'+n);small.get('first');assert.equal(reads,8194);
});
function rig(x,initial=x.s){
 const dir=fs.mkdtempSync(join(tmpdir(),'duebyte-bounded-')),file=join(dir,'state.sqlite');let state=structuredClone(initial);
 const db=BoundedNetworkInterpreter.create(file,state,x.c,hash(state));
 const step=(wires=[],time=state.money.time,filter=false)=>{const request={height:state.height+1,blockHash:hash(['block',state.height+1]),time,txs:wires.map(w=>Buffer.from(JSON.stringify(w)))},legacy=block(state,x.c,request,filter),result=db.commitBlock(request,db.root,{filter});state=legacy.state;assert.deepEqual(db.snapshotForAudit(),state);assert.deepEqual(result.value.codes,legacy.codes);return {request,result};};
 return {db,dir,file,step,get state(){return state;}};
}
test('sparse whole block: honest settlement, atomic filtered failure and deterministic journal replay',()=>{
 const x=setup(),r=rig(x),i=x.intent(r.state);r.step([x.reserve(i)]);
 const finish=x.finish(r.state,i),bad=structuredClone(finish);bad.signature=bad.signature.slice(0,-1)+(bad.signature.endsWith('A')?'B':'A');
 const {request}=r.step([bad,finish],r.state.money.time,true);const pin=r.db.root,seq=r.db.store.meta.sequence;
 assert(r.db.commitBlock(request,pin,{filter:true}).value.duplicate);assert.equal(r.db.store.meta.sequence,seq);
 assert.throws(()=>r.db.commitBlock({...request,txs:[]},pin,{filter:true}),/conflicting/);assert.equal(r.db.root,pin);
 for(let n=0;n<5;n++)r.step();
 const replay=BoundedNetworkInterpreter.create(join(r.dir,'replay.sqlite'),x.s,x.c,hash(x.s));
 for(const row of r.db.store.db.prepare('SELECT body FROM journal ORDER BY sequence').all()){const b=JSON.parse(row.body),e=b.event;replay.commitBlock({height:e.height,blockHash:e.blockHash,time:e.time,txs:e.txs.map(t=>Buffer.from(t,'base64'))},replay.root,{filter:e.filter});assert.equal(replay.root,b.root);}
 assert.deepEqual(replay.snapshotForAudit(),r.state);replay.close();r.db.close();
});
test('sparse fault, expiry, fine and compensation match full rules without traversing wallets',()=>{
 const x=setup(),r=rig(x),i=x.intent(r.state);r.step([x.reserve(i)]);r.step([x.wire(x.fault(r.state,i))]);
 while(r.state.money.liability.records[i.pid])r.step();
 assert.equal(r.state.money.liability.pool,'9');assert.equal(r.state.money.liability.protection.compensated,'1');assert.equal(r.state.money.supply,'1600');
 r.step([x.wire(x.queue(r.state),x.founder)]);const pending=r.state.money.liability.protection.pending;r.step([],pending.expiresAt+1);assert.equal(r.state.money.liability.protection.pending,null);r.db.close();
});
test('sparse signed validator rotation and invalid quorum retain exact authority',()=>{
 const x=setup(),r=rig(x),next=keys(),b={domain:CONTROL+'/VALIDATOR',network:x.c.chainId,configHash:hash(x.c),generation:0,slot:9,oldKey:x.validators[9].publicKey,newKey:next.publicKey,group:hash({i:9}),notBefore:r.state.height+1,expires:r.state.height+10};
 const action={type:'ROTATE_VALIDATOR',certificate:{body:b,approvals:x.approvals(b),possession:sign(b,next.privateKey)}},bad=structuredClone(action);bad.certificate.approvals.pop();r.step([x.wire(bad),x.wire(action)],r.state.money.time,true);r.step();r.step();assert.equal(r.state.authority.validators[9].key,next.publicKey);r.db.close();
});
test('sparse two-of-three recovery retains delay and original balances',()=>{
 const x=setup(),r=rig(x),replacement=keys(),body=recoveryBody(r.state,'SCHEDULE_DEVELOPMENT_RECOVERY_V1',{sequence:1,manager:replacement.publicKey,recovery:r.state.networkReserves.development.access.recovery,expiresAt:r.state.money.time+300});
 const a={type:'SCHEDULE_DEVELOPMENT_RECOVERY_V1',body,approvals:x.backups.slice(0,2).map(k=>({key:k.publicKey,signature:sign(body,k.privateKey)})),newConsent:sign(body,replacement.privateKey),newRecoveryConsents:x.backups.map(k=>({key:k.publicKey,signature:sign(body,k.privateKey)}))};r.step([x.wire(a)]);
 const p=r.state.networkReserves.development.access.pending,execute={type:'EXECUTE_DEVELOPMENT_RECOVERY_V1',managementEpoch:r.state.networkReserves.development.access.epoch,sequence:p.sequence,requestHash:p.requestHash};
 r.step([x.wire(execute)],r.state.money.time,true);r.step([x.wire(execute)],p.notBefore);assert.equal(r.state.networkReserves.development.access.manager,replacement.publicKey);assert.deepEqual(r.state.money.outputs,x.s.money.outputs);r.db.close();
});
test('sparse abrupt process exit rolls back the entire block and retries once',()=>{
 const x=setup(),r=rig(x),pin=r.db.root,seq=r.db.store.meta.sequence,request={height:x.s.height+1,blockHash:hash('crash'),time:x.s.money.time,txs:[]};r.db.close();
 const module=new URL('../research/bounded-network-interpreter.mjs',import.meta.url).href,script=`import {BoundedNetworkInterpreter} from ${JSON.stringify(module)};const db=BoundedNetworkInterpreter.open(${JSON.stringify(r.file)},${JSON.stringify(x.c)},${JSON.stringify(pin)});db.commitBlock(${JSON.stringify(request)},db.root,{beforeCommit:()=>process.exit(77)});`;
 assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',script],{stdio:'pipe',windowsHide:true}),e=>e.status===77);
 const db=BoundedNetworkInterpreter.open(r.file,x.c,pin);assert.deepEqual(db.snapshotForAudit(),x.s);assert.equal(db.store.meta.sequence,seq);db.commitBlock(request,pin);assert(db.commitBlock(request,db.root).value.duplicate);assert.throws(()=>db.commitBlock({...request,height:request.height+1},pin),/stale/);db.close();
});
test('state above 1 MiB processes signed payments with no full collection traversal',()=>{
 const x=setup(),s=structuredClone(x.s);for(let n=0;n<10000;n++)s.money.outputs[hash(['holder',n])]={owner:Buffer.from(hash(['owner',n]),'hex').toString('base64url'),value:'1',unlock:0};s.money.supply=String(BigInt(s.money.supply)+10000n);
 assert(Buffer.byteLength(canonical(s))>1048576);assert.throws(()=>stateHash(s,x.c),/snapshot limit/);
 const dir=fs.mkdtempSync(join(tmpdir(),'duebyte-large-block-')),db=BoundedNetworkInterpreter.create(join(dir,'state.sqlite'),s,x.c,hash(s)),scan=db.store.scanAuthenticated;
 db.store.scanAuthenticated=()=>{throw Error('full scan forbidden in hot path');};
 const i=x.intent(s),request={height:s.height+1,blockHash:hash('large-reserve'),time:s.money.time,txs:[Buffer.from(JSON.stringify(x.reserve(i)))]},result=db.commitBlock(request,db.root);assert(result.value.recordsRead<30);db.store.scanAuthenticated=scan;
 const after=db.snapshotForAudit();assert.equal(after.money.requests[i.pid].status,'RESERVED');assert.equal(after.money.supply,s.money.supply);assert.equal(Object.keys(after.money.outputs).length,10000);db.close();
});
test('chunked controller, block budgets and unsupported issuance fail closed',()=>{
 const x=setup(),s=structuredClone(x.s);s.authority.usedKeys=[...s.authority.usedKeys,...Array.from({length:1600},(_,i)=>Buffer.from(hash(['retired',i]),'hex').toString('base64url'))].sort();const r=rig(x,s);
 assert(r.db.store.db.prepare("SELECT count(*) n FROM nodes WHERE key LIKE 'meta/network/chunk/%'").get().n>1);
 const wires=Array.from({length:64},()=>x.wire({type:'UNSUPPORTED',padding:'x'.repeat(4096)}));const {request}=r.step(wires,r.state.money.time,true),pin=r.db.root;
 assert.throws(()=>r.db.commitBlock({...request,height:request.height+1,txs:Array.from({length:64},()=>Buffer.alloc(20000))},pin,{filter:true}),/byte budget/);assert.equal(r.db.root,pin);
 r.step([x.wire({type:'ISSUE_NETWORK_RESERVES_V1'})],r.state.money.time,true);assert.equal(r.state.networkReserves.issued,null);assert.equal(r.state.money.supply,'1600');r.db.close();
});
function feature(x,r,name,type){const b={domain:CONTROL+'/FEATURE',network:x.c.chainId,configHash:hash(x.c),generation:r.state.authority.generation,feature:name,activation:r.state.height+4,notBefore:r.state.height+1,expires:r.state.height+2};r.step([x.wire({type,certificate:{body:b,approvals:x.approvals(b)}})]);while(r.state.height<b.activation)r.step();}
for(const cancel of [false,true])test('sparse scheduled release and cancellation; cancel='+cancel,()=>{
 const x=setup(),r=rig(x);feature(x,r,DELAYED_FEATURE,'ENABLE_DELAYED_PAYMENTS');const i=x.intent(r.state,{domain:SCHEDULE_DOMAIN,sendDelay:86400,delay:86400});r.step([x.reserve(i)]);r.step([x.finish(r.state,i)]);
 if(cancel)r.step([x.wire({type:'CANCEL_SCHEDULED_PAYMENT_V1',pid:i.pid,request:hash(i)})]);r.step([],r.state.money.time+86410);
 assert.equal(r.state.money.requests[i.pid].status,cancel?'CANCELLED':'SETTLED');if(!cancel)assert.equal(r.state.money.outputs[oid(i.pid,'recipient')].unlock,r.state.money.time+86400);r.db.close();
});
test('sparse owner index authorizes only funded wallets and preserves second-signature protection',()=>{
 const x=setup(),r=rig(x),approver=keys(),recovery=keys();feature(x,r,SPEND_FEATURE,'ENABLE_SPEND_PROTECTION_V1');
 const action=wallet=>{const body={domain:PROTECTION+'/SET_SPEND_POLICY_V1',configHash:hash(x.c),wallet:wallet.publicKey,version:1,issuedAt:r.state.money.time,expires:r.state.money.time+600,policy:{version:1,enabled:true,approver:approver.publicKey,recovery:recovery.publicKey,recoveryDelay:86400}};return x.wire({type:'SET_SPEND_POLICY_V1',body,signatures:{wallet:sign(body,wallet.privateKey),current:null,approver:sign(body,approver.privateKey),recovery:sign(body,recovery.privateKey)}},wallet);};
 r.step([action(x.f.bob),action(x.f.alice)],r.state.money.time,true);assert(!r.state.spendPolicies[x.f.bob.publicKey]);assert(r.state.spendPolicies[x.f.alice.publicKey]);
 const i=x.intent(r.state),wire=x.reserve(i);r.step([wire],r.state.money.time,true);assert(!r.state.money.requests[i.pid]);const body=approvalBody(r.state,i,r.state.money.time+600);r.step([x.wire({...wire.body.action,approval:{body,signature:sign(body,approver.privateKey)}})]);r.step([x.finish(r.state,i)]);r.step([action(x.f.bob)]);assert(r.state.spendPolicies[x.f.bob.publicKey]);r.db.close();
});
test('filtered invalid action does not hide authenticated database corruption',()=>{
 const x=setup(),r=rig(x),pin=r.db.root,original=r.db.store._find.bind(r.db.store);r.db.store._find=(ref,key,...rest)=>{if(key==='outputs/'+x.f.input)throw Error('simulated record corruption');return original(ref,key,...rest);};
 const request={height:r.state.height+1,blockHash:hash('corrupt'),time:r.state.money.time,txs:[Buffer.from(JSON.stringify(x.reserve(x.intent(r.state))))]};assert.throws(()=>r.db.commitBlock(request,pin,{filter:true}),/authenticated storage read/);assert.equal(r.db.root,pin);r.db.store._find=original;assert.deepEqual(r.db.snapshotForAudit(),x.s);r.db.close();
});
test('archive migration retains exact rows and blocks incomplete or tampered history',()=>{
 const x=setup(),dir=fs.mkdtempSync(join(tmpdir(),'duebyte-bounded-archive-')),source=join(dir,'source.sqlite'),target=join(dir,'target.sqlite'),old=new DatabaseSync(source);old.exec('CREATE TABLE blocks(height INTEGER PRIMARY KEY,body TEXT NOT NULL,root TEXT NOT NULL)');old.prepare('INSERT INTO blocks VALUES(?,?,?)').run(x.s.height,canonical(x.s),hash(x.s));old.close();
 const db=migrateBoundedArchive(source,target,x.c,hash(x.s));assert.deepEqual(db.snapshotForAudit(),x.s);const summary=verifyBoundedArchive(db);assert(summary.count>=1);
 const saved=db.store.db.prepare('SELECT * FROM blocks ORDER BY height LIMIT 1').get();db.store.db.prepare('UPDATE blocks SET body=? WHERE height=?').run(saved.body+' ',saved.height);assert.throws(()=>verifyBoundedArchive(db),/digest/);db.store.db.prepare('UPDATE blocks SET body=? WHERE height=?').run(saved.body,saved.height);verifyBoundedArchive(db);db.close();
 const interrupted=join(dir,'interrupted.sqlite');assert.throws(()=>migrateBoundedArchive(source,interrupted,x.c,hash(x.s),{afterCopy:()=>{throw Error('interrupted copy');}}),/interrupted/);const raw=new DatabaseSync(interrupted),pin=raw.prepare('SELECT rootHash FROM meta').get().rootHash;assert.equal(raw.prepare('SELECT count(*) n FROM blocks').get().n,0);raw.close();assert.throws(()=>BoundedNetworkInterpreter.open(interrupted,x.c,pin),/incomplete archive/);
});
test('sparse fractional settlement keeps exact micro units and rejects the old denomination',()=>{
 const x=setup(),initial=previewTokenPrecision(x.s).state,r=rig(x,initial),i=x.intent(r.state,{epoch:1,unitScale:'1000000',value:'123',fee:'4',abortFee:'4',parts:[{value:'61',nodes:x.f.ids.slice(0,3)},{value:'62',nodes:x.f.ids.slice(3)}]});
 r.step([x.reserve(x.intent(r.state))],r.state.money.time,true);r.step([x.reserve(i)]);r.step([x.finish(r.state,i)]);assert.equal(r.state.money.outputs[oid(i.pid,'recipient')].value,'123');assert.equal(r.state.money.fees,'4');assert.equal(r.state.money.supply,initial.money.supply);r.db.close();
});
test('sparse wide timer batch exceeds 256 changed records and rolls back as one block',()=>{
 const x=setup({prepare:false}),s=structuredClone(x.s),base=s.money.height;s.money.outputs={};s.money.nodes={};s.money.supply='53000';
 for(let p=0;p<5;p++){s.money.outputs[hash(['batch-input',p])]={owner:x.f.alice.publicKey,value:'1000',unlock:0};for(let n=0;n<96;n++)s.money.nodes[hash(['batch-node',p,n])]={key:x.f.workers[n%6].publicKey,operator:hash(['batch-owner',n]),stake:'100',consensusHeld:'2',taskHeld:'0',tier:'90'};}
 const r=rig(x,s),intents=Array.from({length:5},(_,p)=>x.intent(s,{inputs:[hash(['batch-input',p])],value:'32',fee:'1',abortFee:'1',lastReserve:base+8,deadline:base+9,parts:Array.from({length:32},(_,index)=>({value:'1',nodes:[0,1,2].map(n=>hash(['batch-node',p,index*3+n]))}))}));r.step(intents.map(x.reserve));
 let biggest=0;while(r.state.money.requests[intents[0].pid].status==='RESERVED'){
  const request={height:r.state.height+1,blockHash:hash(['block',r.state.height+1]),time:r.state.money.time,txs:[]},pin=r.db.root;
  assert.throws(()=>r.db.commitBlock(request,pin,{beforeCommit:()=>{throw Error('batch interrupted');}}),/batch interrupted/);assert.equal(r.db.root,pin);biggest=Math.max(biggest,r.step().result.changed);
 }assert(biggest>256);assert(Object.values(r.state.money.nodes).every(n=>n.taskHeld==='0'));r.db.close();
});
test('sparse retained terminal history exceeds legacy pruning without changing money or collateral',()=>{
 const x=setup(),dir=fs.mkdtempSync(join(tmpdir(),'duebyte-retained-')),db=BoundedNetworkInterpreter.create(join(dir,'state.sqlite'),x.s,x.c,hash(x.s));let state=x.s,input=x.f.input,first;
 const step=wire=>{const request={height:state.height+1,blockHash:hash(['retention',state.height+1]),time:state.money.time,txs:wire?[Buffer.from(JSON.stringify(wire))]:[]};state=block(state,x.c,request).state;db.commitBlock(request,db.root);const sparse=db.snapshotForAudit();const {requests:legacyRequests,...legacyMoney}=state.money,{requests:sparseRequests,...sparseMoney}=sparse.money;assert.deepEqual(sparseMoney,legacyMoney);assert.deepEqual(sparse.authority,state.authority);return sparse;};
 for(let n=0;n<36;n++){const i=x.intent(state,{inputs:[input],value:'1',fee:'1',abortFee:'1',parts:[{value:'1',nodes:x.f.ids.slice(0,3)}]});first??=i;step(x.reserve(i));step(x.finish(state,i));input=oid(i.pid,'change');for(let k=0;k<3;k++)step();}
 const sparse=db.snapshotForAudit();assert.equal(Object.keys(sparse.money.requests).length,36);assert.equal(Object.keys(state.money.requests).length,32);assert.equal(sparse.money.fees,'36');const request={height:sparse.height+1,blockHash:hash('old replay retained'),time:sparse.money.time,txs:[Buffer.from(JSON.stringify(x.reserve(first)))]};db.commitBlock(request,db.root);assert.equal(db.snapshotForAudit().money.fees,'36');db.close();
});
