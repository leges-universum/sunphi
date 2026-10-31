import {exact,digest} from './protocol.mjs';
import {verifyEpoch,checkSealBody,firstEpoch,verifySeal} from './epoch-seal.mjs';
import {policyFor} from './renewing-history.mjs';
// Read-only retained public signatures. No new signing or administrator trust.
export function collectCheckpoint(replies,context,epoch){
 const groups=new Map();
 for(const reply of replies){try{
  exact(reply,['body','signature']);const {body,signature}=reply,p=policyFor(context,body);
  checkSealBody(body,p);if(body.epoch!==epoch||signature.epoch!==epoch-firstEpoch(p))throw Error('epoch');verifyEpoch(signature,'seal',p,body);
  const id=digest(body);if(!groups.has(id))groups.set(id,{body,signatures:new Map(),policy:p});groups.get(id).signatures.set(signature.slot,signature);
 }catch{}}
 const valid=[];for(const g of groups.values()){if(g.signatures.size<7)continue;const c={body:g.body,signatures:[...g.signatures.values()].sort((a,b)=>a.slot-b.slot)};try{verifySeal(c,g.policy,context.last);valid.push(c);}catch{}}
 if(valid.length>1)throw Error('conflicting checkpoint quorums');return valid[0]??null;
}

// A slow/offline tenth peer must not delay seven independently authenticated
// signatures. Cancel the unused requests so bounded batches cannot accumulate
// background sockets. No status response or count alone constitutes a quorum.
export async function discoverCheckpoint(urls,context,epoch,request){
 const abort=new AbortController(),replies=[];let remaining=urls.length,finished=false;
 return new Promise((resolve,reject)=>{
  const finish=(value,error)=>{if(finished)return;finished=true;abort.abort();error?reject(error):resolve(value);};
  for(const url of urls)Promise.resolve().then(()=>request(url,{method:'publicSeal',epoch},{timeoutMs:2000,signal:abort.signal})).then(reply=>{
   if(finished)return;if(reply)replies.push(reply);
   if(replies.length>=7){const c=collectCheckpoint(replies,context,epoch);if(c)finish(c);}
  }).catch(e=>{if(!finished&&e.message==='conflicting checkpoint quorums')finish(null,e);}).finally(()=>{if(--remaining===0&&!finished){try{finish(collectCheckpoint(replies,context,epoch));}catch(e){finish(null,e);}}});
 });
}
