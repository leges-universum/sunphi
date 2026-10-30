import { loopback,runVerifier } from './history-io.mjs';
import { isHash } from './epoch-seal.mjs';
import {RecoveryJournal} from './recovery-journal.mjs';
import {join} from 'node:path';

export function rpcEndpoints(cfg){
 const values=cfg.rpcs??[cfg.rpc];
 if(!Array.isArray(values)||values.length<1||values.length>4)throw new Error('RPC pool bound');
 const urls=values.map(loopback);
 if(new Set(urls).size!==urls.length)throw new Error('duplicate RPC endpoint');
 return urls;
}

// Sources are transports, not voters. Every successful response must pass the
// pinned consensus verifier; HTTP success and endpoint count confer no trust.
export class RpcPool{
 #recovery=null;#cfg;#busy=false;#recoveredTip=null;
 constructor(cfg,{verify=runVerifier}={}){this.#cfg=cfg;this.urls=rpcEndpoints(cfg);this.bin=cfg.verifier;this.genesis=cfg.genesis;this.chain=cfg.policy.chainId;this.preferred=this.urls[0];this.verify=verify;}
 get recoveryStatus(){return this.#recovery?.status??null;}
 async tip(anchor=null,minimum=null){
  if(this.#busy)throw Error('RPC verification already running');this.#busy=true;
  try{
   // Historical cursor is never returned as a verified live tip. Even a fully
   // cached continuation MUST finish with the existing fresh verifier below.
   if(this.#recovery&&this.#recovery.contains(anchor)){
    try{return this.#recovered(await this.#tip(this.#recoveredTip??this.#recovery.anchor,minimum));}catch(e){if(e.code==='RPC_CONFLICT')throw e;}
   }else{try{return await this.#tip(anchor,minimum);}catch(e){if(!this.#cfg.recoveryDatabase||e.code==='RPC_CONFLICT')throw e;}}
   if(!this.#cfg.recoveryDatabase)throw Error('no verified RPC source');
   if(!this.#recovery)this.#recovery=await RecoveryJournal.open({path:this.#cfg.recoveryDatabase,bin:this.bin,genesis:this.genesis,temporary:join(this.#cfg.temporary,'continuation')});
   try{await this.#recovery.advance([this.preferred,...this.urls.filter(u=>u!==this.preferred)]);}catch{}
   if(this.#recovery.contains(anchor)&&this.#recovery.anchor){try{return this.#recovered(await this.#tip(this.#recoveredTip??this.#recovery.anchor,minimum));}catch(e){if(e.code==='RPC_CONFLICT')throw e;}}
   const e=new Error('history recovery incomplete; fresh verification required');e.code='HISTORY_RECOVERING';throw e;
  }finally{this.#busy=false;}
 }
 #recovered(result){this.#recoveredTip={height:result.value.headerHeight,hash:result.value.headerHash};return {...result,recovery:true};}
 async #tip(anchor=null,minimum=null){
  const args=anchor?['-trusted-height',String(anchor.height),'-trusted-hash',anchor.hash]:[];
  const results=await Promise.allSettled(this.urls.map(async url=>{
   const value=JSON.parse(await this.verify(this.bin,['-verify',url,'-genesis',this.genesis,...args],{timeoutMs:6000}));
   if(value.verified!==true||value.chain!==this.chain||!Number.isSafeInteger(value.headerHeight)||value.headerHeight<1||!isHash(value.headerHash))throw new Error('invalid RPC proof result');
   if(minimum&&(value.headerHeight<minimum.height||(value.headerHeight===minimum.height&&value.headerHash!==minimum.hash)))throw new Error('RPC rollback');
   return {url,value,checkedAt:Date.now()};
  }));
  const valid=results.filter(r=>r.status==='fulfilled').map(r=>r.value);
  if(!valid.length){const e=new Error('no verified RPC source');e.code=results.every(r=>r.reason?.code==='VERIFIER_TIMEOUT')?'VERIFIER_TIMEOUT':'RPC_UNVERIFIED';throw e;}
  const hashes=new Map();for(const r of valid){const old=hashes.get(r.value.headerHeight);if(old&&old!==r.value.headerHash){const e=new Error('conflicting verified RPC tips');e.code='RPC_CONFLICT';throw e;}hashes.set(r.value.headerHeight,r.value.headerHash);}
  valid.sort((a,b)=>b.value.headerHeight-a.value.headerHeight);this.preferred=valid[0].url;
  return {...valid[0],available:valid.length,configured:this.urls.length};
 }
 async read(operation){
  for(const url of [this.preferred,...this.urls.filter(x=>x!==this.preferred)]){try{return await operation(url);}catch{}}
  throw new Error('no verified RPC read');
 }
 close(){if(this.#busy)throw Error('RPC verification running');this.#recovery?.close();this.#recovery=null;this.#recoveredTip=null;}
}
