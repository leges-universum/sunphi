import {performance} from 'node:perf_hooks';

// ABCI exposes application H before its hash is committed in header H+1.
// A missing future header is a transport hint to wait, NEVER proof of state.
export async function verifyPendingSnapshot(verify,height,requireFresh,{now=()=>performance.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),waitMs=11000}={}){
 const started=now();
 for(;;){
  requireFresh();
  try{const result=await verify();requireFresh();return result;}
  catch(e){
   const missing=/height (\d+) must be less than or equal to the current blockchain height (\d+)/.exec(e?.message??'');
   if(e?.code!=='VERIFIER_REJECTED'||!missing||Number(missing[1])!==height||Number(missing[2])>=height)throw e;
   if(now()-started>=waitMs){const pending=new Error('wallet snapshot awaiting next signed header');pending.code='SNAPSHOT_PENDING';throw pending;}
   requireFresh();await sleep(Math.min(500,waitMs-(now()-started)));
  }
 }
}
