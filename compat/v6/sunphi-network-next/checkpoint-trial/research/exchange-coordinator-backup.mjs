// Offline recovery evidence, NOT an activatable coordinator or a signing key.
// Keep the independently recorded checkpoint outside the backup failure domain.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomBytes,scryptSync,createCipheriv,createDecipheriv} from 'node:crypto';
import {exact,hash,hex,digest} from '../crypto.mjs';
import {signingIntent} from './exchange-signing-coordinator.mjs';
const DOMAIN='DUEBYTE_COORDINATOR_BACKUP_V1',CHECKPOINT='DUEBYTE_COORDINATOR_CHECKPOINT_V1';
const MAX=64*1024*1024;
const derive=(password,salt)=>{assert(typeof password==='string'&&password.length>=16&&password.length<=1024);return scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});};
const ordered=(items,field)=>items.sort((a,b)=>a[field]<b[field]?-1:a[field]>b[field]?1:0);
export function validateCoordinatorSnapshot(s,scope){
 exact(s,['domain','scope','records','resources','terminals']);assert.equal(s.domain,'DUEBYTE_COORDINATOR_SNAPSHOT_V1');hex(scope);assert.equal(s.scope,scope);
 assert(Array.isArray(s.records)&&s.records.length<=4096);assert(Array.isArray(s.resources)&&s.resources.length<=4096*64);assert(Array.isArray(s.terminals)&&s.terminals.length<=4096);
 const ids=new Set(),resources=new Map(),terminals=new Map();
 for(const r of s.records){
  assert(['PREPARING','SIGNED'].includes(r.status));exact(r,r.status==='SIGNED'?['id','intent','plan','status','signed']:['id','intent','plan','status']);
  exact(r.intent,['order','purpose','attempt','request']);assert.equal(r.id,signingIntent(scope,r.intent));assert(!ids.has(r.id),'duplicate intent');ids.add(r.id);
  const p=r.plan;assert(p&&Object.getPrototypeOf(p)===Object.prototype&&Array.isArray(p.resources)&&p.resources.length>0&&p.resources.length<=64);assert(JSON.stringify(p).length<=220000);
  for(const resource of p.resources){assert(typeof resource==='string'&&/^[a-zA-Z0-9:/._-]{1,256}$/.test(resource));const key=hash([scope,resource]);assert(!resources.has(key),'reused external resource');resources.set(key,r.id);}
  if(r.intent.purpose!=='FUNDING'){const old=terminals.get(r.intent.order);assert(!old||old===r.intent.purpose,'conflicting terminal action');terminals.set(r.intent.order,r.intent.purpose);}
  if(r.status==='SIGNED'){exact(r.signed,['raw','transaction']);hex(r.signed.transaction);assert(typeof r.signed.raw==='string'&&/^(?:[a-f0-9]{2})+$/.test(r.signed.raw)&&r.signed.raw.length<=200000);}
 }
 assert.deepEqual(s.resources,ordered([...resources].map(([resource,intent])=>({resource,intent})),'resource'),'resource index mismatch');
 assert.deepEqual(s.terminals,ordered([...terminals].map(([order_id,purpose])=>({order_id,purpose})),'order_id'),'terminal index mismatch');
 assert.deepEqual(s.records.map(r=>r.id),[...ids].sort(),'noncanonical intent order');
 return {records:s.records.length,signed:s.records.filter(r=>r.status==='SIGNED').length,uncertain:s.records.filter(r=>r.status==='PREPARING').length,resources:resources.size};
}
export function sealCoordinatorBackup(coordinator,password){
 const snapshot=coordinator.recoverySnapshot();validateCoordinatorSnapshot(snapshot,coordinator.scope);
 const raw=Buffer.from(JSON.stringify(snapshot));assert(raw.length<=MAX,'coordinator backup capacity; never truncate');
 const salt=randomBytes(32),iv=randomBytes(12),key=derive(password,salt);
 try{
  const c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(JSON.stringify([DOMAIN,snapshot.scope])));
  const bytes=Buffer.concat([c.update(raw),c.final()]);
  const bundle={domain:DOMAIN,scope:snapshot.scope,salt:salt.toString('hex'),iv:iv.toString('hex'),tag:c.getAuthTag().toString('hex'),ciphertext:bytes.toString('base64')};
  // This receipt is useful only if retained independently as a trusted anchor.
  const checkpoint={domain:CHECKPOINT,scope:snapshot.scope,snapshotHash:hash(snapshot),bundleHash:hash(bundle)};
  return {bundle,checkpoint};
 }finally{key.fill(0);raw.fill(0);}
}
export function openCoordinatorRecovery(bundle,{password,config,checkpoint}){
 exact(checkpoint,['domain','scope','snapshotHash','bundleHash']);assert.equal(checkpoint.domain,CHECKPOINT);hex(checkpoint.snapshotHash);hex(checkpoint.bundleHash);
 const scope=hash(config);assert.equal(checkpoint.scope,scope);
 exact(bundle,['domain','scope','salt','iv','tag','ciphertext']);assert.equal(bundle.domain,DOMAIN);assert.equal(bundle.scope,scope);
 assert(typeof bundle.ciphertext==='string'&&bundle.ciphertext.length<=Math.ceil(MAX/3)*4);
 assert(/^[a-f0-9]{64}$/.test(bundle.salt)&&/^[a-f0-9]{24}$/.test(bundle.iv)&&/^[a-f0-9]{32}$/.test(bundle.tag));
 assert.equal(hash(bundle),checkpoint.bundleHash,'backup does not match independent checkpoint');
 const bytes=Buffer.from(bundle.ciphertext,'base64');assert.equal(bytes.toString('base64'),bundle.ciphertext);assert(bytes.length<=MAX);
 const key=derive(password,Buffer.from(bundle.salt,'hex'));let raw;
 try{
  const d=createDecipheriv('aes-256-gcm',key,Buffer.from(bundle.iv,'hex'));d.setAAD(Buffer.from(JSON.stringify([DOMAIN,scope])));d.setAuthTag(Buffer.from(bundle.tag,'hex'));
  raw=Buffer.concat([d.update(bytes),d.final()]);const snapshot=JSON.parse(raw);assert.equal(hash(snapshot),checkpoint.snapshotHash,'snapshot checkpoint mismatch');
  const counts=validateCoordinatorSnapshot(snapshot,scope),records=new Map(snapshot.records.map(r=>[r.id,r]));
  // No reserve/commit/activate/export-to-live method. Even a matching old
  // checkpoint cannot prove that no newer intent was signed after its capture.
  return Object.freeze({
   report:Object.freeze({scope,snapshotHash:checkpoint.snapshotHash,...counts,mode:'RECONCILIATION_ONLY',signingEnabled:false,freshnessProven:false,requiresOldAuthorityFencing:true}),
   get(intent){exact(intent,['order','purpose','attempt','request']);const r=records.get(signingIntent(scope,intent));if(!r)return null;assert.deepEqual(r.intent,intent,'changed immutable intent');return structuredClone(r);}
  });
 }finally{key.fill(0);raw?.fill(0);}
}
export function writeCoordinatorBackup(file,bundle){
 const bytes=Buffer.from(JSON.stringify(bundle));assert(bytes.length<=MAX*1.4);
 const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 return {sha256:digest(bytes),bytes:bytes.length};
}
