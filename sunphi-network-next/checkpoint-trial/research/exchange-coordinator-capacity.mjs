// Conservative, durable admission credits. No expiry or automatic reclamation:
// a timed-out offer is not proof that its external payment cannot still arrive.
import assert from 'node:assert/strict';
import {hex} from '../crypto.mjs';
export const COORDINATOR_CAPACITY=Object.freeze({
 records:4096, slotsPerOrder:8, recordBytes:320*1024,
 snapshotBytes:60*1024*1024, planBytes:96000, rawChars:200000
});
export const ORDER_RESERVE_BYTES=COORDINATOR_CAPACITY.slotsPerOrder*COORDINATOR_CAPACITY.recordBytes;
export const MAX_ADMITTED_ORDERS=Math.min(Math.floor(COORDINATOR_CAPACITY.records/8),Math.floor(COORDINATOR_CAPACITY.snapshotBytes/ORDER_RESERVE_BYTES));
export function validateAdmissions(orders,records=[]){
 assert(Array.isArray(orders)&&orders.length<=MAX_ADMITTED_ORDERS,'coordinator admission capacity');
 orders.forEach(hex);assert.deepEqual(orders,[...new Set(orders)].sort(),'noncanonical admissions');
 const admitted=new Set(orders),counts=new Map();
 for(const r of records){
  assert(admitted.has(r.intent.order),'intent without admission');
  const n=(counts.get(r.intent.order)||0)+1;assert(n<=8,'order reservation exhausted');counts.set(r.intent.order,n);
  assert(Buffer.byteLength(JSON.stringify(r.plan))<=COORDINATOR_CAPACITY.planBytes,'plan exceeds reserved capacity');
  assert(Buffer.byteLength(JSON.stringify(r))<300000,'record exceeds encryption capacity');
 }
 return orders;
}
export function admissionReceipt(order){hex(order);return {order,slots:8,bytes:ORDER_RESERVE_BYTES};}
