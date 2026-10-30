import { loopback,runVerifier } from './history-io.mjs';
import { isHash } from './epoch-seal.mjs';

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
 constructor(cfg,{verify=runVerifier}={}){this.urls=rpcEndpoints(cfg);this.bin=cfg.verifier;this.genesis=cfg.genesis;this.chain=cfg.policy.chainId;this.preferred=this.urls[0];this.verify=verify;}
 async tip(anchor=null,minimum=null){
  const args=anchor?['-trusted-height',String(anchor.height),'-trusted-hash',anchor.hash]:[];
  const results=await Promise.allSettled(this.urls.map(async url=>{
   const value=JSON.parse(await this.verify(this.bin,['-verify',url,'-genesis',this.genesis,...args],{timeoutMs:6000}));
   if(value.verified!==true||value.chain!==this.chain||!Number.isSafeInteger(value.headerHeight)||value.headerHeight<1||!isHash(value.headerHash))throw new Error('invalid RPC proof result');
   if(minimum&&(value.headerHeight<minimum.height||(value.headerHeight===minimum.height&&value.headerHash!==minimum.hash)))throw new Error('RPC rollback');
   return {url,value,checkedAt:Date.now()};
  }));
  const valid=results.filter(r=>r.status==='fulfilled').map(r=>r.value);
  if(!valid.length)throw new Error('no verified RPC source');
  const hashes=new Map();for(const r of valid){const old=hashes.get(r.value.headerHeight);if(old&&old!==r.value.headerHash)throw new Error('conflicting verified RPC tips');hashes.set(r.value.headerHeight,r.value.headerHash);}
  valid.sort((a,b)=>b.value.headerHeight-a.value.headerHeight);this.preferred=valid[0].url;
  return {...valid[0],available:valid.length,configured:this.urls.length};
 }
 async read(operation){
  for(const url of [this.preferred,...this.urls.filter(x=>x!==this.preferred)]){try{return await operation(url);}catch{}}
  throw new Error('no verified RPC read');
 }
}
