import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { configCheck, empty, applyEvent } from './ledger.mjs';
import { canonical, digest, parseWire, exact } from './protocol.mjs';
import { loadPinnedKey } from './verifier.mjs';
import { proofVerifier } from './proof-cache.mjs';
import { decodeWire } from './transport.mjs';
import { stateSummary,noteProof } from './state-proof.mjs';
import { packBlock,unpackBlock } from './block-storage.mjs';
import { initialGovernance,activateGovernance,acceptRotation,isRotation,decodeRotation } from './rotation.mjs';
import { checkHistoryConfig } from './epoch-seal.mjs';
import { initialRoots,activateRoots,acceptRoots,isRenewal,decodeRenewal } from './root-renewal.mjs';
import { receiptQuery,paymentEnvelope } from './payment-receipt.mjs';
import {inventoryQuery,inventoryEnvelope} from './inventory-proof.mjs';
import {deltaQuery} from './discovery-delta.mjs';
import {verifyApplicationSnapshot} from './application-snapshot.mjs';
import {CertifiedSnapshot} from './certified-snapshot.mjs';

const MAX_TXS=16,MAX_BLOCK_BYTES=1024*1024;
const clone=s=>structuredClone(s);
function preimageFor(parent,height,blockHash,state,txs,governance,witnessRoots){return {parent,height,blockHash,state:digest(stateSummary(state)),txs:txs.map(x=>digest(x)),...(governance?{governance:digest(governance)}:{}),...(witnessRoots?{witnessRoots:digest(witnessRoots)}:{})};}
export class ReplicatedApp {
  #db;#state;#height=0;#root;#pending=null;#cfg;#genesis;#verify;#dataVersion;#preimage;#governance;#witnessRoots;#snapshots=new Map();
  #certified;#offered=false;#chunks=new Set();#syncPending=false;
  static async open({mode,path,keyPath,config,onReplay,signal,checkpoint,certified,consensusHeight}){
    if(mode!=='isolated')throw new Error('isolated BFT only');
    exact(config,['mode','chainId','epochBlocks','money',...(Object.hasOwn(config,'governance')?['governance']:[]),...(Object.hasOwn(config,'history')?['history']:[])]);configCheck(config.money);
    if(Object.hasOwn(config,'history'))checkHistoryConfig(config.history);
    if(!/^sunphi-lab-[a-z0-9-]{1,48}$/.test(config.chainId)||config.epochBlocks!==1000||config.mode!=='isolated')throw new Error('invalid BFT genesis');
    const a=new ReplicatedApp();a.#cfg=structuredClone(config);a.#genesis=digest(config);
    a.#governance=config.governance?initialGovernance(config.governance):null;
    a.#witnessRoots=initialRoots(config.history);
    a.#root=a.#genesis;a.#state=empty(config.money);a.#verify=proofVerifier(loadPinnedKey(keyPath));
    mkdirSync(dirname(path),{recursive:true});a.#db=new DatabaseSync(path);
    try{
      a.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS genesis(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS blocks(height INTEGER PRIMARY KEY,block_hash TEXT NOT NULL,txs BLOB NOT NULL,root TEXT NOT NULL);');
      a.#db.exec('CREATE TABLE IF NOT EXISTS discovery_frames(height INTEGER PRIMARY KEY,preimage TEXT NOT NULL); CREATE TABLE IF NOT EXISTS wire_locations(txid TEXT PRIMARY KEY,height INTEGER NOT NULL,position INTEGER NOT NULL);');
      const g=a.#db.prepare('SELECT value FROM genesis WHERE id=1').get();
      if(g&&g.value!==canonical(config))throw new Error('genesis mismatch');
      if(!g)a.#db.prepare('INSERT INTO genesis VALUES(1,?)').run(canonical(config));
      a.#dataVersion=a.#db.prepare('PRAGMA data_version').get().data_version;
      const lastHeight=a.#db.prepare('SELECT COALESCE(MAX(height),0) AS height FROM blocks').get().height;
      if(certified){
        if(!(certified instanceof CertifiedSnapshot)||certified.anchor.genesis!==a.#genesis||checkpoint)throw Error('certified bootstrap identity');
        a.#certified=certified;const h=certified.anchor.height;
        if(lastHeight>0&&lastHeight<h)throw Error('partial local history cannot be replaced by snapshot');
        if(lastHeight>=h){
          const expected=certified.blocks;for(const row of a.#db.prepare('SELECT * FROM blocks WHERE height<=? ORDER BY height').iterate(h)){
            const e=expected.shift();if(!e||row.height!==e.height||row.root!==e.root||row.block_hash!==e.blockHash||canonical(unpackBlock(row.txs))!==canonical(e.txs))throw Error('retained certified history mismatch');
          }if(expected.length)throw Error('retained certified history incomplete');
          checkpoint={snapshot:certified.snapshot,anchor:certified.anchor};
        }
        if(consensusHeight!==undefined){if(!Number.isSafeInteger(consensusHeight)||consensusHeight<0||(consensusHeight>0&&consensusHeight<h)||consensusHeight>lastHeight)throw Error('consensus/bootstrap height mismatch');
          if(consensusHeight===0){if(lastHeight>h)throw Error('consensus store missing after application progress');a.#syncPending=true;}
        }else if(lastHeight===0)a.#syncPending=true;
      }
      if(checkpoint){
        const s=verifyApplicationSnapshot(checkpoint.snapshot,config,checkpoint.anchor);
        const row=a.#db.prepare('SELECT root FROM blocks WHERE height=?').get(s.height);if(!row||row.root!==s.appHash||s.height>lastHeight)throw Error('snapshot requires retained local block history');
        a.#state=s.state;a.#governance=s.governance;a.#witnessRoots=s.witnessRoots;a.#root=s.appHash;a.#height=s.height;a.#preimage=s.preimage;
      }
      // Finish each read before asynchronous verification or derived-index
      // writes. A live SQLite cursor pins a snapshot and can mask an external
      // journal change as SQLITE_BUSY_SNAPSHOT on the following write.
      const replay=a.#db.prepare('SELECT * FROM blocks WHERE height>? ORDER BY height LIMIT 1');
      while(a.#height<lastHeight){
        signal?.throwIfAborted();a.#guard();const row=replay.get(a.#height);if(!row)throw Error('retained replay history incomplete');
        const p=await a.#stage(row.height,unpackBlock(row.txs),false);
        a.#guard();
        const preimage=preimageFor(a.#root,row.height,row.block_hash,p.state,p.txs,p.governance,p.witnessRoots),root=digest(preimage);
        if(root!==row.root)throw new Error('replay root mismatch');
        if(row.height>lastHeight-64)a.#db.prepare('INSERT OR REPLACE INTO discovery_frames VALUES(?,?)').run(row.height,canonical(preimage));
        a.#state=p.state;a.#governance=p.governance;a.#witnessRoots=p.witnessRoots;a.#root=root;a.#height=row.height;a.#preimage=preimage;a.#indexWires(p.txs,row.height);
        await onReplay?.({height:row.height});a.#guard();
      }
      a.#db.prepare('DELETE FROM discovery_frames WHERE height<=?').run(lastHeight-64);a.#guard();return a;
    }catch(e){a.#db.close();throw e;}
  }
  #guard(){if(this.#db.prepare('PRAGMA data_version').get().data_version!==this.#dataVersion)throw new Error('external database modification; restart and audit required');}
  #indexWires(txs,height){txs.forEach((text,index)=>{const raw=Buffer.from(text,'base64');if(!isRenewal(raw)&&!isRotation(raw))this.#db.prepare('INSERT OR IGNORE INTO wire_locations VALUES(?,?,?)').run(parseWire(decodeWire(raw)).txid,height,index);});}
  #wire(txid){const p=this.#db.prepare('SELECT height,position FROM wire_locations WHERE txid=?').get(txid);if(!p)throw Error('transaction location unavailable');const row=this.#db.prepare('SELECT txs FROM blocks WHERE height=?').get(p.height),wire=decodeWire(Buffer.from(unpackBlock(row.txs)[p.position],'base64'));if(parseWire(wire).txid!==txid)throw Error('transaction location mismatch');return wire;}
  #inventory(q){
    const root=stateSummary(this.#state).notesRoot;let s;
    if(q.root===null||q.root===root){s={state:this.#state,height:this.#height,root:this.#root,preimage:this.#preimage};if(q.root===null){this.#snapshots.delete(root);this.#snapshots.set(root,s);while(this.#snapshots.size>2)this.#snapshots.delete(this.#snapshots.keys().next().value);}else s=this.#snapshots.get(root)??s;}
    else s=this.#snapshots.get(q.root);
    if(!s)throw Error('inventory snapshot evicted; restart scan');return {height:s.height,value:inventoryEnvelope(s.state,s.height,s.root,s.preimage,q,id=>this.#wire(id))};
  }
  #delta(q){
    if(q.height>this.#height||this.#height-q.height>64||this.#db.prepare('SELECT root FROM blocks WHERE height=?').get(q.height)?.root!==q.appHash)throw Error('delta window or anchor unavailable');
    const frames=this.#db.prepare('SELECT f.preimage,b.txs FROM discovery_frames f JOIN blocks b USING(height) WHERE height>? AND height<=? ORDER BY height').all(q.height,this.#height).map(r=>({preimage:JSON.parse(r.preimage),txs:unpackBlock(r.txs)}));
    const value={version:1,height:this.#height,appHash:this.#root,preimage:this.#preimage,summary:stateSummary(this.#state),from:q,frames};
    if(Buffer.byteLength(canonical(value))>768*1024)throw Error('delta response bound');return {height:this.#height,value};
  }
  #forHeight(height){
    if(!Number.isSafeInteger(height)||height!==this.#height+1)throw new Error('nonsequential height');
    const e=Math.min(99,Math.floor((height-1)/this.#cfg.epochBlocks));
    if(e>this.#state.epoch){const s=clone(this.#state);applyEvent(s,{type:'epoch',epoch:e},this.#cfg.money);return s;}
    return this.#state;
  }
  async #stage(height,txs,filter,maxBytes=MAX_BLOCK_BYTES){
    if(!Array.isArray(txs)||txs.length>MAX_TXS)throw new Error('block transaction limit');
    let state=this.#forHeight(height),governance=activateGovernance(this.#governance,height),witnessRoots=activateRoots(this.#witnessRoots,height,this.#cfg.history?.span),size=0;const accepted=[],updates=[];
    for(const text of txs){
      try{
        if(witnessRoots&&height>(witnessRoots.generation+1)*this.#cfg.history.span*8)throw new Error('witness generation exhausted; transactions disabled');
        if(typeof text!=='string'||text.length>140000)throw new Error('transaction frame');
        const raw=Buffer.from(text,'base64');if(raw.toString('base64')!==text)throw new Error('transaction base64');
        if(size+raw.length>Math.min(maxBytes,MAX_BLOCK_BYTES))throw new Error('block byte limit');
        if(isRenewal(raw)){
          witnessRoots=acceptRoots(witnessRoots,decodeRenewal(raw),{config:this.#cfg,genesis:this.#genesis,height,lookup:h=>this.#db.prepare('SELECT root,block_hash FROM blocks WHERE height=?').get(h)});
        }else if(isRotation(raw)){
          const r=acceptRotation(governance,decodeRotation(raw),{chainId:this.#cfg.chainId,genesis:this.#genesis,height});
          governance=r.governance;updates.push(...r.updates);
        }else{
          const wire=decodeWire(raw);await this.#verify.check(wire);
          const next=clone(state);applyEvent(next,{type:'transaction',wire},this.#cfg.money);
          // Materialized working state retains identities, not duplicated proof blobs.
          next.txs[parseWire(wire).txid]=true;state=next;
        }
        accepted.push(text);size+=raw.length;
      }catch(e){if(!filter)throw e;}
    }this.#guard();return {state,governance,witnessRoots,updates,txs:accepted};
  }
  async dispatch(q){
    this.#guard();
    if(this.#syncPending&&!['info','listSnapshots','offerSnapshot','loadSnapshotChunk','applySnapshotChunk'].includes(q.method))throw Error('certified snapshot synchronization required');
    switch(q.method){
      case 'info':return {height:this.#syncPending?0:this.#height,hash:Buffer.from(this.#syncPending?this.#genesis:this.#root,'hex').toString('base64')};
      case 'listSnapshots':return {snapshots:this.#certified&&!this.#syncPending?[this.#certified.descriptor]:[]};
      case 'loadSnapshotChunk':{const d=this.#certified?.descriptor;if(!d||q.height!==d.height||q.format!==d.format||this.#syncPending)throw Error('snapshot unavailable');return {chunk:this.#certified.chunk(q.index)};}
      case 'offerSnapshot':{
        const d=this.#certified?.descriptor;this.#offered=false;this.#chunks.clear();
        if(!d||!this.#syncPending||canonical(q.snapshot)!==canonical(d)||q.appHash!==this.#certified.anchor.appHash)return {accept:false};
        this.#offered=true;return {accept:true};
      }
      case 'applySnapshotChunk':{
        if(!this.#offered||!this.#syncPending)throw Error('snapshot not offered');
        if(q.chunk!==this.#certified.chunk(q.index)){this.#offered=false;this.#chunks.clear();throw Error('snapshot chunk mismatch');}
        this.#chunks.add(q.index);if(this.#chunks.size===this.#certified.descriptor.chunks){
          const s=this.#certified.snapshot;
          if(this.#height===0){this.#db.exec('BEGIN IMMEDIATE');try{
            for(const b of this.#certified.blocks){this.#db.prepare('INSERT INTO blocks VALUES(?,?,?,?)').run(b.height,b.blockHash,packBlock(b.txs),b.root);this.#indexWires(b.txs,b.height);}
            this.#db.exec('COMMIT');
          }catch(e){this.#db.exec('ROLLBACK');throw e;}}
          if(this.#height!==0&&this.#height!==s.height)throw Error('snapshot cannot overwrite later state');
          this.#state=s.state;this.#governance=s.governance;this.#witnessRoots=s.witnessRoots;this.#root=s.appHash;this.#height=s.height;this.#preimage=s.preimage;this.#syncPending=false;this.#offered=false;this.#chunks.clear();
        }return {accept:true};
      }
      case 'init':{
        if(q.chain!==this.#cfg.chainId||canonical(JSON.parse(Buffer.from(q.state,'base64').toString()))!==canonical(this.#cfg))throw new Error('untrusted chain genesis');
        return {hash:Buffer.from(this.#genesis,'hex').toString('base64')};
      }
      case 'check':try{await this.#stage(this.#height+1,q.txs,false);return {code:0};}catch{return {code:1};}
      case 'prepare':{const p=await this.#stage(q.height,(q.txs??[]).slice(0,MAX_TXS),true,q.maxBytes);return {txs:p.txs};}
      case 'process':try{await this.#stage(q.height,q.txs??[],false);return {accept:true};}catch{return {accept:false};}
      case 'finalize':{
        const bh=Buffer.from(q.hash??'','base64');if(bh.length!==32)throw new Error('block hash required');
        const p=await this.#stage(q.height,q.txs??[],false);
        const preimage=preimageFor(this.#root,q.height,q.hash,p.state,p.txs,p.governance,p.witnessRoots),root=digest(preimage);
        this.#pending={...p,height:q.height,blockHash:q.hash,root,preimage};
        return {hash:Buffer.from(root,'hex').toString('base64'),codes:p.txs.map(()=>0),updates:p.updates};
      }
      case 'commit':{
        if(!this.#pending)throw new Error('no finalized block');const p=this.#pending;
        this.#db.exec('BEGIN IMMEDIATE');
        try{
          this.#guard();
          this.#db.prepare('INSERT INTO blocks VALUES(?,?,?,?)').run(p.height,p.blockHash,packBlock(p.txs),p.root);
          this.#db.prepare('INSERT INTO discovery_frames VALUES(?,?)').run(p.height,canonical(p.preimage));this.#indexWires(p.txs,p.height);
          this.#db.prepare('DELETE FROM discovery_frames WHERE height<=?').run(p.height-64);
          this.#db.exec('COMMIT');
        }catch(e){this.#db.exec('ROLLBACK');throw e;}
        this.#state=p.state;this.#governance=p.governance;this.#witnessRoots=p.witnessRoots;this.#height=p.height;this.#root=p.root;this.#preimage=p.preimage;this.#pending=null;return {};
      }
      case 'status':return {height:this.#height,value:{mode:'isolated',chainId:this.#cfg.chainId,height:this.#height,appHash:this.#root,transactions:Object.keys(this.#state.txs).length,supply:this.#state.supply,fees:this.#state.fees,epoch:this.#state.epoch,proofCache:this.#verify.stats()}};
      case 'applicationSnapshot':return {height:this.#height,value:{version:1,genesis:this.#genesis,height:this.#height,appHash:this.#root,preimage:structuredClone(this.#preimage),state:clone(this.#state),governance:structuredClone(this.#governance),witnessRoots:structuredClone(this.#witnessRoots)}};
      case 'passport':return {height:this.#height,value:{height:this.#height,appHash:this.#root,preimage:this.#preimage,summary:stateSummary(this.#state),proof:noteProof(this.#state,q.key)}};
      case 'receipt':return {height:this.#height,value:paymentEnvelope(this.#state,this.#height,this.#root,this.#preimage,receiptQuery(q.key))};
      case 'inventory':return this.#inventory(inventoryQuery(q.key));
      case 'discoveryDelta':return this.#delta(deltaQuery(q.key));
      case 'governance':return {height:this.#height,value:{height:this.#height,appHash:this.#root,preimage:this.#preimage,governance:structuredClone(this.#governance)}};
      case 'witnessRoots':return {height:this.#height,value:{height:this.#height,appHash:this.#root,preimage:this.#preimage,witnessRoots:structuredClone(this.#witnessRoots)}};
      default:throw new Error('unsupported method');
    }
  }
  close(){this.#db.close();}
}
