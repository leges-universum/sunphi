import { canonical, digest, parseWire } from './protocol.mjs';
import { verifyWire } from './verifier.mjs';

// A process-local bounded cache of EXACT proof packages, never just a txid.
// No cached database attestations are trusted on restart. State is rechecked
// for every proposal/commit, even if its cryptographic proof is already known.
export function proofVerifier(key, capacity=256) {
  if(!Number.isInteger(capacity)||capacity<1||capacity>4096)throw new Error('cache capacity');
  const valid=new Map();let queue=Promise.resolve();
  const stats={verified:0,hits:0,rejected:0};
  async function check(wire) {
    const copy=JSON.parse(canonical(wire));parseWire(copy);
    const id=digest(copy);
    const job=queue.then(async()=>{
      if(valid.has(id)){valid.delete(id);valid.set(id,true);stats.hits++;return parseWire(copy);}
      try {const result=await verifyWire(copy,key);stats.verified++;valid.set(id,true);
        if(valid.size>capacity)valid.delete(valid.keys().next().value);return result;
      } catch(e){stats.rejected++;throw e;}
    });queue=job.catch(()=>{});return job;
  }
  return {check,stats:()=>({...stats,entries:valid.size})};
}
