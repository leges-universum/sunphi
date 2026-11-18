// Separate external trust, not a substitute consensus certificate or TUF implementation.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {hash,exact,hex,integer,publicKey,verify,sign} from './crypto.mjs';
import {documentPolicy} from './authority.mjs';
export const CHECKPOINT='DUEBYTE_CHECKPOINT_TRIAL_V1';
export function validatePolicy(p){
 exact(p,['domain','version','network','genesisHash','members','threshold','maxAge','notAfter']);
 assert.equal(p.domain,CHECKPOINT+'/POLICY');integer(p.version,1);hex(p.genesisHash);assert(/^duebyte-trial-[a-z0-9-]{1,50}$/.test(p.network));
 assert(Array.isArray(p.members)&&p.members.length>=4&&p.members.length<=32);const ids=new Set(),groups=new Set();
 for(const m of p.members){exact(m,['key','group']);publicKey(m.key);hex(m.group);assert(!ids.has(m.key)&&!groups.has(m.group),'independent seats');ids.add(m.key);groups.add(m.group);}
 integer(p.threshold,1);assert(p.threshold>2*p.members.length/3&&p.threshold<=p.members.length,'quorum intersection');
 integer(p.maxAge,1);assert(p.maxAge<=86400);integer(p.notAfter,1);return hash(p);
}
export function verifyBody(b,policy,{now=Math.floor(Date.now()/1000),previous=null,allowGap=false}={}){
 const policyHash=validatePolicy(policy);
 exact(b,['domain','policyHash','network','genesisHash','sequence','height','blockHash','appHeight','appHash','snapshotHash','previous','issuedAt','expiresAt']);
 assert.equal(b.domain,CHECKPOINT);assert.equal(b.policyHash,policyHash);assert.equal(b.network,policy.network);assert.equal(b.genesisHash,policy.genesisHash);
 for(const k of ['blockHash','appHash','snapshotHash'])hex(b[k]);assert(b.previous===null||hex(b.previous));
 integer(b.sequence,1);integer(b.height,2);assert.equal(b.appHeight,b.height-1);integer(b.issuedAt,1);integer(b.expiresAt,1);integer(now,1);
 assert(b.issuedAt<=now+30&&b.expiresAt>now&&b.expiresAt>b.issuedAt&&b.expiresAt-b.issuedAt<=policy.maxAge&&now<policy.notAfter,'expired/future trust');
 if(previous){
  assert(b.sequence>=previous.body.sequence&&b.height>=previous.body.height,'checkpoint rollback');
  if(b.sequence===previous.body.sequence){assert.equal(hash(b),hash(previous.body),'checkpoint equivocation');}
  else {if(!allowGap||b.sequence===previous.body.sequence+1){assert.equal(b.sequence,previous.body.sequence+1,'missing checkpoint sequence');assert.equal(b.previous,hash(previous.body),'checkpoint parent');}assert(b.height>previous.body.height,'checkpoint height');assert(b.issuedAt>=previous.body.issuedAt,'checkpoint time rollback');}
 }
 return {id:hash(b),body:structuredClone(b)};
}
export function checkpointPolicy(doc,root,configHash){
 const renewals=doc.renewals??[];
 return documentPolicy(root,renewals,configHash??renewals[0]?.certificate.body.configHash);
}
export function verifyCheckpoint(doc,root,options={}){exact(doc,['body','signatures',...(doc.renewals?['renewals']:[])]);const policy=checkpointPolicy(doc,root,options.configHash);
 if(options.previous){const old=options.previous.renewals??[],next=doc.renewals??[];assert(next.length>=old.length&&hash(next.slice(0,old.length))===hash(old),'policy lineage rollback or conflict');}
 assert((doc.renewals??[]).every(r=>r.height<=doc.body.appHeight),'policy not yet committed');
 const v=verifyBody(doc.body,policy,options);assert(Array.isArray(doc.signatures)&&doc.signatures.length<=policy.members.length);const members=new Set(policy.members.map(x=>x.key)),seen=new Set();for(const s of doc.signatures){exact(s,['key','signature']);assert(members.has(s.key)&&!seen.has(s.key),'unknown/duplicate attester');assert(verify(doc.body,s.signature,s.key),'checkpoint signature');seen.add(s.key);}assert(seen.size>=policy.threshold,'checkpoint quorum');return {...v,policy};}
export function attest(body,k){return {key:k.publicKey,signature:sign(body,k.privateKey)};}
export class CheckpointBook{
 constructor(file,policy){validatePolicy(policy);this.policy=structuredClone(policy);this.db=new DatabaseSync(file);this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS metadata(id INTEGER PRIMARY KEY,policy TEXT NOT NULL,lastTime INTEGER NOT NULL,body TEXT);');
  const r=this.db.prepare('SELECT * FROM metadata WHERE id=1').get();if(r)assert.equal(r.policy,hash(policy),'trust policy changed');else this.db.prepare('INSERT INTO metadata VALUES(1,?,0,NULL)').run(hash(policy));
 }
 get current(){const r=this.db.prepare('SELECT body FROM metadata WHERE id=1').get();return r.body?JSON.parse(r.body):null;}
 accept(doc,{now=Math.floor(Date.now()/1000),linked=false,commit=()=>{}}={}){
  this.db.exec('BEGIN IMMEDIATE');try{const r=this.db.prepare('SELECT * FROM metadata WHERE id=1').get(),prev=r.body?JSON.parse(r.body):null;assert(now+30>=r.lastTime,'clock rollback');
   const v=verifyCheckpoint(doc,this.policy,{now,previous:prev,allowGap:linked===true});if(prev&&v.id!==hash(prev.body))assert(linked===true,'verified ancestry required');
   this.db.prepare('UPDATE metadata SET lastTime=?,body=? WHERE id=1').run(Math.max(now,r.lastTime),JSON.stringify(doc));commit(this.db);this.db.exec('COMMIT');return v;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 close(){this.db.close();}
}
