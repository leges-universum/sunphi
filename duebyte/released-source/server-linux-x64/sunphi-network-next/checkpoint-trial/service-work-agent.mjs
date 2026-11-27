// Shared Linux/Home service responder. Uses the caller's existing durable
// outbox and verified view. Never holds spending keys or invents paid tasks.
import assert from 'node:assert/strict';
import {hash,sign} from './crypto.mjs';
import {envelope} from './core.mjs';
import {COMPLETE_SERVICE} from './research/bounded-service-rewards.mjs';
import {serviceChallenge,serviceResponseBody,verifyServiceResponse} from './research/service-work-measurement.mjs';
export function serviceWorkMessage(status){
 return ({ACCEPTED:'Work accepted. Its share of the daily reward is calculated after the UTC day closes.',SUBMITTED:'Work submitted. Waiting for network confirmation.',RETRYING:'Retrying work verification. The saved response is retained.',WAITING:'Waiting for the next scheduled verification.',WAITING_FOR_SERVICE_SLOT:'Waiting for the next scheduled verification.',MISSED:'This verification window has passed. Waiting for the next assignment.',EXPIRED:'This verification window has passed. Waiting for the next assignment.',AWAITING_ADMISSION:'This node is awaiting admission to paid work.',OUTSIDE_FUNDED_SCHEDULE:'No daily reward period is currently funded. Fee rewards remain separate.'})[status]??null;
}
export async function runServiceWork({config,node,key,readView,readProof,outbox,broadcast,schedule,clock=()=>performance.now()}){
 if(schedule&&!outbox.get()&&schedule.until>clock())return schedule.result??{status:'WAITING_FOR_SERVICE_SLOT'};
 const v=await readView();if(!v?.work)return {status:'NOT_ENABLED'};
 assert.equal(v.node,node);assert.equal(v.publicKey,key.publicKey,'service identity mismatch');const w=v.work;
 const saved=outbox.get();
 if(saved){
  assert.equal(saved.body.action.type,COMPLETE_SERVICE);assert.equal(saved.body.configHash,hash(config));assert.equal(saved.body.author,key.publicKey);assert.equal(saved.body.action.node,node);
  if(w.receipt&&w.receipt.responseHash===hash(saved.body.action.response)||w.status==='OUTSIDE_FUNDED_SCHEDULE'||saved.body.action.intervalStart<w.intervalStart||w.status==='EXPIRED'||w.status==='MISSED')outbox.remove();
 }
 if(w.status!=='ASSIGNED'||!v.admitted){
  // The verified network time schedules a bounded local quiet interval. The
  // monotonic clock tolerates wall-clock corrections; restart simply rechecks.
  // Never delay a durable unacknowledged submission on this cached schedule.
  const result={status:v.admitted?w.status:'AWAITING_ADMISSION',intervalStart:w.intervalStart??null};
  if(schedule&&!outbox.get()){const seconds=w.status==='WAITING'&&Number.isFinite(w.slot)&&Number.isFinite(v.time)?Math.max(1,Math.min(300,w.slot-v.time)):300;schedule.until=clock()+seconds*1000;schedule.result=result;}
  return result;
 }
 let wire=outbox.get();
 if(!wire){
  const proof=await readProof(w.anchor.root,w.key),challenge=serviceChallenge({configHash:hash(config),profile:w.profile,node,kind:v.kind,intervalStart:w.intervalStart,openedAt:w.anchor.openedAt,anchorHeight:w.anchor.height,anchorRoot:w.anchor.root,key:w.key,valueHash:hash(proof.value)});
  const body=serviceResponseBody(challenge,proof),response={body,signature:sign(body,key.privateKey),proof};
  verifyServiceResponse({challenge,profile:w.profile,publicKey:key.publicKey,eligible:true,response,acceptedAt:v.time});
  wire=envelope(config,{type:COMPLETE_SERVICE,node,intervalStart:w.intervalStart,response},key);outbox.put(wire);
 }
 assert.equal(wire.body.action.intervalStart,w.intervalStart,'outbox service interval');await broadcast(wire);
 return {status:'SUBMITTED',intervalStart:w.intervalStart};
}
