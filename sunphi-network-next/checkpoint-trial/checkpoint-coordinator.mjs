import {readFileSync,writeFileSync,mkdtempSync,unlinkSync,rmdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {prepare,publish} from './checkpoint-operator.mjs';
import {verify} from './crypto.mjs';
import {checkpointPolicy} from './checkpoint.mjs';
async function post(url,body){const u=new URL(url);assert(u.protocol==='http:'&&u.hostname==='127.0.0.1','use authenticated SSH tunnels');const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});const bytes=await r.arrayBuffer();assert(bytes.byteLength<=16384);const j=JSON.parse(Buffer.from(bytes));assert(r.ok,j.error??'endpoint failed');return j;}
export async function cycle(profile,settings){profile=resolve(profile);const candidate=mkdtempSync(join(profile,'candidate-'));assert.equal(dirname(candidate),profile);const files=['headers.json','body.json','snapshot.json','renewals.json','source.json'];try{const body=await prepareExisting(profile,settings.rpc,candidate),renewals=JSON.parse(readFileSync(join(candidate,'renewals.json'))),policy=checkpointPolicy({renewals},JSON.parse(readFileSync(join(profile,'trust-policy.json')))),members=new Set(policy.members.map(m=>m.key));const results=await Promise.allSettled(settings.attesters.map(u=>post(u,{body,renewals})));const signatures=[],seen=new Set();for(const r of results)if(r.status==='fulfilled'&&members.has(r.value.key)&&!seen.has(r.value.key)&&verify(body,r.value.signature,r.value.key)){seen.add(r.value.key);const file=join(candidate,'signature-'+signatures.length+'.json');writeFileSync(file,JSON.stringify(r.value));files.push('signature-'+signatures.length+'.json');signatures.push(file);}const result=await publish(profile,candidate,signatures),doc=JSON.parse(readFileSync(join(profile,'checkpoint.json')));const delivery=await Promise.allSettled(settings.applicationTargets.map(u=>post(u,{method:'installCheckpoint',document:doc})));return {...result,delivered:delivery.filter(x=>x.status==='fulfilled').length,targets:delivery.length};}finally{for(const f of files){try{unlinkSync(join(candidate,f));}catch(e){if(e.code!=='ENOENT')throw e;}}rmdirSync(candidate);}}
// Allocate before requesting any signature. A failed/partially signed round must
// never reuse its sequence. The gap permits ancestry-proved recovery from an
// unpublished attestation without resetting or weakening any signer's pin.
export function allocateRound(file,published=0){
 assert(Number.isSafeInteger(published)&&published>=0);
 const db=new DatabaseSync(file);
 try{db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS rounds(id INTEGER PRIMARY KEY,sequence INTEGER NOT NULL); BEGIN IMMEDIATE;');
  const old=db.prepare('SELECT sequence FROM rounds WHERE id=1').get();
  const next=Math.max(old?.sequence??0,published+1)+2;assert(Number.isSafeInteger(next));
  db.prepare('INSERT INTO rounds VALUES(1,?) ON CONFLICT(id) DO UPDATE SET sequence=excluded.sequence').run(next);db.exec('COMMIT');return next;
 }finally{db.close();}
}
async function prepareExisting(profile,url,candidate){
 let published=0;try{published=JSON.parse(readFileSync(join(profile,'checkpoint.json'))).body.sequence;}catch(e){if(e.code!=='ENOENT')throw e;}
 const sequence=allocateRound(join(profile,'coordinator-rounds.sqlite'),published);
 rmdirSync(candidate);return prepare(profile,url,candidate,{sequence});
}
export function checkpointDelay(settings,now=Date.now()){
 if(!settings.observerStatus)return 60000;
 try{const status=JSON.parse(readFileSync(settings.observerStatus));const age=now-Date.parse(status.checkedAt),seconds=status.summary?.checkpointSeconds;if(status.ok===true&&age>=0&&age<=180000&&[30,60].includes(seconds))return seconds*1000;}catch{}
 return 60000;
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){const [profilePath,settingsFile]=process.argv.slice(2),profile=resolve(profilePath),settings=JSON.parse(readFileSync(settingsFile));for(;;){try{console.log(JSON.stringify(await cycle(profile,settings)));}catch(e){console.error('Checkpoint refresh failed: '+e.message);}await new Promise(r=>setTimeout(r,checkpointDelay(settings)));}}
