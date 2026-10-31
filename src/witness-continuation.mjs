import {isHash} from './epoch-seal.mjs';

// Volatile, signer-local memo of hashes produced by the pinned Go verifier,
// never of RPC assertions. No cache can answer a freshness request: every call
// still verifies a new RPC continuation with the normal six-second deadline
// and Go's unchanged signed-time check. A restart starts cold.
export class WitnessContinuation{
 #rpc;#pins=new Map();#tip=null;
 constructor(rpc){this.#rpc=rpc;}
 async verify(anchor){
  if(!Number.isSafeInteger(anchor?.height)||anchor.height<1||!isHash(anchor.hash))throw Error('continuation anchor');
  const known=this.#pins.get(anchor.height);
  if(known&&known!==anchor.hash)throw Error('continuation history conflict');
  const start=known&&this.#tip&&this.#tip.height>=anchor.height?this.#tip:anchor;
  const result=await this.#rpc.tip(start,this.#tip),v=result.value;
  // RecoveryJournal independently connects the requested old pin to its later
  // cursor; its final result still comes from the normal fresh RPC verifier.
  if(result.recovery===true)return result;
  // Older verifier output remains safe, but cannot enable memoization.
  if(v.verifiedAnchors!==undefined){
   const pins=v.verifiedAnchors;
   if(v.verifiedFrom!==start.height||!Array.isArray(pins)||pins.length<1||pins.length>628||pins[0].height!==start.height||pins[0].hash!==start.hash||pins.at(-1).height!==v.headerHeight||pins.at(-1).hash!==v.headerHash)throw Error('invalid verified anchor coverage');
   let last=0;for(const p of pins){if(!Number.isSafeInteger(p.height)||p.height<=last||p.height>v.headerHeight||!isHash(p.hash)||(this.#pins.has(p.height)&&this.#pins.get(p.height)!==p.hash))throw Error('invalid or conflicting verified anchor');last=p.height;}
   for(const p of pins)this.#pins.set(p.height,p.hash);
   // Bounded memory; evicted old epochs must verify their full suffix again.
   if(this.#pins.size>1024){const heights=[...this.#pins.keys()].sort((a,b)=>a-b);for(const h of heights.slice(0,heights.length-1024))this.#pins.delete(h);}
   this.#tip={height:v.headerHeight,hash:v.headerHash};
  }
  return result;
 }
 get recoveryStatus(){return this.#rpc.recoveryStatus??null;}
 close(){this.#rpc.close?.();}
}
