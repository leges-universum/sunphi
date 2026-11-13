import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {persistHead,VerifiedClient} from '../client.mjs';
import {inspectRequired,recoverPath} from '../recovery.mjs';
import {hash} from '../crypto.mjs';
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
test('complete transport outage terminates at the smallest window without advancing',async()=>{
 const ends=[];let saves=0;
 await assert.rejects(recoverPath({anchor:{height:10},target:20,fetch:async q=>{ends.push(q.end);throw Object.assign(Error('timeout'),{code:'RECOVERY_TRANSPORT_TIMEOUT'});},save:()=>saves++}),/timeout/);
 assert.deepEqual(ends,[20,15,12,11]);assert.equal(saves,0);
});
