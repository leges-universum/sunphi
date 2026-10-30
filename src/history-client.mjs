import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical,digest } from './protocol.mjs';
import { verifySeal,verifyFreshHeads,verifyHead,checkPolicy } from './epoch-seal.mjs';
import { request,readVerifiedHistory } from './history-io.mjs';

// Public, durable anti-rollback anchor. Loss/rollback of every independent copy
// is not detectable offline; require fresh witness heads after such a loss.
export class CheckpointBook {
 #db;#policy;#last=null;
 constructor(path,policy){checkPolicy(policy);this.#policy=structuredClone(policy);mkdirSync(dirname(path),{recursive:true});this.#db=new DatabaseSync(path);
  this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS policy(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS checkpoints(epoch INTEGER PRIMARY KEY,certificate TEXT NOT NULL);');
  const p=this.#db.prepare('SELECT value FROM policy WHERE id=1').get();if(p&&p.value!==canonical(policy))throw new Error('checkpoint policy mismatch');if(!p)this.#db.prepare('INSERT INTO policy VALUES(1,?)').run(canonical(policy));
  for(const row of this.#db.prepare('SELECT * FROM checkpoints ORDER BY epoch').iterate()){const c=JSON.parse(row.certificate);verifySeal(c,policy,this.#last);if(row.epoch!==c.body.epoch)throw new Error('checkpoint storage mismatch');this.#last=c;}
 }
 get last(){return structuredClone(this.#last);}
 accept(c){verifySeal(c,this.#policy,this.#last);this.#db.prepare('INSERT INTO checkpoints VALUES(?,?)').run(c.body.epoch,canonical(c));this.#last=structuredClone(c);return this.last;}
 close(){this.#db.close();}
}
export async function freshCheckpoint(urls,policy,certificate){
 // Fresh replies about the latest SEALED head, not proof of a fresh chain tip.
 // Caller must first verify the certificate chain and separately enforce tip lag.
 const nonce=randomBytes(32).toString('hex'),results=await Promise.allSettled(urls.map(url=>request(url,{method:'head',nonce})));
 // Validate individual signatures before quorum collection; a single malicious
 // response must not poison an otherwise sufficient set of seven honest peers.
 const receipts=[],seen=new Set();
 for(const r of results.filter(x=>x.status==='fulfilled').map(x=>x.value)){try{
  verifyHead(r,policy,nonce,certificate);if(seen.has(r.signature.slot))continue;
  receipts.push(r);seen.add(r.signature.slot);
 }catch{}}
 verifyFreshHeads(receipts,policy,nonce,certificate);return receipts;
}
export async function recoverArchive(urls,certificate,verification){
 const failures=[];
 for(const url of urls){try{const a=await readVerifiedHistory(url,certificate.body,verification);return {...a,source:url};}catch(e){failures.push(e.message.slice(0,300));}}
 throw new Error(`no independently verified archive available: ${failures.join('; ')}`);
}
export async function replayArchive(app,bytes,certificate){
 // Call only after verifySeal + recoverArchive. Replay still checks every real
 // ZK proof and state transition; compare every already committed prefix on resume.
 const a=JSON.parse(bytes),entries=a.entries;let info=await app.dispatch({method:'info'});
 if(info.height<certificate.body.fromHeight-1||info.height>certificate.body.endHeight)throw new Error('recovery prefix mismatch');
 for(let i=0;i<8;i++){
  const x=entries[i],height=Number(x.header.header.height);
  if(height<=info.height)continue;
  const r=await app.dispatch({method:'finalize',height,hash:Buffer.from(x.header.commit.block_id.hash,'hex').toString('base64'),txs:x.txs??[]});
  if(r.codes.some(x=>x!==0))throw new Error('invalid archived transaction');
  // The following authenticated header commits this block's application result.
  const expected=entries[i+1].header.header.app_hash.toLowerCase();
  if(Buffer.from(r.hash,'base64').toString('hex')!==expected)throw new Error('archived application state mismatch');
  await app.dispatch({method:'commit'});info=await app.dispatch({method:'info'});
 }
 if(info.height!==certificate.body.endHeight||Buffer.from(info.hash,'base64').toString('hex')!==certificate.body.appHash)throw new Error('restored root mismatch');
 return info;
}
