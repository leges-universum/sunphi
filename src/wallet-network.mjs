import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { canonical,digest,fieldString,parseWire } from './protocol.mjs';
import { isHash,verifyHead } from './epoch-seal.mjs';
import { RenewalBook } from './renewing-history.mjs';
import { RpcPool,rpcEndpoints } from './rpc-pool.mjs';
import { loopback,request,runVerifier,readVerifiedHistory } from './history-io.mjs';
import { lockController } from './controller-lock.mjs';
import { observeProgress,validReplies } from './network-operations.mjs';
import { verifyPassportEnvelope } from './state-proof.mjs';
import { loadPinnedKey } from './verifier.mjs';
import { proofVerifier } from './proof-cache.mjs';
import { encodeWire } from './transport.mjs';
import { verifyPaymentEnvelope } from './payment-receipt.mjs';
import { verifyReceipt } from './receipt-verification.mjs';
import { commitReceipt } from './receipt-store.mjs';
import { initializeReservations,reserveSubmission } from './wallet-outbox.mjs';
import {inventoryQuery,verifyInventoryEnvelope} from './inventory-proof.mjs';
import {collectCheckpoint} from './checkpoint-discovery.mjs';
import {deltaQuery,verifyDiscoveryDelta} from './discovery-delta.mjs';

// HTTP is only a bounded transport. Neither an RPC response nor a monitor's
// "healthy" flag authorizes a balance or a payment.
export async function walletRpc(url,method,params,maxBytes=256*1024){
 if(![256*1024,2*1024*1024].includes(maxBytes))throw Error('RPC response bound');
 const r=await fetch(loopback(url),{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(4000)});
 if(!r.ok)throw new Error('wallet RPC transport');
 const reader=r.body.getReader(),parts=[];let length=0;
 while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>maxBytes){await reader.cancel();throw new Error('wallet RPC response bound');}parts.push(value);}
 const j=JSON.parse(Buffer.concat(parts).toString());if(j.error||!j.result)throw new Error('wallet RPC result');return j.result;
}

export function walletFreshness({progress,sessionHeight,tip,certificate,heads,now,started,maxLagBlocks,ttlMs}){
 if(!certificate||heads<7)throw new Error('wallet requires seven fresh witness heads');
 if(!progress||progress.stalled||tip.headerHeight<=sessionHeight)throw new Error('wallet waiting for fresh chain progress');
 if(now<started||now-started>=ttlMs)throw new Error('wallet freshness samples expired');
 if(tip.headerHeight<certificate.body.headerHeight||tip.headerHeight-certificate.body.headerHeight>maxLagBlocks)throw new Error('wallet sealed history is stale');
 return true;
}

// A later seal must contain the header already seen by THIS wallet when that
// header falls inside its segment. Do not replace a higher RPC pin merely
// because a coordinator supplies a still higher certificate.
export function walletHistoryContinuation(c,bytes,pin){
 if(!pin||pin.height<c.body.fromHeight||pin.height>c.body.headerHeight)return;
 const entry=JSON.parse(bytes).entries.find(e=>Number(e.header?.header?.height)===pin.height);
 if(entry?.header?.commit?.block_id?.hash?.toLowerCase()!==pin.hash)throw new Error('wallet retained header conflicts with new history');
}

// Separate public trust journal; never contains private keys, amounts, passwords
// or decrypted notes. Restoring an encrypted key backup does not restore trust.
export class WalletNetwork{
 #cfg;#book;#db;#rpc;#options;#unlock;#version;#busy=false;#closed=false;
 #sessionHeight=null;#lease=null;#proofs;#inventory=null;
 static async open(cfg){
  if(cfg.mode!=='isolated'||cfg.policy?.history.version!==3||cfg.witnesses?.length!==10||new Set(cfg.witnesses.map(loopback)).size!==10||cfg.archives?.length!==3||new Set(cfg.archives.map(loopback)).size!==3)throw new Error('isolated wallet topology');
  rpcEndpoints(cfg);for(const [n,min,max] of [[cfg.ttlMs,1000,15000],[cfg.stallMs,1000,60000],[cfg.maxLagBlocks,8,64]])if(!Number.isInteger(n)||n<min||n>max)throw new Error('wallet freshness bounds');
  const w=new WalletNetwork();w.#cfg=structuredClone(cfg);w.#rpc=new RpcPool({...cfg,recoveryDatabase:cfg.database+'.continuation.sqlite'});w.#options={bin:cfg.verifier,genesis:cfg.genesis,temporary:cfg.temporary,transport:{timeoutMs:4000}};
  w.#unlock=lockController([cfg.book,cfg.database]);
  try{
   w.#book=await RenewalBook.open(cfg.book,cfg.policy,w.#options);w.#proofs=proofVerifier(loadPinnedKey(cfg.keyPath),16);
   w.#db=new DatabaseSync(cfg.database);w.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS wallet_trust(k TEXT PRIMARY KEY,v TEXT NOT NULL); CREATE TABLE IF NOT EXISTS wallet_submissions(txid TEXT PRIMARY KEY,wire TEXT NOT NULL,attempts INTEGER NOT NULL,status TEXT NOT NULL); CREATE TABLE IF NOT EXISTS wallet_receipts(txid TEXT PRIMARY KEY,proof TEXT NOT NULL);');
   const identity=digest({policy:cfg.policy,genesis:digest(JSON.parse(readFileSync(cfg.genesis))),rpcs:rpcEndpoints(cfg),witnesses:cfg.witnesses,archives:cfg.archives,ttlMs:cfg.ttlMs,stallMs:cfg.stallMs,maxLagBlocks:cfg.maxLagBlocks});
   const old=w.#get('identity');if(old&&old!==identity)throw new Error('wallet trust identity mismatch');if(!old)w.#put('identity',identity);
   initializeReservations(w.#db);
   w.#version=w.#db.prepare('PRAGMA data_version').get().data_version;return w;
  }catch(e){w.#book?.close();w.#db?.close();w.#unlock();throw e;}
 }
 #get(k){const row=this.#db.prepare('SELECT v FROM wallet_trust WHERE k=?').get(k);return row?JSON.parse(row.v):null;}
 #put(k,v){this.#db.prepare('INSERT OR REPLACE INTO wallet_trust VALUES(?,?)').run(k,canonical(v));}
 #guard(){if(this.#closed||this.#db.prepare('PRAGMA data_version').get().data_version!==this.#version)throw new Error('wallet trust journal unavailable or modified');const old=this.#get('progress');if(old&&Date.now()<old.observedAt)throw new Error('wallet clock rollback');}
 async #exclusive(fn){if(this.#busy)throw new Error('wallet operation already running');this.#busy=true;this.#lease=null;try{this.#guard();const result=await fn();this.#guard();this.#book.context;return result;}catch(e){this.#lease=null;throw e;}finally{this.#busy=false;}}
 get checkpoint(){this.#guard();return this.#book.context.last;}
 get identity(){this.#guard();return digest({chainId:this.#cfg.policy.chainId,genesis:this.#cfg.policy.genesis});}
 get status(){
  try{this.#guard();const l=this.#lease,now=Date.now();return {mode:'isolated',ready:!!l&&now>=l.checkedAt&&now<l.validUntil&&performance.now()<l.deadline,checkpointEpoch:this.#book.context.last?.body.epoch??-1,verifiedHeight:this.#get('progress')?.height??0,recovery:this.#rpc.recoveryStatus,...(l?{checkedAt:l.checkedAt,validUntil:l.validUntil,rpc:l.rpc,heads:l.heads}:{} )};}
  catch{return {mode:'isolated',ready:false};}
 }
 // Coordinator certificates are UNTRUSTED hints. Call repeatedly for catch-up;
 // at most two new epochs per call, actual archive signatures/inclusion replayed.
 async sync(certificates){return this.#exclusive(()=>this.#sync(certificates));}
 async #sync(certificates){
  if(!Array.isArray(certificates)||certificates.length>2)throw new Error('wallet checkpoint batch bound');
  for(const c of certificates){let accepted=false;
   for(const url of this.#cfg.archives){try{const a=await readVerifiedHistory(url,c.body,{...this.#options,previous:this.#book.context.last});this.#guard();walletHistoryContinuation(c,a.bytes,this.#get('progress'));await this.#book.accept(c,a.bytes);accepted=true;break;}catch{}}
   if(!accepted)throw new Error('wallet checkpoint or archive unverified');
  }return this.checkpoint;
 }
 async discoverCheckpoints({epochs=2}={}){return this.#exclusive(()=>this.#discoverCheckpoints(epochs));}
 async #discoverCheckpoints(epochs){
  if(!Number.isInteger(epochs)||epochs<1||epochs>2)throw Error('checkpoint discovery bound');let accepted=0;
  for(let i=0;i<epochs;i++){const epoch=(this.checkpoint?.body.epoch??-1)+1,replies=await Promise.allSettled(this.#cfg.witnesses.map(url=>request(url,{method:'publicSeal',epoch},{timeoutMs:2000})));
   const c=collectCheckpoint(replies.filter(r=>r.status==='fulfilled'&&r.value).map(r=>r.value),this.#book.context,epoch);if(!c)break;await this.#sync([c]);accepted++;
  }return {accepted,epoch:this.checkpoint?.body.epoch??-1};
 }
 #anchor(){const old=this.#get('progress'),last=this.#book.context.last,sealed=last?{height:last.body.headerHeight,hash:last.body.headerHash}:null;return old&&(!sealed||old.height>=sealed.height)?old:sealed;}
 #observe(tip){if(tip.applicationHeight!==tip.headerHeight-1||!isHash(tip.appHash))throw new Error('invalid wallet application checkpoint');const p=observeProgress(this.#get('progress'),tip,Date.now(),this.#cfg.stallMs);this.#put('progress',p);if(this.#sessionHeight===null)this.#sessionHeight=p.height;return p;}
 async #refresh(attempt=0){
  this.#lease=null;const started=Date.now(),mono=performance.now(),ctx=this.#book.context;if(!ctx.last)throw new Error('wallet needs authenticated history');
  const nonce=randomBytes(32).toString('hex');
  const [route,replies]=await Promise.all([this.#rpc.tip(this.#anchor(),this.#get('progress')),Promise.allSettled(this.#cfg.witnesses.map(url=>request(url,{method:'head',nonce},{timeoutMs:2000})))]);
  this.#guard();const progress=this.#observe(route.value),heads=validReplies(replies,r=>verifyHead(r,ctx.policy,nonce,ctx.last)).length;
  // A running witness may have advanced while this wallet was proving or
  // decrypting. Catch up only through verified retained signatures/archives.
  if(heads<7&&attempt<2){const update=await this.#discoverCheckpoints(2);if(update.accepted)return this.#refresh(attempt+1);}
  walletFreshness({progress,sessionHeight:this.#sessionHeight,tip:route.value,certificate:ctx.last,heads,now:Date.now(),started,...this.#cfg});
  if(performance.now()-mono>=this.#cfg.ttlMs)throw new Error('wallet monotonic freshness expired');
  this.#lease={checkedAt:started,validUntil:started+this.#cfg.ttlMs,deadline:mono+this.#cfg.ttlMs,heads,rpc:{selected:route.url,verifiedSources:route.available,configuredSources:route.configured}};
  return route.value;
 }
 async refresh(){return this.#exclusive(async()=>{await this.#refresh();return this.status;});}
 // Explicit bounded recovery, never a payment or a bypass of witness renewal.
 // Durable quorum history advances two epochs at a time. Callers may resume
 // after a crash using the same journals; only the normal refresh grants a lease.
 async recover(){return this.#exclusive(async()=>{
  const discovery=await this.#discoverCheckpoints(2);let reason=null;
  try{await this.#refresh(2);}catch(e){this.#lease=null;reason=e.code==='HISTORY_RECOVERING'?'history-recovering':'fresh-quorum-required';}
  return {...this.status,acceptedEpochs:discovery.accepted,reason};
 });}
 #requireFresh(){this.#guard();if(!this.status.ready)throw new Error('wallet refresh required');}
 async #query(path,key,tip,verify){
  const anchor=this.#anchor();
  return this.#rpc.read(async url=>{
   // CometBFT ABCIQuery data is HexBytes in JSON-RPC (broadcast tx is base64).
   const inventory=path==='/inventory'||path==='/discovery-delta',r=await walletRpc(url,'abci_query',{path,data:Buffer.from(key).toString('hex')},inventory?2*1024*1024:256*1024),q=r.response;
   if(q?.code!==0||typeof q.value!=='string'||q.value.length>(inventory?1024*1024:200000))throw new Error('wallet note query failed; balance unknown');
   const envelope=JSON.parse(Buffer.from(q.value,'base64').toString()),height=envelope.height;
   if(!Number.isSafeInteger(height)||height+1<anchor.height||height>tip.headerHeight+8)throw new Error('stale or unbounded wallet snapshot');
   let v,lastError;
   // Current-state ABCI queries race the NEXT signed header. Retry that exact
   // target, never silently accept an unauthenticated current-state hash.
   for(let attempt=0;attempt<5;attempt++){
    this.#requireFresh();try{v=JSON.parse(await runVerifier(this.#cfg.verifier,['-verify',url,'-genesis',this.#cfg.genesis,'-height',String(height+1),'-app-hash',envelope.appHash,'-trusted-height',String(anchor.height),'-trusted-hash',anchor.hash],{timeoutMs:4000}));break;}catch(e){lastError=e;if(attempt<4)await new Promise(r=>setTimeout(r,500));}
   }
   if(!v)throw lastError;
   if(v.verified!==true||v.chain!==this.#cfg.policy.chainId||v.headerHeight!==height+1||v.applicationHeight!==height||!isHash(v.headerHash))throw new Error('wallet snapshot checkpoint mismatch');
   const verified=await verify(envelope,v,url);
   this.#requireFresh();this.#observe(v);return verified;
  });
 }
 async #passport(id,tip){
  fieldString(id);return this.#query('/passport',id,tip,(envelope,v)=>{const verified=verifyPassportEnvelope(envelope,v.appHash);if(verified.object.id!==id)throw new Error('wallet note substitution');return {...verified,epoch:envelope.summary.epoch};});
 }
 async #verifyReceipt(receipt){
  return verifyReceipt(receipt,this.#book.certificates.find(c=>c.body.epoch===receipt.anchorEpoch),{...this.#options,proofs:this.#proofs,chainId:this.#cfg.policy.chainId});
 }
 async #saved(txid){
  const row=this.#db.prepare('SELECT proof FROM wallet_receipts WHERE txid=?').get(txid);if(!row)return null;
  const receipt=JSON.parse(row.proof),result=await this.#verifyReceipt(receipt);if(result.txid!==txid)throw new Error('stored receipt transaction mismatch');return {receipt,result};
 }
 async receipt(txid){return this.#exclusive(()=>this.#saved(txid));}
 async #sealReceipt(txid,saved){
  if(!saved)return null;
  const c=this.#book.certificates.find(c=>saved.receipt.envelope.height>=c.body.fromHeight&&saved.receipt.envelope.height<=c.body.endHeight);
  if(saved.receipt.version===2||!c){this.#guard();commitReceipt(this.#db,txid,saved.receipt,saved.result.status);return saved;}
  const archive=JSON.parse(this.#book.archive(c.body.epoch)),headers={version:'2',entries:archive.entries.filter(e=>Number(e.header.header.height)>=saved.receipt.envelope.height+1).map(e=>({header:e.header,validators:e.validators,txs:[]}))};
  const receipt={...saved.receipt,version:2,anchorEpoch:c.body.epoch,headers},result=await this.#verifyReceipt(receipt);
  this.#guard();commitReceipt(this.#db,txid,receipt,result.status);return {receipt,result};
 }
 async sealReceipt(txid){return this.#exclusive(async()=>this.#sealReceipt(txid,await this.#saved(txid)));}
 async verifyReceipt(receipt){return this.#exclusive(()=>this.#verifyReceipt(JSON.parse(canonical(receipt))));}
 async verifyTransaction(wire){return this.#exclusive(async()=>{const copy=JSON.parse(canonical(wire));await this.#proofs.check(copy);return {txid:parseWire(copy).txid,proofValid:true,confirmed:false};});}
 async retainReceipt(receipt){return this.#exclusive(async()=>{
  const copy=JSON.parse(canonical(receipt)),result=await this.#verifyReceipt(copy);if(!result.final)throw new Error('final receipt required');
  const row=this.#db.prepare('SELECT wire FROM wallet_submissions WHERE txid=?').get(result.txid);
  if(row){if(row.wire!==canonical(copy.wire))throw new Error('restored receipt differs from exact outgoing payment');this.#guard();commitReceipt(this.#db,result.txid,copy,result.status);}
  return result;
 });}
 hasSubmission(txid){this.#guard();if(!isHash(txid))throw new Error('payment identifier');return !!this.#db.prepare('SELECT txid FROM wallet_submissions WHERE txid=?').get(txid);}
 async #reconcile(txid){
  if(!isHash(txid))throw new Error('payment identifier');
  const row=this.#db.prepare('SELECT * FROM wallet_submissions WHERE txid=?').get(txid);if(!row)throw new Error('unknown local payment');
  const saved=await this.#saved(txid);if(saved?.result.final)return (await this.#sealReceipt(txid,saved)).result;
  const wire=JSON.parse(row.wire);if(parseWire(wire).txid!==txid)throw new Error('stored wire mismatch');
  const found=await this.#findReceipt(wire);
  this.#guard();commitReceipt(this.#db,txid,found.receipt,found.result.status);
  this.#lease=null;return found.result;
 }
 async #findReceipt(wire){
  const p=parseWire(wire);await this.#proofs.check(wire);
  const txid=p.txid,tip=await this.#refresh(),anchor=this.#book.context.last,inputs=p.s.kind.toBigint()===0n?[p.s.id0.toString(),...(p.s.second.toBoolean()?[p.s.id1.toString()]:[])]:[];
  const found=await this.#query('/receipt',canonical({txid,inputs}),tip,async(envelope,v,url)=>{
   verifyPaymentEnvelope(envelope,v.appHash,wire);
   const headers=JSON.parse(await runVerifier(this.#cfg.verifier,['-export-receipt-proof',url,'-genesis',this.#cfg.genesis,'-height',String(envelope.height+1),'-trusted-height',String(anchor.body.headerHeight),'-trusted-hash',anchor.body.headerHash],{timeoutMs:4000}));
   const receipt={version:1,anchorEpoch:anchor.body.epoch,wire,envelope,headers},result=await this.#verifyReceipt(receipt);return {receipt,result};
  });
  this.#lease=null;return found;
 }
 // Obtain evidence for an incoming public transaction without claiming it was
 // submitted by this wallet or writing it into the outgoing payment journal.
 async receiptFor(wire){return this.#exclusive(()=>this.#findReceipt(JSON.parse(canonical(wire))));}
 async reconcile(txid){return this.#exclusive(()=>this.#reconcile(txid));}
 // Keyset pagination prevents a large outbox from monopolizing the wallet.
 // Persisted status labels are hints only; every delivered final status is verified.
 async payments({after='',limit=10}={}){return this.#exclusive(async()=>{
  if((after!==''&&!isHash(after))||!Number.isInteger(limit)||limit<1||limit>20)throw new Error('payment page bound');
  const rows=this.#db.prepare('SELECT txid,attempts FROM wallet_submissions WHERE txid>? ORDER BY txid LIMIT ?').all(after,limit),items=[];
  for(const r of rows){const saved=await this.#saved(r.txid);items.push({...r,...(saved?.result??{status:'unknown',final:false,confirmed:false})});}
  return {items,next:rows.length===limit?rows.at(-1).txid:null};
 });}
 async reconcilePending({after='',limit=2}={}){return this.#exclusive(async()=>{
  if((after!==''&&!isHash(after))||!Number.isInteger(limit)||limit<1||limit>2)throw new Error('reconciliation batch bound');
  const rows=this.#db.prepare('SELECT txid FROM wallet_submissions WHERE txid>? ORDER BY txid LIMIT ?').all(after,limit),items=[];
  for(const r of rows){try{items.push(await this.#reconcile(r.txid));}catch{this.#lease=null;items.push({txid:r.txid,status:'unknown',final:false,confirmed:false});}}
  return {items,next:rows.length===limit?rows.at(-1).txid:null};
 });}
 async #notes(ids){
  if(!Array.isArray(ids)||ids.length<1||ids.length>2||new Set(ids).size!==ids.length)throw new Error('wallet note batch bound');ids.forEach(fieldString);
  const tip=await this.#refresh(),notes=[];for(const id of ids)notes.push(await this.#passport(id,tip));
  const latest=await this.#rpc.tip(this.#anchor(),this.#get('progress'));this.#requireFresh();const progress=this.#observe(latest.value);
  if(progress.stalled||latest.value.headerHeight-this.#book.context.last.body.headerHeight>this.#cfg.maxLagBlocks||notes.some(n=>latest.value.applicationHeight-n.height>2))throw new Error('wallet snapshot expired during verification');
  return notes;
 }
 async notes(ids){return this.#exclusive(()=>this.#notes(ids));}
 async inventoryPage(query={start:0,root:null}){return this.#exclusive(async()=>{
  const q=inventoryQuery(canonical(query)),tip=await this.#refresh();
  if(q.root!==null&&this.#inventory?.root===q.root){
   const saved=this.#inventory;if(performance.now()-saved.at>300000)throw Error('inventory scan timeout');
   return this.#rpc.read(async url=>{const r=await walletRpc(url,'abci_query',{path:'/inventory',data:Buffer.from(canonical(q)).toString('hex')},2*1024*1024),v=r.response;if(v?.code!==0||typeof v.value!=='string'||v.value.length>1024*1024)throw Error('snapshot unavailable');const envelope=JSON.parse(Buffer.from(v.value,'base64'));if(envelope.height!==saved.height||envelope.appHash!==saved.appHash)throw Error('snapshot replaced');const p=verifyInventoryEnvelope(envelope,saved.appHash,q);this.#requireFresh();return p;});
  }
  const page=await this.#query('/inventory',canonical(q),tip,(envelope,v)=>verifyInventoryEnvelope(envelope,v.appHash,q));
  const latest=await this.#rpc.tip(this.#anchor(),this.#get('progress'));this.#requireFresh();const progress=this.#observe(latest.value);
  if(progress.stalled||latest.value.applicationHeight-page.height>2||latest.value.headerHeight-this.#book.context.last.body.headerHeight>this.#cfg.maxLagBlocks)throw Error('inventory snapshot expired');this.#inventory={root:page.root,height:page.height,appHash:page.appHash,at:performance.now()};return page;
 });}
 async discoveryDelta(anchor){return this.#exclusive(async()=>{
  const q=deltaQuery(canonical(anchor)),tip=await this.#refresh(),page=await this.#query('/discovery-delta',canonical(q),tip,(p,v)=>verifyDiscoveryDelta(p,v.appHash,q));
  const latest=await this.#rpc.tip(this.#anchor(),this.#get('progress'));this.#requireFresh();const progress=this.#observe(latest.value);
  if(progress.stalled||latest.value.applicationHeight-page.height>2||latest.value.headerHeight-this.#book.context.last.body.headerHeight>this.#cfg.maxLagBlocks)throw Error('delta snapshot expired');return page;
 });}
 async submit(wire){return this.#exclusive(async()=>{
  const copy=JSON.parse(canonical(wire)),p=parseWire(copy);if(p.s.kind.toBigint()!==0n)throw new Error('wallet submits transfers only');
  // Expensive ZK verification precedes the fresh network observations.
  await this.#proofs.check(copy);
  const saved=await this.#saved(p.txid);if(saved?.result.final)return saved.result;
  // Resolve any existing reservations only from authenticated final evidence.
  for(const id of [p.s.id0.toString(),...(p.s.second.toBoolean()?[p.s.id1.toString()]:[])]){
   const held=this.#db.prepare('SELECT txid FROM wallet_reservations WHERE note_id=? AND txid<>? LIMIT 21').all(id,p.txid);if(held.length>20)throw new Error('outbox reservation audit required');
   for(const r of held){const other=await this.#saved(r.txid);if(!other?.result.final)throw new Error('input reserved by unresolved payment; reconcile before spending');this.#guard();commitReceipt(this.#db,r.txid,other.receipt,other.result.status);}
  }
  const ids=[p.s.id0.toString(),...(p.s.second.toBoolean()?[p.s.id1.toString()]:[])],notes=await this.#notes(ids);
  const history=this.#book.context.policy.history;if(this.#get('progress').height>(history.generation+1)*history.span*8)throw new Error('wallet witness generation exhausted; renew history first');
  for(let i=0;i<notes.length;i++){const n=notes[i];if(n.object.spentBy!==null||n.object.commitment!==p.s[`commitment${i}`].toString())throw new Error('wallet input spent or commitment mismatch');const epoch=Number(p.s.epoch.toBigint()),expiry=Number(p.s.expiry.toBigint());if(epoch>n.epoch||expiry<n.epoch||expiry<epoch||expiry-epoch>10)throw new Error('wallet transfer epoch expired');}
  const encoded=canonical(copy),previous=this.#db.prepare('SELECT * FROM wallet_submissions WHERE txid=?').get(p.txid);if(previous&&previous.wire!==encoded)throw new Error('wallet exact retry mismatch');
  this.#requireFresh();reserveSubmission(this.#db,p.txid,copy);
  let status='unknown';try{const r=await this.#rpc.read(async url=>{this.#requireFresh();const r=await walletRpc(url,'broadcast_tx_sync',{tx:encodeWire(copy).toString('base64')});if(!Number.isSafeInteger(r.code))throw new Error('broadcast response');return r;});status=r.code===0?'admitted-unconfirmed':'unconfirmed';}catch{/* Exact payload remains durable; never infer non-delivery or regenerate. */}
  this.#db.prepare('UPDATE wallet_submissions SET status=? WHERE txid=?').run(status,p.txid);this.#lease=null;
  return {txid:p.txid,status,confirmed:false};
 });}
 close(){if(this.#busy)throw new Error('wallet operation running');if(this.#closed)return;this.#closed=true;this.#lease=null;try{this.#rpc.close();this.#book.close();this.#db.close();}finally{this.#unlock();}}
}
