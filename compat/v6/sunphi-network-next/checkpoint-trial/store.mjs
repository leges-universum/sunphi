import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {sqlitePath} from './sqlite-path.mjs';
import {origin,stateHash,block} from './core.mjs';
import {hash} from './crypto.mjs';
import {encodeHistory,readHistory} from './history-codec.mjs';
export class Store{
 #snapshots=new Map();
 remember(s,root){this.#snapshots.delete(s.height);this.#snapshots.set(s.height,{root,state:structuredClone(s)});while(this.#snapshots.size>8)this.#snapshots.delete(this.#snapshots.keys().next().value);}
 constructor(file,config){this.config=config;this.db=new DatabaseSync(sqlitePath(file));this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS blocks(height INTEGER PRIMARY KEY,body TEXT NOT NULL,root TEXT NOT NULL);');
  try{const version=this.db.prepare('PRAGMA user_version').get().user_version;assert(version===0||version===1,'unsupported history storage version');
   let row=this.db.prepare('SELECT height,root FROM blocks ORDER BY height DESC LIMIT 1').get();
   if(!row){const s=origin(config);this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO blocks VALUES(?,?,?)').run(0,encodeHistory(s),stateHash(s,config));this.db.exec('PRAGMA user_version=1; COMMIT;');}catch(e){this.db.exec('ROLLBACK');throw e;}row={height:0,root:stateHash(s,config)};}
   this.compact=this.db.prepare('PRAGMA user_version').get().user_version===1;
   this.state=readHistory(this.db,row.height);assert.equal(row.root,stateHash(this.state,config),'stored state integrity');this.root=row.root;this.pending=null;this.remember(this.state,this.root);
  }catch(e){this.db.close();throw e;}
 }
 snapshot(h=this.state.height){const row=this.db.prepare('SELECT root FROM blocks WHERE height=?').get(h);assert(row,'snapshot unavailable');const cached=this.#snapshots.get(h);if(cached?.root===row.root)return structuredClone(cached.state);const s=readHistory(this.db,h);stateHash(s,this.config);this.remember(s,row.root);return s;}
 finalize(request){if(request.height===this.state.height){assert.equal(request.blockHash,this.state.blockHash);return {state:this.state,codes:request.txs.map(()=>0)};}
  const out=block(this.state,this.config,request);if(this.pending)assert.equal(hash(this.pending),hash(out.state),'pending conflict');this.pending=out.state;return out;
 }
 commit(crashAt=''){if(!this.pending)return;const s=this.pending,db=this.db;const crash=at=>{if(crashAt===at)process.exit(79);};crash('before');db.exec('BEGIN IMMEDIATE');try{
   const head=db.prepare('SELECT height,root FROM blocks ORDER BY height DESC LIMIT 1').get();assert(head.height===this.state.height&&head.root===this.root,'stale writer');crash('begin');const root=stateHash(s,this.config);db.prepare('INSERT INTO blocks VALUES(?,?,?)').run(s.height,this.compact?encodeHistory(s,this.state,this.root):JSON.stringify(s),root);crash('insert');db.exec('COMMIT');crash('commit');this.state=s;this.root=root;this.pending=null;this.remember(s,root);crash('reply');
  }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}}
 restore(s){assert.equal(this.state.height,0,'restore only empty store');const root=stateHash(s,this.config);assert(s.height>0);this.db.exec('BEGIN IMMEDIATE');try{const head=this.db.prepare('SELECT height,root FROM blocks ORDER BY height DESC LIMIT 1').get();assert(head.height===0&&head.root===this.root,'stale writer');this.db.prepare('INSERT INTO blocks VALUES(?,?,?)').run(s.height,this.compact?encodeHistory(s):JSON.stringify(s),root);this.db.exec('COMMIT');this.state=structuredClone(s);this.root=root;this.remember(s,root);}catch(e){this.db.exec('ROLLBACK');throw e;}}
 close(){this.db.close();}
}
