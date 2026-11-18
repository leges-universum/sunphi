// One bounded page per call. Cursor advances only after durable remote receipt.
import assert from 'node:assert/strict';
import {indexedNotificationEvidence} from './indexed-notifications.mjs';
export async function observeIndexedPage({checkpoint,query,pins,previous,send,now}){
 const offset=previous?.receipt?.cursor??0;assert(Number.isSafeInteger(offset)&&offset>=0);
 const request={type:'payment-events',id:{offset,limit:8}},root=checkpoint.body.appHash;
 const proof=await (query.withLease?query.withLease(root,q=>q(request,root)):query(request,root));
 const page=await indexedNotificationEvidence(checkpoint,proof,pins,previous?.checkpoint,now);
 const packet={action:'observe_payments',checkpoint,proof};assert(Buffer.byteLength(JSON.stringify(packet))<=1200000,'notification proof exceeds bridge budget');
 const receipt=await send(packet);assert(Number.isSafeInteger(receipt.cursor)&&receipt.cursor>=page.end&&receipt.cursor<=page.total,'invalid durable observation cursor');
 return {checkpoint,receipt,backlog:receipt.cursor<page.total};
}
