import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {origin,stateHash,block} from './core.mjs';
import {hash} from './crypto.mjs';
export class Store{
 constructor(file,config){this.config=config;this.db=new DatabaseSync(file);this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS blocks(height INTEGER PRIMARY KEY,body TEXT NOT NULL,root TEXT NOT NULL);');
  let row=this.db.prepare('SELECT * FROM blocks ORDER BY height DESC LIMIT 1').get();if(!row){const s=origin(config);this.db.prepare('INSERT INTO blocks VALUES(?,?,?)').run(0,JSON.stringify(s),stateHash(s,config));row=this.db.prepare('SELECT * FROM blocks WHERE height=0').get();}
  this.state=JSON.parse(row.body);assert.equal(row.root,stateHash(this.state,config),'stored state integrity');this.pending=null;
 }
 snapshot(h=this.state.height){const r=this.db.prepare('SELECT * FROM blocks WHERE height=?').get(h);assert(r,'snapshot unavailable');const s=JSON.parse(r.body);assert.equal(stateHash(s,this.config),r.root);return s;}
 finalize(request){if(request.height===this.state.height){assert.equal(request.blockHash,this.state.blockHash);return {state:this.state,codes:request.txs.map(()=>0)};}
  const out=block(this.state,this.config,request);if(this.pending)assert.equal(hash(this.pending),hash(out.state),'pending conflict');this.pending=out.state;return out;
 }
 commit(crashAt=''){if(!this.pending)return;const s=this.pending,db=this.db;const crash=at=>{if(crashAt===at)process.exit(79);};crash('before');db.exec('BEGIN IMMEDIATE');try{
   assert.equal(db.prepare('SELECT MAX(height) h FROM blocks').get().h,this.state.height,'stale writer');crash('begin');db.prepare('INSERT INTO blocks VALUES(?,?,?)').run(s.height,JSON.stringify(s),stateHash(s,this.config));crash('insert');db.exec('COMMIT');crash('commit');this.state=s;this.pending=null;crash('reply');
  }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}}
 restore(s){assert.equal(this.state.height,0,'restore only empty store');stateHash(s,this.config);assert(s.height>0);this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO blocks VALUES(?,?,?)').run(s.height,JSON.stringify(s),stateHash(s,this.config));this.db.exec('COMMIT');this.state=structuredClone(s);}catch(e){this.db.exec('ROLLBACK');throw e;}}
 close(){this.db.close();}
}
