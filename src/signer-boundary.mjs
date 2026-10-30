import { DatabaseSync } from 'node:sqlite';
import { existsSync,mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fork } from 'node:child_process';
import { canonical,digest } from './protocol.mjs';
import { ZERO } from './epoch-seal.mjs';

// Software reference for a monotonic signing-state provider. NOT a hardware
// counter: restoring BOTH databases defeats it. No automatic enrollment/reset.
export const signingStamp=s=>({policy:digest(s.policy),epoch:s.epoch,head:s.last?digest(s.last.body):ZERO,context:digest(s)});
export class EpochFence{
 #db;#version;
 static provision(path,context){if(existsSync(path))throw new Error('fence already provisioned');mkdirSync(dirname(path),{recursive:true});const db=new DatabaseSync(path);try{db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; CREATE TABLE fence(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);');db.prepare('INSERT INTO fence VALUES(1,?)').run(canonical({stamp:signingStamp(context),pending:null}));}finally{db.close();}}
 constructor(path,context){if(!existsSync(path))throw new Error('separately provisioned fence required');this.#db=new DatabaseSync(path);try{this.#db.exec('PRAGMA synchronous=EXTRA');this.#version=this.#db.prepare('PRAGMA data_version').get().data_version;this.check(context);}catch(e){this.#db.close();throw e;}}
 #read(){if(this.#db.prepare('PRAGMA data_version').get().data_version!==this.#version)throw new Error('external fence modification');return JSON.parse(this.#db.prepare('SELECT value FROM fence WHERE id=1').get().value);}
 #write(v){this.#db.prepare('UPDATE fence SET value=? WHERE id=1').run(canonical(v));}
 check(context){const f=this.#read(),s=signingStamp(context);if(f.pending&&canonical(s)===canonical(f.pending.after)){this.#write({stamp:s,pending:null});return;}
  if(canonical(s)!==canonical(f.stamp))throw new Error('signer rollback or fence divergence');}
 reserve(before,after,body){const f=this.#read(),b=signingStamp(before),a=signingStamp(after),pending={after:a,body:digest(body)};
  if(canonical(f.stamp)!==canonical(b)||a.epoch!==b.epoch+1||(f.pending&&canonical(f.pending)!==canonical(pending)))throw new Error('conflicting signing reservation');
  if(!f.pending)this.#write({stamp:b,pending});}
 close(){this.#db.close();}
}
export function fencedSeal(witness,fence,body,previous,proposals,crash=()=>{}){
 fence.check(witness.context());const before=witness.context();
 return witness.seal(body,previous,proposals,point=>{
  if(point==='beforeCommit'){fence.reserve(before,witness.context(),body);crash('reserved');}
  else{crash('signed');fence.check(witness.context());crash('fenced');}
 });
}

// Capability boundary: stateful witness operations only, never generic sign,
// key export, arbitrary purpose or runtime approval/provisioning commands.
export class SignerClient{
 #child;#pending=new Map();#id=0;#closed=false;
 constructor(configPath){this.#child=fork(new URL('../tools/witness-signer.mjs',import.meta.url),[configPath],{stdio:['ignore','ignore','inherit','ipc']});
  this.#child.on('message',m=>{const x=this.#pending.get(m?.id);if(!x)return;clearTimeout(x.timer);this.#pending.delete(m.id);m.ok?x.resolve(m.result):x.reject(new Error(m.error??'signer rejected'));});
  const fail=()=>{this.#closed=true;for(const x of this.#pending.values()){clearTimeout(x.timer);x.reject(new Error('signer process unavailable'));}this.#pending.clear();};this.#child.on('error',fail);this.#child.on('exit',fail);
 }
 async call(request){if(this.#closed||this.#pending.size>=8)throw new Error('signer unavailable or busy');if(!['describe','status','head','ready','authorize','seal'].includes(request?.method)||Buffer.byteLength(JSON.stringify(request))>100000)throw new Error('unsupported signer capability');
  const id=++this.#id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.#pending.delete(id);this.#child.kill('SIGKILL');reject(new Error('signer timed out; restart required'));},180000);this.#pending.set(id,{resolve,reject,timer});this.#child.send({id,request},e=>{if(e){clearTimeout(timer);this.#pending.delete(id);reject(new Error('signer IPC unavailable'));}});});}
 async close(){if(this.#closed)return;this.#closed=true;await new Promise(r=>{this.#child.once('exit',r);this.#child.kill('SIGKILL');});}
}
