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

const MAX_TXS=16,MAX_BLOCK_BYTES=1024*1024;
const clone=s=>structuredClone(s);
function preimageFor(parent,height,blockHash,state,txs,governance,witnessRoots){return {parent,height,blockHash,state:digest(stateSummary(state)),txs:txs.map(x=>digest(x)),...(governance?{governance:digest(governance)}:{}),...(witnessRoots?{witnessRoots:digest(witnessRoots)}:{})};}
export class ReplicatedApp {
  #db;#state;#height=0;#root;#pending=null;#cfg;#genesis;#verify;#dataVersion;#preimage;#governance;#witnessRoots;
  static async open({mode,path,keyPath,config,onReplay,signal}){
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
      const g=a.#db.prepare('SELECT value FROM genesis WHERE id=1').get();
      if(g&&g.value!==canonical(config))throw new Error('genesis mismatch');
      if(!g)a.#db.prepare('INSERT INTO genesis VALUES(1,?)').run(canonical(config));
      a.#dataVersion=a.#db.prepare('PRAGMA data_version').get().data_version;
      for(const row of a.#db.prepare('SELECT * FROM blocks ORDER BY height').iterate()){
        signal?.throwIfAborted();
        const p=await a.#stage(row.height,unpackBlock(row.txs),false);
        const preimage=preimageFor(a.#root,row.height,row.block_hash,p.state,p.txs,p.governance,p.witnessRoots),root=digest(preimage);
        if(root!==row.root)throw new Error('replay root mismatch');
        a.#state=p.state;a.#governance=p.governance;a.#witnessRoots=p.witnessRoots;a.#root=root;a.#height=row.height;a.#preimage=preimage;
        await onReplay?.({height:row.height});
      }
      a.#guard();return a;
    }catch(e){a.#db.close();throw e;}
  }
  #guard(){if(this.#db.prepare('PRAGMA data_version').get().data_version!==this.#dataVersion)throw new Error('external database modification; restart and audit required');}
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
    switch(q.method){
      case 'info':return {height:this.#height,hash:Buffer.from(this.#root,'hex').toString('base64')};
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
          this.#db.exec('COMMIT');
        }catch(e){this.#db.exec('ROLLBACK');throw e;}
        this.#state=p.state;this.#governance=p.governance;this.#witnessRoots=p.witnessRoots;this.#height=p.height;this.#root=p.root;this.#preimage=p.preimage;this.#pending=null;return {};
      }
      case 'status':return {height:this.#height,value:{mode:'isolated',chainId:this.#cfg.chainId,height:this.#height,appHash:this.#root,transactions:Object.keys(this.#state.txs).length,supply:this.#state.supply,fees:this.#state.fees,epoch:this.#state.epoch,proofCache:this.#verify.stats()}};
      case 'passport':return {height:this.#height,value:{height:this.#height,appHash:this.#root,preimage:this.#preimage,summary:stateSummary(this.#state),proof:noteProof(this.#state,q.key)}};
      case 'receipt':return {height:this.#height,value:paymentEnvelope(this.#state,this.#height,this.#root,this.#preimage,receiptQuery(q.key))};
      case 'governance':return {height:this.#height,value:{height:this.#height,appHash:this.#root,preimage:this.#preimage,governance:structuredClone(this.#governance)}};
      case 'witnessRoots':return {height:this.#height,value:{height:this.#height,appHash:this.#root,preimage:this.#preimage,witnessRoots:structuredClone(this.#witnessRoots)}};
      default:throw new Error('unsupported method');
    }
  }
  close(){this.#db.close();}
}
