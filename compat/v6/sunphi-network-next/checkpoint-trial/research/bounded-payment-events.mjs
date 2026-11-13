// Immutable status transitions, indexed independently of wallet pages.
import assert from 'node:assert/strict';
import {hash,exact,integer} from '../crypto.mjs';
export const eventSlot=n=>'payment-events/'+n;
export function appendPaymentEvent(tx,r){
 const head=tx.get('meta/paymentEvents')??{count:0};integer(head.count);assert(Number.isSafeInteger(head.count+1));
 tx.set(eventSlot(head.count),{pid:r.intent.pid,digest:r.digest,status:r.status,terminalHeight:r.terminalHeight,executeAt:r.executeAt??null});tx.set('meta/paymentEvents',{count:head.count+1});
}
export function auditPaymentEvents(records,money){
 const head=records.get('meta/paymentEvents');exact(head,['count']);integer(head.count);const last=new Map(),seen=new Set();
 for(let n=0;n<head.count;n++){
  const r=records.get(eventSlot(n));exact(r,['pid','digest','status','terminalHeight','executeAt']);assert(money.requests[r.pid]);assert.equal(hash(money.requests[r.pid].intent),r.digest);
  assert(['RESERVED','SCHEDULED','SETTLED','EXPIRED','CANCELLED'].includes(r.status));integer(r.terminalHeight);
  const prior=last.get(r.pid);if(prior)assert(['RESERVED','SCHEDULED'].includes(prior.status),'transition after terminal status');
  const id=r.pid+':'+r.status;assert(!seen.has(id),'duplicate payment transition');seen.add(id);last.set(r.pid,r);
 }
 for(const [id,r]of Object.entries(money.requests))assert.equal(last.get(id)?.status,r.status,'notification journal completeness');
 for(const key of records.keys())if(key.startsWith('payment-events/'))assert(/^payment-events\/(0|[1-9][0-9]*)$/.test(key)&&Number(key.slice(15))<head.count,'orphan notification event');
}
