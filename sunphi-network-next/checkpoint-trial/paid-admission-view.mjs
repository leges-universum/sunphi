// Read-only planning capability. Never trust an admission descriptor on a wire.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer} from './crypto.mjs';
export const PAID_ADMISSION='DUEBYTE_PAID_ADMISSION_V1';
const views=new WeakMap();
export function auditPaidAdmissionHead(h){
 exact(h,['version','sequence','count','history','lastActionHash']);assert.equal(h.version,PAID_ADMISSION);
 integer(h.sequence,1);integer(h.count,1);hex(h.history);hex(h.lastActionHash);return h;
}
export function bindPaidAdmissionView(state,head){auditPaidAdmissionHead(head);views.set(state,{digest:hash(state),head:structuredClone(head)});}
export function paidAdmissionView(state){const v=views.get(state);assert(v&&v.digest===hash(state),'verified admission planning view required');return structuredClone(v.head);}
