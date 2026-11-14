// Durable operator approval of an exact owner-signed deposit. No broadcast.
import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {chmodSync} from 'node:fs';import {exact,hash,hex,sign,verify} from './crypto.mjs';
import {prepareCollateralReview} from './worker-collateral-plan.mjs';
import {queryBounded} from './research/bounded-query.mjs';
export function fundingState(handler,node,body){assert(Array.isArray(body.inputs)&&body.inputs.length>0&&body.inputs.length<=8);body.inputs.forEach(hex);assert.equal(body.node,node);const root=handler.root,read=(type,id)=>queryBounded(handler,{type,id},root).result.data,meta=read('wallet-meta',null);return {...meta.network,money:{...meta.money,requests:{},nodes:{[node]:read('node',node)},outputs:Object.fromEntries(body.inputs.map(id=>[id,read('output',id)]).filter(([,o])=>o))}};}
import {formatToken} from './token-units.mjs';import {FUND_WORKER} from './worker-collateral.mjs';
export const FUNDING_REQUEST='DUEBYTE_COLLATERAL_REQUEST_V1',FUNDING_REPLY='DUEBYTE_COLLATERAL_REPLY_V1';
export function checkFundingConsent(consent,s,key,{now=Date.now}={}){
 exact(consent,['format','type','body','ownerSignature','expectedWorkerKey','workerSignatureRequired','submitted']);
 assert.equal(consent.format,'DUEBYTE_COLLATERAL_OWNER_CONSENT_V1');assert.equal(consent.type,FUND_WORKER);assert.equal(consent.workerSignatureRequired,true);assert.equal(consent.submitted,false);
 const b=consent.body;exact(b,['domain','configHash','node','owner','sequence','issuedAt','expires','unitScale','inputs','valueMicro']);
 assert.equal(b.node,key.node);assert.equal(s.money.nodes[b.node]?.key,key.publicKey);assert.equal(consent.expectedWorkerKey,key.publicKey);assert.equal(b.configHash,s.configHash);assert(verify(b,consent.ownerSignature,b.owner),'Owner signature invalid');
 assert(Math.abs(Math.floor(now()/1000)-s.money.time)<=60,'Node is not current');
 const prior=s.workerFunding?.accounts[b.node];
 if(prior?.sequence===b.sequence&&prior.lastBodyHash===hash(b)&&prior.owner===b.owner)return 'committed';
 assert(b.issuedAt<=s.money.time&&s.money.time<b.expires&&b.expires-b.issuedAt<=600,'Funding request expired');
 const r=prepareCollateralReview(s,{node:b.node,owner:b.owner,inputs:b.inputs,amount:formatToken(b.valueMicro,b.unitScale),unitScale:b.unitScale});
 assert.deepEqual({...r.body,issuedAt:b.issuedAt,expires:b.expires},b,'Funding terms changed');return 'current';
}
export class FundingQueue{
 constructor(file,{configHash,key,view,now=Date.now,capacity=64}){
  assert(Number.isInteger(capacity)&&capacity>0&&capacity<=128);this.key=key;this.view=view;this.now=now;this.capacity=capacity;
  this.db=new DatabaseSync(file);chmodSync(file,0o600);this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS binding(id INTEGER PRIMARY KEY CHECK(id=1), pin TEXT NOT NULL); CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, expires INTEGER NOT NULL, consent TEXT NOT NULL, decision TEXT NOT NULL, action TEXT); CREATE INDEX IF NOT EXISTS expiry ON requests(expires);');
  const pin=hash({configHash,node:key.node,key:key.publicKey});this.db.prepare('INSERT OR IGNORE INTO binding VALUES(1,?)').run(pin);assert.equal(this.db.prepare('SELECT pin FROM binding').get().pin,pin);
 }
 state(c){const s=this.view(c.body);checkFundingConsent(c,s,this.key,{now:this.now});return s;}
 reply(id,status,action=null){const body={domain:FUNDING_REPLY,id,node:this.key.node,status,actionHash:action?hash(action):null};return {body,signature:sign(body,this.key.privateKey),action};}
 request(q){const second=Math.floor(this.now()/1000);if(this.window!==second){this.window=second;this.count=0;}assert(++this.count<=12,'Server approval is busy; retry shortly');exact(q,['operation','consent']);assert.equal(q.operation,FUNDING_REQUEST);const c=q.consent,s=this.state(c),id=hash(c.body),prior=s.workerFunding?.accounts[c.body.node];
  if(prior?.sequence===c.body.sequence&&prior.lastBodyHash===id)return this.reply(id,'committed');
  let row=this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);
  if(!row){this.db.prepare('DELETE FROM requests WHERE expires<=?').run(s.money.time);assert(this.db.prepare('SELECT count(*) AS n FROM requests').get().n<this.capacity,'Server approval queue is full');this.db.prepare('INSERT INTO requests VALUES(?,?,?,?,NULL)').run(id,c.body.expires,JSON.stringify(c),'pending');row={decision:'pending',action:null};}
  return this.reply(id,row.decision,row.action?JSON.parse(row.action):null);
 }
 list(){return this.db.prepare('SELECT * FROM requests ORDER BY expires DESC,id LIMIT 64').all().map(row=>{const c=JSON.parse(row.consent);return {id:row.id,node:c.body.node,owner:c.body.owner,amount:formatToken(c.body.valueMicro,c.body.unitScale),expires:c.body.expires,status:row.decision,canApprove:Math.floor(this.now()/1000)<c.body.expires&&row.decision==='pending'};});}
 decide(q){exact(q,['id','decision']);const {id,decision}=q;hex(id);assert(['approve','reject'].includes(decision));const row=this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);assert(row,'Unknown funding request');
  assert.equal(row.decision,'pending','Request already decided');const c=JSON.parse(row.consent);this.state(c);
  const action=decision==='approve'?{type:FUND_WORKER,body:c.body,ownerSignature:c.ownerSignature,workerSignature:sign(c.body,this.key.privateKey)}:null;
  this.db.prepare('UPDATE requests SET decision=?,action=? WHERE id=? AND decision=?').run(decision==='approve'?'approved':'rejected',action?JSON.stringify(action):null,id,'pending');return {id,status:decision==='approve'?'approved':'rejected'};
 }
 close(){this.db.close();}
}
