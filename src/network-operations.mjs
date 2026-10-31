import { DatabaseSync } from 'node:sqlite';
import { readFileSync,mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { digest,canonical } from './protocol.mjs';
import { verifyEpoch,verifySeal,verifyHead,isHash,ZERO } from './epoch-seal.mjs';
import { checkRenewalBody,nextPolicy,verifyRenewal,encodeRenewal } from './root-renewal.mjs';
import { RenewalBook,policyFor } from './renewing-history.mjs';
import { loopback,request,runVerifier,verifyArchive,readVerifiedHistory,verifyHistoryBytes,anchorArgs } from './history-io.mjs';
import { historyIdentity } from './canonical-history.mjs';
import { packageArchive } from './archive-store.mjs';
import { RpcPool,rpcEndpoints } from './rpc-pool.mjs';
import { lockController } from './controller-lock.mjs';
import { boundedSettled } from './bounded-work.mjs';
import {scheduledBody} from './root-schedule.mjs';

export function renewalWindow(context,height,leadBlocks){const boundary=(context.policy.history.generation+1)*context.policy.history.span*8;
 return {boundary,lastInclusionHeight:boundary-1,blocksLeft:boundary-1-height,state:context.pending?'selected':height>=boundary-1?'deadline-missed':height>=boundary-1-leadBlocks?'action-required':'scheduled'};}
export function observeProgress(old,tip,now,stallMs){
 if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(tip.headerHeight)||tip.headerHeight<1||!isHash(tip.headerHash))throw new Error('invalid observation');
 if(old&&(now<old.observedAt||tip.headerHeight<old.height||(tip.headerHeight===old.height&&tip.headerHash!==old.hash)))throw new Error('clock rollback or chain rollback/conflict');
 const advanced=!!old&&tip.headerHeight>old.height;
 return {height:tip.headerHeight,hash:tip.headerHash,observedAt:now,progressAt:!old||advanced?now:old.progressAt,seenProgress:advanced||old?.seenProgress===true,stalled:!!old&&now-(!advanced?old.progressAt:now)>stallMs};
}
export function validReplies(results,verify){const slots=new Set(),out=[];for(const r of results){if(r.status!=='fulfilled')continue;try{const s=r.value;verify(s);const slot=s.signature?.slot??s.slot;if(slots.has(slot))continue;slots.add(slot);out.push(s);}catch{}}return out.sort((a,b)=>(a.signature?.slot??a.slot)-(b.signature?.slot??b.slot));}
export function healthReport(report,now=Date.now()){if(!report||!Number.isSafeInteger(report.checkedAt)||!Number.isSafeInteger(report.validUntil)||report.validUntil<=report.checkedAt||now<report.checkedAt||now>report.validUntil)return {healthy:false,alerts:['monitor-report-stale-or-clock-invalid']};return {healthy:report.healthy===true,alerts:report.alerts};}

// One sequential bounded tick, persisted public state; no secret generation or
// authority to approve root plans. Signing services enforce operator approvals.
export class NetworkOperations{
 #cfg;#db;#book;#options;#busy=false;#version;#rpc;#unlock;#sealDiagnostics=null;#catchupDiagnostics=[];
 static async open(cfg){
  if(cfg.mode!=='isolated'||cfg.policy?.history.version!==3||cfg.witnesses?.length!==10||new Set(cfg.witnesses.map(loopback)).size!==10||cfg.archives?.length!==3||new Set(cfg.archives.map(loopback)).size!==3)throw new Error('isolated operations topology');rpcEndpoints(cfg);
  for(const [v,min,max] of [[cfg.intervalMs,500,60000],[cfg.leadBlocks,1,1024],[cfg.maxLagBlocks,8,1024],[cfg.stallMs,1000,600000]])if(!Number.isInteger(v)||v<min||v>max)throw new Error('operations bounds');
  const o=new NetworkOperations();o.#cfg=structuredClone(cfg);o.#rpc=new RpcPool({...cfg,recoveryDatabase:cfg.database+'.continuation.sqlite'});o.#options={bin:cfg.verifier,genesis:cfg.genesis,temporary:cfg.temporary,transport:{timeoutMs:5000}};
  o.#unlock=lockController([cfg.book,cfg.database]);
  try{o.#book=await RenewalBook.open(cfg.book,cfg.policy,o.#options);o.#db=new DatabaseSync(cfg.database);o.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS operations(k TEXT PRIMARY KEY,v TEXT NOT NULL);');
   const identity=digest({policy:cfg.policy,witnesses:cfg.witnesses,archives:cfg.archives,...(cfg.rpcs?{rpcs:rpcEndpoints(cfg)}:{rpc:cfg.rpc}),genesis:digest(JSON.parse(readFileSync(cfg.genesis)))}),previous=o.#get('identity');if(previous&&previous!==identity)throw new Error('operations identity mismatch');if(!previous)o.#put('identity',identity);o.#version=o.#db.prepare('PRAGMA data_version').get().data_version;return o;
  }catch(e){o.#book?.close();o.#db?.close();o.#unlock();throw e;}
 }
 #get(k){const r=this.#db.prepare('SELECT v FROM operations WHERE k=?').get(k);return r?JSON.parse(r.v):null;}
 #put(k,v){this.#db.prepare('INSERT OR REPLACE INTO operations VALUES(?,?)').run(k,canonical(v));}
 #guard(){if(this.#db.prepare('PRAGMA data_version').get().data_version!==this.#version)throw new Error('concurrent operations writer');}
 get context(){return this.#book.context;}
 get certificates(){return this.#book.certificates;}
 archive(epoch){return this.#book.archive(epoch);}
 get report(){return this.#get('report');}
 async #renew(tip){const ctx=this.context,window=renewalWindow(ctx,tip.headerHeight,this.#cfg.leadBlocks);
  if(ctx.pending)return {...window,submission:'confirmed-in-retained-history'};
  const body=this.#cfg.plans?.find(b=>b.generation===ctx.policy.history.generation)??this.#get(`plan:${ctx.policy.history.generation}`)?.certificate.body??scheduledBody(this.#cfg.rootSchedule,ctx);if(!body)return {...window,submission:'operator-plan-required'};
  checkRenewalBody(body,ctx.policy,ctx.usedRoots);if(window.blocksLeft<=0)return {...window,submission:'too-late'};
  const key=`plan:${body.generation}`;let saved=this.#get(key);
  if(saved&&digest(saved.certificate.body)!==digest(body))throw new Error('persisted plan conflict');
  if(!saved){
   const p=ctx.policy,np=nextPolicy(p,body),ready=validReplies(await Promise.allSettled(this.#cfg.witnesses.map(url=>request(url,{method:'ready',candidate:{body}},{timeoutMs:10000}))),s=>{if(s.epoch!==0)throw new Error('ready leaf');verifyEpoch(s,'root-ready',np,body);});
   if(ready.length<7)return {...window,submission:'new-quorum-unavailable'};
   const approvals=validReplies(await Promise.allSettled(this.#cfg.witnesses.map(url=>request(url,{method:'authorize',candidate:{body,ready}},{timeoutMs:10000}))),s=>{if(s.epoch!==body.authorizationEpoch-body.generation*p.history.span)throw new Error('authorization leaf');verifyEpoch(s,'root-authorize',p,body);});
   if(approvals.length<7)return {...window,submission:'current-quorum-unavailable'};
   const certificate={body,anchor:ctx.last,ready,approvals};verifyRenewal(certificate,p,ctx.usedRoots);saved={certificate,attempts:0,lastHeight:0};this.#put(key,saved);
  }
  // Persist exact payload BEFORE broadcasting. A lost response never counts as
  // final inclusion; retries use identical bytes and may hit mempool duplicate.
  if(saved.lastHeight===tip.headerHeight)return {...window,submission:'awaiting-inclusion'};
  saved.attempts++;saved.lastHeight=tip.headerHeight;this.#put(key,saved);
  try{const r=await fetch(this.#rpc.preferred,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'broadcast_tx_sync',params:{tx:encodeRenewal(saved.certificate).toString('base64')}}),signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('broadcast transport');const j=await r.json();return {...window,submission:j.result?.code===0?'admitted-awaiting-inclusion':'unconfirmed',attempts:saved.attempts};}
  catch{return {...window,submission:'unknown-retry-identical',attempts:saved.attempts};}
 }
 async #seal(tip){const ctx=this.context,e=(ctx.last?.body.epoch??-1)+1,end=(e+1)*8;if(tip.headerHeight<end+1)return false;
  const started=Date.now(),d=this.#sealDiagnostics={epoch:e,stage:'export',elapsedMs:0};
  try{
  const {bytes,v}=await this.#rpc.read(async url=>{const bytes=await runVerifier(this.#cfg.verifier,['-export-history',url,'-genesis',this.#cfg.genesis,'-height',String(end),...anchorArgs(ctx.last)],{timeoutMs:10000}),v=await verifyArchive(bytes,{...this.#options,previous:ctx.last});return {bytes,v};}),identity=historyIdentity(bytes,3);
  const {verified:unused,payload:unusedPayload,...metadata}=v,body={version:3,generation:Math.floor(e/ctx.policy.history.span),...metadata,genesis:this.#cfg.policy.genesis,epoch:e,previous:ctx.last?digest(ctx.last.body):ZERO,archiveRoot:identity.root,archiveBytes:identity.manifest.bytes};
  d.stage='upload';const policy=policyFor(ctx,body),uploads=await Promise.allSettled(this.#cfg.archives.map(url=>request(url,{method:'putHistory',data:bytes.toString('base64')},{timeoutMs:15000})));
  if(uploads.filter(x=>x.status==='fulfilled').length<2)throw new Error('archive upload quorum unavailable');
  // Ten simultaneous catch-up requests multiplied by three RPC verifiers per
  // witness overload the sources and cause every verifier to hit its deadline.
  // Bound fan-out, not trust: every signer still checks two archives and a fresh
  // independently authenticated continuation with its unchanged time limits.
  d.stage='witnesses';const replies=await boundedSettled(this.#cfg.witnesses,2,url=>request(url,{method:'seal',body,previous:ctx.last},{timeoutMs:30000})),signatures=validReplies(replies,s=>{if(s.epoch!==e-policy.history.generation*policy.history.span)throw new Error('seal leaf');verifyEpoch(s,'seal',policy,body);});
  d.validSignatures=signatures.length;d.failures=replies.map((r,slot)=>r.status==='rejected'?{slot,reason:/^signer (policy|archive|continuation|fence) (rejected|timeout)$/.test(r.reason?.message)?r.reason.message:'transport-or-service-rejected'}:null).filter(Boolean);
  const c={body,signatures};verifySeal(c,policy,ctx.last);d.stage='commit';await this.#book.accept(c,bytes);d.stage='complete';return true;
  }finally{d.elapsedMs=Date.now()-started;}
 }
 async #catchupWitnesses(){const count=(this.context.last?.body.epoch??-1)+1;this.#catchupDiagnostics=[];if(!count)return;
  await boundedSettled(this.#cfg.witnesses,3,async url=>{const started=Date.now(),hint=await request(url,{method:'status'},{timeoutMs:5000});
   // Status is an untrusted routing hint, never a trust anchor. Replay only
   // already authenticated retained certificates. Bound by both count and time
   // so a large outage can catch up without starving current seals/health.
   if(!Number.isSafeInteger(hint.epoch)||hint.epoch<0||hint.epoch>=count)return;
   let accepted=0;try{for(let e=hint.epoch;e<Math.min(hint.epoch+8,count);e++){
    if(accepted&&Date.now()-started>=4000)break;
    await request(url,{method:'seal',body:this.#book.certificate(e).body,previous:e?this.#book.certificate(e-1):null},{timeoutMs:30000});accepted++;
   }}finally{this.#catchupDiagnostics.push({slot:this.#cfg.witnesses.indexOf(url),fromEpoch:hint.epoch,accepted,elapsedMs:Date.now()-started});}
   // ACKs are not proof of catch-up: the following nonce/head quorum check is.
  });
 }
 async audit(epoch){this.#guard();const c=this.#book.certificate(epoch);if(!c||c.body.epoch!==epoch)throw new Error('audit must use retained certificate');
  const options={...this.#options,previous:epoch?this.#book.certificate(epoch-1):null},results=await Promise.allSettled(this.#cfg.archives.map(url=>readVerifiedHistory(url,c.body,options))),copies=[];
  for(let i=0;i<results.length;i++)copies.push({index:i,verified:results[i].status==='fulfilled',repaired:false});
  // Local retained full proof is also reverified before repairing a remote copy.
  let bytes;try{bytes=this.archive(epoch);await verifyHistoryBytes(bytes,c.body,options);}catch{bytes=null;}
  if(bytes){const p=packageArchive(bytes);for(const copy of copies.filter(x=>!x.verified)){try{const url=this.#cfg.archives[copy.index];for(let j=0;j<p.chunks.length;j++)await request(url,{method:'repair',hash:p.manifest.chunks[j],data:p.chunks[j].toString('base64')},{timeoutMs:5000});await request(url,{method:'putHistory',data:bytes.toString('base64')},{timeoutMs:15000});await readVerifiedHistory(url,c.body,options);copy.verified=true;copy.repaired=true;}catch{}}}
  const report={epoch,checkedAt:Date.now(),copies,verifiedCopies:copies.filter(x=>x.verified).length};this.#put(`audit:${epoch}`,report);return report;
 }
 async tick(){if(this.#busy)throw new Error('operations tick already running');this.#busy=true;
  const started=Date.now(),alerts=[];this.#sealDiagnostics=null;let tip=null,renewal=null,audit=null,heads=0,progress=null,tipCheckedAt=0,headsCheckedAt=0,rpc=null;
  try{this.#guard();
   try{const last=this.context.last,old=this.#get('progress'),sealed=last?{height:last.body.headerHeight,hash:last.body.headerHash}:null,anchor=old&&(!sealed||old.height>=sealed.height)?old:sealed;rpc=await this.#rpc.tip(anchor,old);tip=rpc.value;tipCheckedAt=rpc.checkedAt;progress=observeProgress(old,tip,tipCheckedAt,this.#cfg.stallMs);this.#put('progress',progress);}
   catch{tip=null;progress=null;alerts.push('chain-freshness-unverified');}
   if(tip&&progress){
    try{renewal=await this.#renew(tip);}catch{alerts.push('renewal-plan-rejected');}
    await this.#catchupWitnesses();
    // A bounded catch-up batch; scheduler yields before any subsequent batch.
    for(let i=0;i<2;i++){try{if(!await this.#seal(tip))break;}catch{alerts.push('checkpoint-progress-blocked');break;}}
    const last=this.context.last;if(!last)alerts.push('no-sealed-checkpoint');
    else{
     const n=last.body.epoch+1,cursor=(this.#get('audit-cursor')??0)%n;audit=await this.audit(cursor);this.#put('audit-cursor',(cursor+1)%n);if(audit.verifiedCopies<2)alerts.push('archive-redundancy-lost');else if(audit.verifiedCopies<3)alerts.push('archive-copy-unavailable');
     // Maintenance may take longer than a freshness window. Re-observe signed
     // live history AFTER it; never extend the TTL of the earlier observation.
     try{const old=this.#get('progress');rpc=await this.#rpc.tip(old,old);tip=rpc.value;tipCheckedAt=rpc.checkedAt;progress=observeProgress(old,tip,tipCheckedAt,this.#cfg.stallMs);this.#put('progress',progress);}catch{tipCheckedAt=0;alerts.push('chain-freshness-unverified');}
     const nonce=randomBytes(32).toString('hex');heads=validReplies(await Promise.allSettled(this.#cfg.witnesses.map(url=>request(url,{method:'head',nonce},{timeoutMs:5000}))),r=>verifyHead(r,this.context.policy,nonce,last)).length;
     headsCheckedAt=Date.now();if(heads<7)alerts.push('witness-fresh-quorum-unavailable');
     if(tip.headerHeight-last.body.headerHeight>this.#cfg.maxLagBlocks)alerts.push('sealed-history-lag');
    }
    renewal={...renewal,...renewalWindow(this.context,tip.headerHeight,this.#cfg.leadBlocks)};if(['action-required','deadline-missed'].includes(renewal.state))alerts.push(`renewal-${renewal.state}`);
    if(progress.stalled)alerts.push('chain-progress-stalled');
   }
   const checkedAt=Date.now(),ttl=Math.max(30000,this.#cfg.intervalMs*3),validUntil=Math.min(tipCheckedAt,headsCheckedAt)+ttl;if(validUntil<=checkedAt)alerts.push('monitor-samples-expired');
   const report={version:1,checkedAt,validUntil,tipCheckedAt,headsCheckedAt,elapsedMs:checkedAt-started,healthy:alerts.length===0,alerts,seal:this.#sealDiagnostics,catchup:this.#catchupDiagnostics,recovery:this.#rpc.recoveryStatus,tip:tip?{height:tip.headerHeight,hash:tip.headerHash}:null,rpc:rpc?{selected:rpc.url,verifiedSources:rpc.available,configuredSources:rpc.configured}:null,checkpointEpoch:this.context.last?.body.epoch??-1,generation:this.context.policy.history.generation,heads,renewal,audit,auditScope:'one retained segment per tick; not a full-history availability guarantee',progress};this.#put('report',report);return report;
  }finally{this.#busy=false;}
 }
 close(){if(this.#busy)throw new Error('cannot close an active controller tick');try{this.#rpc.close();this.#book.close();this.#db.close();}finally{this.#unlock();}}
}
