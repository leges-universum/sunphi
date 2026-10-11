// Isolated serial test arbiter. No network or issuance-fund authority.
import { randomBytes } from 'node:crypto';
import { NETWORK, digest, ADDRESS, newKey, identity } from './crypto.mjs';
import { checkTransfer, checkReceiptPackage, candidateMain, makeReservation, makeReceipt } from './protocol.mjs';

export function labState(owner,time=Date.now()) {
  if(!ADDRESS.test(owner)||!Number.isSafeInteger(time)||time<0)throw Error('Invalid lab identity/time');
  return {network:NETWORK,schema:1,tokenId:randomBytes(32).toString('hex'),revision:0,owner,lastCreditTime:time,history:[]};
}
export class LabLedger {
  #main; #pending=null; #used=new Set(); #outcomes=new Map(); #now;
  constructor(owner,time=0) { this.#main=labState(owner,time);this.#now=time; }
  get state(){return structuredClone(this.#main);}
  get status(){return this.#pending?'reserved':'owned';}
  advance(now){if(!Number.isSafeInteger(now)||now<this.#now)throw Error('Non-monotonic time');this.#now=now;}
  reserve(transfer) {
    const r=checkTransfer(transfer),h=digest(transfer.reservation);
    if(this.#pending&&digest(this.#pending.reservation)===h)return 'reserved';
    if(this.#pending||this.#used.has(r.transferId)||digest(this.#main)!==r.mainHash||
       r.sentAt>this.#now||r.expiresAt<=this.#now)throw Error('Reservation not accepted');
    this.#used.add(r.transferId);this.#pending=structuredClone(transfer);return 'reserved';
  }
  credit(pkg) {
    const p=checkReceiptPackage(pkg),prior=this.#outcomes.get(p.transferId);
    if(prior){if(prior.receiptHash===digest(pkg.receipt))return prior.status;throw Error('Transfer already resolved');}
    if(!this.#pending||digest(this.#pending.reservation)!==p.reservationHash||
       this.#now>=this.#pending.reservation.payload.expiresAt||p.receivedAt>this.#now)throw Error('Credit not accepted');
    this.#main=candidateMain(pkg);this.#pending=null;
    this.#outcomes.set(p.transferId,{status:'credited',receiptHash:digest(pkg.receipt)});return 'credited';
  }
  cancel(id) {
    if(this.#outcomes.get(id)?.status==='cancelled')return 'cancelled';
    if(!this.#pending||this.#pending.reservation.payload.transferId!==id||
       this.#now<this.#pending.reservation.payload.expiresAt)throw Error('Cancellation not accepted');
    this.#pending=null;this.#outcomes.set(id,{status:'cancelled'});return 'cancelled';
  }
}
export function demo() {
  const sender=newKey(),recipient=newKey(),a=identity(sender).address,b=identity(recipient).address;
  const ledger=new LabLedger(a,1000),initial=ledger.state;
  const transfer=makeReservation(sender,initial,b,1000,10000);
  ledger.reserve(transfer);
  const reserved=ledger.status;
  const unchanged=digest(ledger.state)===digest(initial);
  const receipt=makeReceipt(recipient,transfer,2000);
  const beforeAcceptance=ledger.state.owner===a;
  ledger.advance(2000);ledger.credit(receipt);
  return {network:NETWORK,assets:'laboratory fixtures only; no monetary value',
    sendingSignature:'verified',reserved,mainHashUnchangedUntilCredit:unchanged,
    receiptSignatureAloneDoesNotCredit:beforeAcceptance,recipientCredited:ledger.state.owner===b,
    replayResult:ledger.credit(receipt),historyEntries:ledger.state.history.length};
}
