import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,unlinkSync,mkdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {digest,canonical} from './protocol.mjs';
import {isHash,ZERO} from './epoch-seal.mjs';
import {runVerifier,loopback} from './history-io.mjs';
import {lockController} from './controller-lock.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const EMPTY={height:0,hash:ZERO,pages:0,bytes:0,proofHash:ZERO};

// Public proof journal, not a freshness certificate or a signer-state backup.
// Restart reauthenticates saved pages offline, with bounded memory, before any
// cursor is used. Old proof bytes are not fetched again from the network.
export class RecoveryJournal{
 #db;#cfg;#head={...EMPTY};#version;#unlock;#busy=false;
 static async open(cfg){
  const g=JSON.parse(readFileSync(cfg.genesis));if(g.app_state?.mode!=='isolated'||!g.chain_id?.startsWith('sunphi-lab-'))throw Error('isolated recovery genesis');
  const j=new RecoveryJournal();j.#cfg={...cfg,chain:g.chain_id};j.#unlock=lockController([cfg.path]);
  try{
   mkdirSync(dirname(cfg.path),{recursive:true});mkdirSync(cfg.temporary,{recursive:true});j.#db=new DatabaseSync(cfg.path);
   j.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-4096; PRAGMA temp_store=FILE; CREATE TABLE IF NOT EXISTS recovery_meta(k TEXT PRIMARY KEY,v TEXT NOT NULL); CREATE TABLE IF NOT EXISTS recovery_pages(n INTEGER PRIMARY KEY,proof BLOB NOT NULL); CREATE TEMP TABLE verified_pins(height INTEGER PRIMARY KEY,hash TEXT NOT NULL);');
   const identity=digest({version:1,genesis:g}),row=j.#db.prepare("SELECT v FROM recovery_meta WHERE k='identity'").get();
   if(row&&row.v!==identity)throw Error('recovery genesis identity mismatch');
   if(!row){if(j.#db.prepare('SELECT COUNT(*) AS n FROM recovery_pages').get().n)throw Error('recovery identity missing');j.#db.exec('BEGIN IMMEDIATE');try{j.#db.prepare('INSERT INTO recovery_meta VALUES(?,?)').run('identity',identity);j.#db.prepare('INSERT INTO recovery_meta VALUES(?,?)').run('head',canonical(EMPTY));j.#db.exec('COMMIT');}catch(e){j.#db.exec('ROLLBACK');throw e;}}
   j.#version=j.#db.prepare('PRAGMA data_version').get().data_version;
   for(const row of j.#db.prepare('SELECT * FROM recovery_pages ORDER BY n').iterate()){
    cfg.signal?.throwIfAborted();if(row.n!==j.#head.pages+1)throw Error('recovery page gap');const bytes=Buffer.from(row.proof),v=await j.#verify(bytes);if(v.headerHeight<=j.#head.height)throw Error('recovery page does not advance');j.#head=j.#next(bytes,v);j.#pins(v);await cfg.onReplay?.(j.status);
   }
   const head=j.#db.prepare("SELECT v FROM recovery_meta WHERE k='head'").get();if(!head||head.v!==canonical(j.#head))throw Error('recovery journal incomplete or changed');j.#guard();return j;
  }catch(e){j.#db?.close();j.#unlock();throw e;}
 }
 #guard(){if(this.#db.prepare('PRAGMA data_version').get().data_version!==this.#version)throw Error('recovery journal externally modified');}
 #args(){return this.#head.height?['-trusted-height',String(this.#head.height),'-trusted-hash',this.#head.hash]:[];}
 async #verify(bytes){
  if(bytes.length<1||bytes.length>2*1024*1024)throw Error('recovery proof size');
  const file=join(this.#cfg.temporary,randomUUID()+'.recovery.json');writeFileSync(file,bytes,{flag:'wx'});
  try{
   const v=JSON.parse(await runVerifier(this.#cfg.bin,['-verify-recovery-page',file,'-genesis',this.#cfg.genesis,...this.#args()],{timeoutMs:6000}));
   if(v.verified!==false||v.historyVerified!==true||v.fresh!==false||v.chain!==this.#cfg.chain||v.verifiedFrom!==(this.#head.height||1)||!Array.isArray(v.anchors)||v.anchors.length<1||v.anchors.length>128||!Number.isSafeInteger(v.headerHeight)||v.headerHeight<1||v.headerHeight-v.verifiedFrom!==v.anchors.length-1||!isHash(v.headerHash))throw Error('recovery verifier output');
   for(let i=0;i<v.anchors.length;i++){const p=v.anchors[i];if(p.height!==v.verifiedFrom+i||!isHash(p.hash))throw Error('recovery pin sequence');}
   if((this.#head.height&&v.anchors[0].hash!==this.#head.hash)||v.anchors.at(-1).hash!==v.headerHash)throw Error('recovery anchor mismatch');return v;
  }finally{unlinkSync(file);}
 }
 #next(bytes,v){const next={height:v.headerHeight,hash:v.headerHash,pages:this.#head.pages+1,bytes:this.#head.bytes+bytes.length,proofHash:digest({previous:this.#head.proofHash,bytes:sha(bytes)})};if(next.pages>8192||next.bytes>512*1024*1024)throw Error('recovery journal capacity');return next;}
 #pins(v){const put=this.#db.prepare('INSERT OR REPLACE INTO verified_pins VALUES(?,?)');for(const p of v.anchors){const old=this.#db.prepare('SELECT hash FROM verified_pins WHERE height=?').get(p.height);if(old&&old.hash!==p.hash)throw Error('recovery pin conflict');put.run(p.height,p.hash);}}
 get status(){this.#guard();return {...this.#head,fresh:false};}
 get anchor(){this.#guard();return this.#head.height?{height:this.#head.height,hash:this.#head.hash}:null;}
 contains(anchor){this.#guard();if(!anchor)return true;return this.#db.prepare('SELECT hash FROM verified_pins WHERE height=?').get(anchor.height)?.hash===anchor.hash;}
 async advance(urls,{pages=2,onCommit=()=>{}}={}){
  if(this.#busy)throw Error('recovery already running');if(!Number.isInteger(pages)||pages<1||pages>2||!Array.isArray(urls)||urls.length<1||urls.length>4)throw Error('recovery work bound');urls=urls.map(loopback);this.#busy=true;
  try{for(let i=0;i<pages;i++){
   this.#guard();let bytes,v;
   for(const url of urls){try{const b=await runVerifier(this.#cfg.bin,['-export-recovery-page',url,'-genesis',this.#cfg.genesis,...this.#args()],{timeoutMs:6000});const checked=await this.#verify(b);bytes=b;v=checked;break;}catch{}}
   if(!v)throw Error('no verified recovery page');if(v.headerHeight===this.#head.height)break;
   const next=this.#next(bytes,v);this.#guard();this.#db.exec('BEGIN IMMEDIATE');
   try{this.#db.prepare('INSERT INTO recovery_pages VALUES(?,?)').run(next.pages,bytes);this.#db.prepare("UPDATE recovery_meta SET v=? WHERE k='head'").run(canonical(next));this.#pins(v);onCommit('beforeCommit');this.#db.exec('COMMIT');}catch(e){this.#db.exec('ROLLBACK');throw e;}
   this.#head=next;onCommit('afterCommit');
  }return this.status;}finally{this.#busy=false;}
 }
 close(){if(this.#busy)throw Error('recovery running');try{this.#db.close();}finally{this.#unlock();}}
}
