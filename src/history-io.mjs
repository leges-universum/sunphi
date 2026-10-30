import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync,unlinkSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { assembleArchive,checkManifest } from './archive-store.mjs';
import { historyIdentity,canonicalHistory } from './canonical-history.mjs';
import { canonical } from './protocol.mjs';
export function loopback(url){const u=new URL(url);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('isolated loopback endpoint required');return u.origin;}
export async function request(url,body,{timeoutMs=120000}={}){
 if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>120000)throw new Error('transport timeout bound');
 const endpoint=loopback(url),encoded=JSON.stringify(body);
 // All lab operations bind immutable content/body/nonce and are idempotent.
 // CPU-heavy proof replay can outlive a pooled socket's keep-alive interval.
 // Retry one transport failure with the IDENTICAL request, never a new seal.
 let r;
 for(let attempt=0;attempt<2;attempt++){try{r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','x-sunphi-lab':'history-v1'},body:encoded,signal:AbortSignal.timeout(timeoutMs)});break;}catch(e){if(attempt===1)throw new Error(`history transport: ${e.cause?.code??e.name}`);await new Promise(resolve=>setTimeout(resolve,100));}}
 const n=Number(r.headers.get('content-length'));if(n>24*1024*1024)throw new Error('response bound');
 const reader=r.body.getReader(),parts=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>24*1024*1024){await reader.cancel();throw new Error('response bound');}parts.push(value);}
 const j=JSON.parse(Buffer.concat(parts).toString());if(!r.ok)throw new Error(j.error??'history service unavailable');return j;
}
export async function readArchive(url,root,transport){const m=await request(url,{method:'manifest',root},transport);checkManifest(m,root);const chunks=[];for(const hash of m.chunks){const r=await request(url,{method:'chunk',hash},transport);chunks.push(Buffer.from(r.data,'base64'));}return {manifest:m,chunks,bytes:assembleArchive(m,root,chunks)};}
export function runVerifier(bin,args,{timeoutMs=120000}={}){if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>120000)throw new Error('verifier timeout bound');return new Promise((resolve,reject)=>{
 const p=spawn(bin,args,{stdio:['ignore','pipe','pipe'],windowsHide:true}),parts=[];let length=0,err='',timedOut=false;const timer=setTimeout(()=>{timedOut=true;p.kill('SIGKILL');},timeoutMs);
 p.stdout.on('data',x=>{length+=x.length;if(length>16*1024*1024)p.kill();else parts.push(x);});p.stderr.on('data',x=>{if(err.length<2048)err+=x.toString();});p.once('error',e=>{clearTimeout(timer);reject(e);});p.once('close',code=>{clearTimeout(timer);if(timedOut||code!==0||length>16*1024*1024){const e=new Error(`history verification failed: ${timedOut?'timeout':err}`);e.code=timedOut?'VERIFIER_TIMEOUT':'VERIFIER_REJECTED';reject(e);}else resolve(Buffer.concat(parts));});
});}
export const anchorArgs=previous=>previous?['-trusted-height',String(previous.body.headerHeight),'-trusted-hash',previous.body.headerHash]:[];
export async function verifyArchive(bytes,{bin,genesis,temporary,previous=null}){
 mkdirSync(temporary,{recursive:true});const file=join(temporary,`${randomUUID()}.archive.json`);writeFileSync(file,bytes,{flag:'wx'});
 try{return JSON.parse(await runVerifier(bin,['-verify-history',file,'-genesis',genesis,...anchorArgs(previous)]));}finally{unlinkSync(file);}
}
export async function verifyHistoryBytes(bytes,body,options){
 const v=await verifyArchive(bytes,options),identity=historyIdentity(bytes,body.version);
 if(body.version>=2&&canonical(v.payload)!==canonicalHistory(bytes,body.version).toString())throw new Error('verifier/parser history disagreement');
 if(identity.root!==body.archiveRoot||identity.manifest.bytes!==body.archiveBytes)throw new Error('canonical history identity mismatch');
 for(const k of ['chainId','fromHeight','endHeight','headerHeight','headerHash','appHash'])if(v[k]!==body[k])throw new Error('archive checkpoint mismatch');return v;
}
export async function readVerifiedHistory(url,body,options){
 const roots=body.version>=2?await request(url,{method:'proofs',root:body.archiveRoot},options.transport):[body.archiveRoot];
 if(!Array.isArray(roots)||roots.length<1||roots.length>2)throw new Error('archive evidence unavailable');
 let last;
 for(const root of roots){try{const a=await readArchive(url,root,options.transport),verified=await verifyHistoryBytes(a.bytes,body,options);return {...a,verified,proofRoot:root};}catch(e){last=e;}}
 throw last;
}
