import { PrivateKey } from 'o1js';
import { PrivateVault, encryptPrivateBackup, decryptPrivateBackup } from './private-vault.mjs';
import { WalletNetwork } from './wallet-network.mjs';
import { commitment, decryptOutput, newNote, Note, Statement, MAX_NOTE } from './circuit.mjs';
import { statement } from './wallet.mjs';
import { ProverSession } from './prover-session.mjs';
import { createInvoice, verifyInvoice } from './payment-invoice.mjs';
import { canonical, exact, parseWire, makeWire } from './protocol.mjs';

function config(network,mode){if(mode!=='isolated'||!(network instanceof WalletNetwork))throw new Error('isolated authenticated WalletNetwork required');return network.identity;}
function validate(s,identity){
 exact(s,['version','identity','key','receipts','invoices','drafts']);
 if(s.version!==1||s.identity!==identity||typeof s.key!=='string'||s.key.length>64||!Array.isArray(s.receipts)||s.receipts.length>128||!Array.isArray(s.invoices)||s.invoices.length>256||!Array.isArray(s.drafts)||s.drafts.length>64)throw new Error('private wallet identity or capacity');
 const key=PrivateKey.fromBase58(s.key);if(key.toBase58()!==s.key)throw new Error('noncanonical private wallet key');
 const seen=new Set();for(const i of s.invoices){const v=verifyInvoice(i,{allowExpired:true});if(i.recipient!==key.toPublicKey().toBase58()||seen.has(v.id))throw new Error('invalid or duplicate own invoice');seen.add(v.id);}
 return key;
}

// Private note openings are derived from real confirmed receipts on every open.
// No persisted balance/status flag, cached amount or sender assertion is trusted.
// There is deliberately no HTTP API for this key-bearing object.
export class PrivateWallet{
 #vault;#network;#state;#key;#notes=new Map();#busy=false;#closed=false;
 static async create({mode,network,path,password,key=PrivateKey.random()}){
  const identity=config(network,mode),state={version:1,identity,key:key.toBase58(),receipts:[],invoices:[],drafts:[]};validate(state,identity);
  return PrivateWallet.#attach(PrivateVault.create(path,password,state),network);
 }
 static async open({mode,network,path,password}){config(network,mode);return PrivateWallet.#attach(PrivateVault.open(path,password),network);}
 static async restore({mode,network,path,password,backup,backupPassword}){
  const identity=config(network,mode),state=decryptPrivateBackup(backup,backupPassword);validate(state,identity);
  // Verify before creating a new file. Restore never overwrites an existing vault
  // and never imports the sender's trust book or an old spendability decision.
  const probe=new PrivateWallet();probe.#network=network;probe.#state=state;probe.#key=validate(state,identity);probe.#notes=await probe.#rebuild(state);await probe.#verifyDrafts();
  return PrivateWallet.#attach(PrivateVault.create(path,password,state),network);
 }
 static async #attach(vault,network){
  const w=new PrivateWallet();w.#vault=vault;w.#network=network;
  try{w.#state=vault.read();w.#key=validate(w.#state,network.identity);w.#notes=await w.#rebuild(w.#state);await w.#verifyDrafts();w.#guard();return w;}
  catch(e){vault.close();w.#key=null;w.#state=null;throw e;}
 }
 #guard(){if(this.#closed)throw new Error('private wallet closed');this.#vault.guard();if(this.#network.identity!==this.#state.identity)throw new Error('private wallet network mismatch');}
 async #exclusive(fn){if(this.#busy)throw new Error('private wallet operation running');this.#busy=true;try{this.#guard();const result=await fn();this.#guard();return result;}finally{this.#busy=false;}}
 async #extract(receipt){
  const result=await this.#network.verifyReceipt(receipt);if(!result.confirmed)throw new Error('incoming payment not confirmed');
  const p=parseWire(receipt.wire),notes=[];
  for(let index=0;index<2;index++){
   let note;try{note=decryptOutput(p.o,index,this.#key);}catch{continue;}
   // Zero-value padding is not a spendable note and must not inflate the list.
   if(note.value.toBigInt()>0n)notes.push({id:p.ids[index],txid:p.txid,index,note,height:result.height});
  }
  if(!notes.length)throw new Error('payment has no positive output for this recipient');
  return notes;
 }
 async #rebuild(state){
  const map=new Map(),seen=new Set();
  for(const r of state.receipts){const txid=parseWire(r.wire).txid;if(seen.has(txid))throw new Error('duplicate stored incoming receipt');seen.add(txid);
   for(const n of await this.#extract(r)){if(map.has(n.id))throw new Error('incoming note identity collision');map.set(n.id,n);}
  }return map;
 }
 #checkDraft(draft){
  exact(draft,['invoice','wire','receipt']);const invoice=verifyInvoice(draft.invoice,{allowExpired:true}),p=parseWire(draft.wire);
  if(p.s.kind.toBigint()!==0n||p.o.commitment0.toString()!==commitment(invoice.note).toString())throw new Error('prepared invoice output mismatch');
  const ids=[p.s.id0.toString(),...(p.s.second.toBoolean()?[p.s.id1.toString()]:[])];
  for(let i=0;i<ids.length;i++){const n=this.#notes.get(ids[i]);if(!n||commitment(n.note).toString()!==p.s[`commitment${i}`].toString())throw new Error('prepared input does not belong to wallet');}
  decryptOutput(p.o,1,this.#key);return p;
 }
 async #draftResult(d){
  if(d.receipt===null)return null;
  if(parseWire(d.receipt.wire).txid!==parseWire(d.wire).txid)throw new Error('prepared final receipt mismatch');
  const result=await this.#network.retainReceipt(d.receipt);
  if(result.txid!==parseWire(d.wire).txid||!result.final)throw new Error('prepared final receipt mismatch');return result;
 }
 async #verifyDrafts(){const seen=new Set();for(const d of this.#state.drafts){const p=this.#checkDraft(d);if(seen.has(p.txid))throw new Error('duplicate prepared payment');seen.add(p.txid);await this.#network.verifyTransaction(d.wire);await this.#draftResult(d);}}
 #retainDraftReceipt(d,receipt){this.#guard();const next={...this.#state,drafts:this.#state.drafts.map(x=>x===d?{...x,receipt}:x)};this.#vault.write(next);this.#state=next;}
 get address(){this.#guard();return this.#key.toPublicKey().toBase58();}
 get inventory(){
  this.#guard();return {kind:'historical-receipts',spendableBalance:null,items:[...this.#notes.values()].map(n=>({id:n.id,txid:n.txid,index:n.index,amount:n.note.value.toString(),confirmedHeight:n.height,state:'fresh-check-required'}))};
 }
 invoice(amount,options){
  this.#guard();return this.rememberInvoice(createInvoice(this.#key,amount,options));
 }
 rememberInvoice(invoice){
  this.#guard();if(this.#busy)throw new Error('private wallet operation running');const copy=JSON.parse(canonical(invoice)),v=verifyInvoice(copy,{allowExpired:true});
  if(copy.recipient!==this.address)throw new Error('invoice recipient does not own this wallet');
  if(this.#state.invoices.some(i=>verifyInvoice(i,{allowExpired:true}).id===v.id))return copy;
  if(this.#state.invoices.length>=256)throw new Error('invoice capacity reached');
  const next={...this.#state,invoices:[...this.#state.invoices,copy]};this.#vault.write(next);this.#state=next;return copy;
 }
 invoiceStatus(id){
  this.#guard();const invoice=this.#state.invoices.find(i=>verifyInvoice(i,{allowExpired:true}).id===id);if(!invoice)throw new Error('unknown own invoice');
  const expected=commitment(verifyInvoice(invoice,{allowExpired:true}).note).toString(),matches=[...this.#notes.values()].filter(n=>commitment(n.note).toString()===expected);
  return {id,status:matches.length===0?'unpaid':matches.length===1?'paid':'duplicate-payments-review',payments:matches.map(n=>({id:n.id,txid:n.txid,amount:n.note.value.toString()})),timeliness:'not-established-by-receipt'};
 }
 async importReceipt(receipt,{invoiceId}={}){return this.#exclusive(async()=>{
  if(Buffer.byteLength(canonical(receipt))>3*1024*1024)throw new Error('incoming receipt size limit');const copy=JSON.parse(canonical(receipt)),notes=await this.#extract(copy);
  if(invoiceId!==undefined){
   const invoice=this.#state.invoices.find(i=>verifyInvoice(i,{allowExpired:true}).id===invoiceId);if(!invoice)throw new Error('unknown own invoice');
   const expected=commitment(verifyInvoice(invoice,{allowExpired:true}).note).toString();
   if(notes.filter(n=>commitment(n.note).toString()===expected).length!==1)throw new Error('recipient, amount or invoice binding mismatch');
   const paid=this.invoiceStatus(invoiceId);if(paid.payments.some(p=>p.txid!==notes[0].txid))throw new Error('invoice already paid by another transaction');
  }
  const txid=notes[0].txid,old=this.#state.receipts.find(r=>parseWire(r.wire).txid===txid);
  if(old){
   // Retain stronger historical protection without ever downgrading a seal.
   if(old.version===1&&copy.version===2){this.#guard();const next={...this.#state,receipts:this.#state.receipts.map(r=>r===old?copy:r)};this.#vault.write(next);this.#state=next;}
   return {txid,duplicate:true,imported:0};
  }
  if(this.#state.receipts.length>=128)throw new Error('incoming receipt capacity reached');
  this.#guard();const next={...this.#state,receipts:[...this.#state.receipts,copy]};this.#vault.write(next);this.#state=next;for(const n of notes)this.#notes.set(n.id,n);
  return {txid,duplicate:false,imported:notes.length};
 });}
 async importTransaction(wire,options){
  this.#guard();const found=await this.#network.receiptFor(wire);return this.importReceipt(found.receipt,options);
 }
 get prepared(){this.#guard();return this.#state.drafts.map(d=>({txid:parseWire(d.wire).txid,invoiceId:verifyInvoice(d.invoice,{allowExpired:true}).id,recipient:d.invoice.recipient,amount:d.invoice.amount,fee:parseWire(d.wire).s.fee.toString(),state:'status-requires-verification'}));}
 async preparedResult(txid){return this.#exclusive(async()=>{const d=this.#state.drafts.find(d=>parseWire(d.wire).txid===txid);if(!d)throw new Error('unknown prepared payment');return await this.#draftResult(d)??(await this.#network.receipt(txid))?.result??null;});}
 async paymentReceipt(txid){return this.#exclusive(async()=>{const d=this.#state.drafts.find(d=>parseWire(d.wire).txid===txid);if(!d)throw new Error('unknown prepared payment');const receipt=d.receipt??(await this.#network.receipt(txid))?.receipt;if(!receipt)throw new Error('final receipt unavailable');const result=await this.#network.verifyReceipt(receipt);if(!result.final||result.txid!==txid)throw new Error('final receipt mismatch');return JSON.parse(canonical(receipt));});}
 async preparePayment(invoice,ids,{fee=0n,prover}={}){return this.#exclusive(async()=>{
  if(!(prover instanceof ProverSession)||this.#state.drafts.length>=64)throw new Error('private prover required or prepared payment capacity reached');
  const copy=JSON.parse(canonical(invoice)),payment=verifyInvoice(copy);
  if(typeof fee!=='bigint'||fee<0n||fee>MAX_NOTE||!Array.isArray(ids)||ids.length<1||ids.length>2||new Set(ids).size!==ids.length||ids.some(id=>!this.#notes.has(id)))throw new Error('payment input or fee');
  const selected=ids.map(id=>this.#notes.get(id));
  for(const d of this.#state.drafts){const p=parseWire(d.wire);if(ids.some(id=>id===p.s.id0.toString()||id===p.s.id1.toString())){const final=await this.#draftResult(d)??(await this.#network.receipt(p.txid))?.result;if(!final?.final)throw new Error('input reserved by prepared payment; recover its status first');}}
  const observed=await this.#network.notes(ids);
  for(let i=0;i<ids.length;i++){const r=observed[i],n=selected[i];if(r.object.id!==n.id||r.object.commitment!==commitment(n.note).toString()||r.object.spentBy!==null||r.epoch!==observed[0].epoch)throw new Error('payment input spent, mismatched or epoch changed');}
  const total=selected.reduce((n,item)=>n+item.note.value.toBigInt(),0n),change=total-payment.note.value.toBigInt()-fee;
  if(change<0n||change>MAX_NOTE)throw new Error('insufficient inputs or change out of range');
  const zero=newNote(0n,this.#key.toPublicKey()),out=newNote(change,this.#key.toPublicKey()),s=statement({inputs:selected,epoch:observed[0].epoch,fee});
  const proof=await prover.prove({kind:'transfer',statement:Statement.toJSON(s),notes:[selected[0].note,selected[1]?.note??zero,payment.note,out].map(n=>Note.toJSON(n)),keys:[this.#key.toBase58(),this.#key.toBase58()]});
  if(canonical(proof.publicInput)!==canonical(Statement.toFields(s).map(f=>f.toString())))throw new Error('prover changed payment terms');
  const wire=makeWire(proof);await this.#network.verifyTransaction(wire);this.#checkDraft({invoice:copy,wire,receipt:null});verifyInvoice(copy);this.#guard();
  const next={...this.#state,drafts:[...this.#state.drafts,{invoice:copy,wire,receipt:null}]};this.#vault.write(next);this.#state=next;
  return {txid:parseWire(wire).txid,invoiceId:payment.id,amount:copy.amount,fee:fee.toString(),state:'prepared-not-sent'};
 });}
 async sendPrepared(txid){return this.#exclusive(async()=>{
  const draft=this.#state.drafts.find(d=>parseWire(d.wire).txid===txid);if(!draft)throw new Error('unknown prepared payment');
  const retained=await this.#draftResult(draft);if(retained)return retained;
  const final=await this.#network.receipt(txid);if(final?.result.final){this.#retainDraftReceipt(draft,final.receipt);return final.result;}
  verifyInvoice(draft.invoice);return this.#network.submit(draft.wire);
 });}
 async recoverPrepared(txid){return this.#exclusive(async()=>{
  const d=this.#state.drafts.find(d=>parseWire(d.wire).txid===txid);if(!d)throw new Error('unknown prepared payment');
  const old=await this.#draftResult(d);if(old)return old;
  let saved=await this.#network.receipt(txid);
  if(!saved?.result.final&&this.#network.hasSubmission(txid)){await this.#network.reconcile(txid);saved=await this.#network.receipt(txid);}
  const found=saved?.result.final?saved:await this.#network.receiptFor(d.wire);
  if(found.result.final)this.#retainDraftReceipt(d,found.receipt);return found.result;
 });}
 async inspectNotes(ids){return this.#exclusive(async()=>{
  if(!Array.isArray(ids)||ids.length<1||ids.length>2||new Set(ids).size!==ids.length||ids.some(id=>!this.#notes.has(id)))throw new Error('known private note batch required');
  const observed=await this.#network.notes(ids);this.#guard();
  const items=observed.map((r,index)=>{const n=this.#notes.get(ids[index]);if(r.object.id!==n.id||r.object.createdBy!==n.txid||r.object.index!==n.index||r.object.commitment!==commitment(n.note).toString())throw new Error('private note state mismatch');return {id:n.id,amount:n.note.value.toString(),state:r.object.spentBy===null?'unspent-at-snapshot':'spent',spentBy:r.object.spentBy,height:r.height};});
  // This is a bounded observation, not an aggregate balance or authorization to
  // spend: submit must still check freshness and durable outbox reservations.
  return {kind:'verified-note-snapshot',items,spendableBalance:null};
 });}
 backup(password){this.#guard();if(this.#busy)throw new Error('private wallet operation running');return encryptPrivateBackup(this.#state,password);}
 close(){if(this.#busy)throw new Error('private wallet operation running');if(this.#closed)return;this.#closed=true;this.#notes.clear();this.#key=null;this.#state=null;this.#vault.close();}
}
