import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {persistHead,VerifiedClient,extendRecoveryCheckpoint,resumeRecoveryProgress} from '../client.mjs';
import {inspectRequired,recoverPath} from '../recovery.mjs';
import {hash,keys} from '../crypto.mjs';
import {CHECKPOINT,attest} from '../checkpoint.mjs';
test('another verifier cannot roll back or overwrite a concurrently advanced retained head',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE head(id INTEGER PRIMARY KEY,height INTEGER,hash TEXT)');
 persistHead(db,{height:10,blockHash:hash('10')},null);const old=db.prepare('SELECT * FROM head').get();
 persistHead(db,{height:12,blockHash:hash('12')},old);
 assert.throws(()=>persistHead(db,{height:11,blockHash:hash('11')},old),/another verifier/);
 assert.equal(db.prepare('SELECT height FROM head').get().height,12);const current=db.prepare('SELECT * FROM head').get();
 assert.throws(()=>persistHead(db,{height:11,blockHash:hash('11')},current),/rollback/);
 assert.throws(()=>persistHead(db,{height:12,blockHash:hash('fork')},current),/conflict/);db.close();
});
test('a required retained checkpoint must match both block and state commitments',()=>{
 const requirement={id:'pin',height:10,blockHash:hash('b'),appHash:hash('s')},proof={headers:[{header:{height:'10',app_hash:hash('s').toUpperCase()},commit:{block_id:{hash:hash('b').toUpperCase()}}}]};
 assert.deepEqual(inspectRequired(proof,[requirement],[]),['pin']);proof.headers[0].header.app_hash=hash('other');assert.throws(()=>inspectRequired(proof,[requirement],[]),/state conflict/);
});
test('a persisted indexed transition cannot be bypassed through legacy accept or bridge paths',()=>{
 const db=new DatabaseSync(':memory:'),client={book:{db},bounded:null};
 try{VerifiedClient.prototype.assertLegacyMode.call(client);db.exec('CREATE TABLE indexed_transition(id INTEGER PRIMARY KEY,terms TEXT NOT NULL)');VerifiedClient.prototype.assertLegacyMode.call(client);
  db.prepare('INSERT INTO indexed_transition VALUES(1,?)').run('{}');assert.throws(()=>VerifiedClient.prototype.assertLegacyMode.call(client),/cannot fall back/);
  db.exec('DELETE FROM indexed_transition');client.bounded={};assert.throws(()=>VerifiedClient.prototype.assertLegacyMode.call(client),/indexed clients/);
 }finally{db.close();}
});

const windowResult=end=>({proof:{headers:[{header:{height:String(end),app_hash:hash('state'+end)},commit:{block_id:{hash:hash('block'+end)}}}]},verified:{height:end,blockHash:hash('block'+end)},bytes:100});
test('slow transport reduces windows and persists only verified overlapping progress',async()=>{
 const calls=[],saved=[];
 const fetch=async q=>{calls.push([q.anchor.height,q.end,q.fresh]);if(q.end-q.anchor.height>3)throw Object.assign(new Error('timeout'),{code:'RECOVERY_TRANSPORT_TIMEOUT'});return windowResult(q.end);};
 const result=await recoverPath({anchor:{height:10,blockHash:hash('block10')},target:20,window:16,fetch,save:p=>saved.push(p),requirements:[{id:'last',height:20,blockHash:hash('block20')}]});
 assert.deepEqual(calls,[[10,20,true],[10,15,false],[10,12,false],[12,14,false],[14,16,false],[16,18,false],[18,20,true]]);
 assert.deepEqual(saved.map(p=>p.cursor.height),[12,14,16,18,20]);assert.equal(result.verified.height,20);assert.equal(result.windows,5);
 const resumed=await recoverPath({anchor:{height:10,blockHash:hash('block10')},target:22,progress:saved.at(-1),fetch,save:()=>{}});
 assert.equal(resumed.verified.height,22);assert.deepEqual(calls.at(-1),[20,22,true]);
});
test('invalid proofs do not trigger smaller retries or save progress',async()=>{
 let calls=0,saves=0;
 await assert.rejects(recoverPath({anchor:{height:10},target:20,fetch:async()=>{calls++;throw Error('signature mismatch');},save:()=>saves++}),/signature mismatch/);
 assert.equal(calls,1);assert.equal(saves,0);
 await assert.rejects(recoverPath({anchor:{height:10},target:20,fetch:async()=>windowResult(10),save:()=>saves++}),/window end/);assert.equal(saves,0);
});
test('large validator header windows shrink on byte limits without trusting truncated evidence',async()=>{
 const calls=[],saved=[];const fetch=async q=>{calls.push([q.anchor.height,q.end]);if(q.end-q.anchor.height>2)throw Object.assign(Error('bounded export'),{code:'RECOVERY_WINDOW_TOO_LARGE'});return windowResult(q.end);};
 const result=await recoverPath({anchor:{height:10,blockHash:hash('block10')},target:20,window:16,fetch,save:p=>saved.push(p)});
 assert.equal(result.verified.height,20);assert.equal(saved[0].cursor.height,12);assert(calls.length>saved.length);assert(saved.every((p,i)=>i===0||p.cursor.height>saved[i-1].cursor.height));
 let savedInvalid=false;await assert.rejects(()=>recoverPath({anchor:{height:10},target:11,fetch:async()=>{throw Object.assign(Error('one header too large'),{code:'RECOVERY_WINDOW_TOO_LARGE'});},save:()=>{savedInvalid=true;}}),/one header too large/);assert.equal(savedInvalid,false);
});
test('complete transport outage terminates at the smallest window without advancing',async()=>{
 const ends=[];let saves=0;
 await assert.rejects(recoverPath({anchor:{height:10},target:20,fetch:async q=>{ends.push(q.end);throw Object.assign(Error('timeout'),{code:'RECOVERY_TRANSPORT_TIMEOUT'});},save:()=>saves++}),/timeout/);
 assert.deepEqual(ends,[20,15,12,11]);assert.equal(saves,0);
});

test('long offline recovery extends the verified path to the current head before freshness verification',async()=>{
 const calls=[],saved=[],tips=[25,27,27];
 const result=await recoverPath({anchor:{height:10,blockHash:hash('block10')},target:20,window:6,refreshTarget:async()=>tips.shift(),fetch:async q=>{calls.push([q.anchor.height,q.end,q.fresh]);return windowResult(q.end);},save:p=>saved.push(p),requirements:[{id:'original-target',height:20,blockHash:hash('block20')}]});
 assert.deepEqual(calls,[[10,15,false],[15,20,false],[20,25,false],[25,27,true]]);assert.equal(result.verified.height,27);assert(saved.at(-1).seen.includes('original-target'));assert(calls.every(([a,b])=>b-a<6));
});

test('refreshing recovery cannot lower the target or bypass final freshness and signature checks',async()=>{
 for(const tip of [19,NaN,20.5]){let fetched=0;await assert.rejects(recoverPath({anchor:{height:10},target:20,refreshTarget:async()=>tip,fetch:async()=>{fetched++;return windowResult(20);}}),/rollback/);assert.equal(fetched,0);}
 let saved=0;await assert.rejects(recoverPath({anchor:{height:10},target:20,refreshTarget:async()=>20,fetch:async q=>{assert(q.fresh);throw Error('stale/future head');},save:()=>saved++}),/stale/);assert.equal(saved,0);
 let tip=20;await assert.rejects(recoverPath({anchor:{height:10},target:20,window:2,refreshTarget:async()=>++tip,fetch:async q=>windowResult(q.end)}),/keeps advancing/);
});

test('a long recovery refreshes checkpoint expiry only through signed commitments on the remaining path',async()=>{
 const ks=Array.from({length:4},keys),now=Math.floor(Date.now()/1000),policy={domain:CHECKPOINT+'/POLICY',version:1,network:'duebyte-trial-recovery',genesisHash:hash('genesis'),members:ks.map((k,i)=>({key:k.publicKey,group:hash(i)})),threshold:3,maxAge:900,notAfter:now+7200};
 const body={domain:CHECKPOINT,policyHash:hash(policy),network:policy.network,genesisHash:policy.genesisHash,sequence:1,height:10,appHeight:9,blockHash:hash('block10'),appHash:hash('state10'),snapshotHash:hash('snapshot'),previous:null,issuedAt:now-1200,expiresAt:now-300};
 const signed=b=>({body:b,signatures:ks.slice(0,3).map(k=>attest(b,k))}),doc=signed(body),offered=signed({...body,sequence:2,height:20,appHeight:19,previous:hash(body),blockHash:hash('block20'),appHash:hash('state20'),issuedAt:now,expiresAt:now+900}),requirements=[{id:'retained',height:10,blockHash:body.blockHash}],args={offered,doc,policy,cursor:{height:15},target:25,requirements};
 assert.equal(extendRecoveryCheckpoint(args),offered);assert.equal(requirements.length,2);assert.equal(requirements[1].appHash,offered.body.appHash);assert.equal(extendRecoveryCheckpoint({...args,doc:offered}),offered);assert.equal(requirements.length,2);
 const failed=[];await assert.rejects(recoverPath({anchor:{height:15},target:25,requirements:[requirements[1]],fetch:async q=>windowResult(q.end),save:p=>failed.push(p)}),/not visited/);
 assert.equal(extendRecoveryCheckpoint({...args,cursor:{height:21},requirements:[]}),doc);assert.equal(extendRecoveryCheckpoint({...args,target:19,requirements:[]}),doc);
 assert.throws(()=>extendRecoveryCheckpoint({...args,offered:{...offered,signatures:offered.signatures.slice(0,2)}}),/quorum/);
 assert.throws(()=>extendRecoveryCheckpoint({...args,offered:signed({...offered.body,appHash:hash('conflict')}),doc:offered}),/equivocation/);
 assert.throws(()=>extendRecoveryCheckpoint({...args,offered:signed({...offered.body,issuedAt:now-1200,expiresAt:now-300})}),/expired/);
});

test('interrupted recovery resumes verified progress across newer checkpoints without skipping commitments',()=>{
 const progress={cursor:{height:100,blockHash:hash('100')},seen:['head:old','checkpoint:old']},row={context:'anchor-policy-transition',body:JSON.stringify(progress)};
 assert.deepEqual(resumeRecoveryProgress(row,row.context,[{id:'head:old',height:10},{id:'checkpoint:new',height:120}]),progress);
 assert.equal(resumeRecoveryProgress(row,row.context,[{id:'checkpoint:new',height:90}]),null);
 assert.deepEqual(resumeRecoveryProgress(row,row.context,[{id:'checkpoint:old',height:90}]),progress);
 assert.deepEqual(resumeRecoveryProgress(row,row.context,[{id:'checkpoint:new',height:100}]),progress);
 assert.equal(resumeRecoveryProgress(row,'different-authority',[]),null);
});
