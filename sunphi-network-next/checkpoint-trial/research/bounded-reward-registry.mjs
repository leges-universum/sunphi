// Authenticated reward accounts and compressed radix indexes. No census scan
// during block execution. Rebuilding and comparing indexes is an offline audit.
import assert from 'node:assert/strict';
import {changeRadix,radixCount,radixIds} from './bounded-radix-index.mjs';
import {canonical,exact,hex,integer,hash,publicKey} from '../crypto.mjs';
import {auditRewardAccount} from '../node-rewards.mjs';
import {indexedRewardLedger,storedRewardLedger,rewardRegistryTotals,rewardRegistryChanges,rewardPayoutCursor} from '../reward-registry-view.mjs';
export const REWARD_TOTALS='rewards/totals';
export const REWARD_CURSOR='rewards/payout-cursor';
function cursorValue(record){exact(record,['after']);if(record.after!==null)hex(record.after);return record.after;}
export const rewardAccountKey=id=>'rewards/accounts/'+hex(id);
const kinds=['all','witness','payable'];
export const rewardOwners=n=>n?[...new Set([n.management,...n.payouts.map(p=>p.wallet)])]:[];
export const rewardOwnerKind=owner=>{publicKey(owner);return 'owner/'+hash(owner);};
const validKind=kind=>kinds.includes(kind)||/^owner\/[a-f0-9]{64}$/.test(kind);
const qualifies=(n,kind)=>!!n&&(kind==='all'||(kind==='witness'?n.kind==='witness':BigInt(n.earned)>BigInt(n.paid)&&n.payouts.length>0));
const change=(tx,kind,id,insert)=>changeRadix(tx,'rewards/index/'+kind,id,insert);
export function rewardIndexCount(get,kind){assert(validKind(kind));return radixCount(get,'rewards/index/'+kind);}
export function* rewardIndexIds(get,kind,options={}){assert(validKind(kind));yield* radixIds(get,'rewards/index/'+kind,options);}
function decodeTotals(v){
 exact(v,['count','earned','paid','size']);integer(v.count);integer(v.size,2);
 for(const k of ['earned','paid'])assert(typeof v[k]==='string'&&/^(0|[1-9][0-9]*)$/.test(v[k]));
 const totals={...v,earned:BigInt(v.earned),paid:BigInt(v.paid)};assert(totals.paid<=totals.earned);return totals;
}
export function readRewardRegistry(get,header){
 if(!header){assert.equal(get(REWARD_TOTALS),undefined,'orphan reward totals');return header;}
 const totals=decodeTotals(get(REWARD_TOTALS));assert.equal(rewardIndexCount(get,'all'),totals.count,'reward census');
 return storedRewardLedger(header,totals,id=>get(rewardAccountKey(id)),(kind,options)=>rewardIndexIds(get,kind,options),auditRewardAccount,cursorValue(get(REWARD_CURSOR)));
}
export function writeRewardRegistry(tx,rewards){
 if(!rewards)return rewards;const ledger=indexedRewardLedger(rewards,auditRewardAccount),totals=rewardRegistryTotals(ledger.nodes),changes=rewardRegistryChanges(ledger.nodes);
 for(const [id,n]of changes){const key=rewardAccountKey(id),old=tx.get(key);if(old&&canonical(old)===canonical(n))continue;
  auditRewardAccount(id,n);for(const kind of kinds)if(qualifies(old,kind)!==qualifies(n,kind))change(tx,kind,id,qualifies(n,kind));
  const before=new Set(rewardOwners(old)),after=new Set(rewardOwners(n));
  for(const owner of new Set([...before,...after]))if(before.has(owner)!==after.has(owner))change(tx,rewardOwnerKind(owner),id,after.has(owner));
  tx.set(key,n);
 }
 tx.set(REWARD_TOTALS,{...totals,earned:String(totals.earned),paid:String(totals.paid)});
 const after=rewardPayoutCursor(ledger.nodes);if(tx.get(REWARD_CURSOR)?.after!==after)tx.set(REWARD_CURSOR,{after});
 return {...ledger,nodes:{}};
}
export function auditRewardRegistry(records,header){
 const rows=[...records].filter(([k])=>k.startsWith('rewards/')),nodes={};
 if(!header){assert.equal(rows.length,0,'orphan reward records');return header;}
 assert.deepEqual(header.nodes,{},'inline reward records forbidden');
 for(const [key,n]of rows)if(key.startsWith('rewards/accounts/')){const id=key.slice('rewards/accounts/'.length);auditRewardAccount(id,n);nodes[id]=n;}
 const rewards={...header,nodes},expected=new Map(),tx={get:k=>expected.get(k),set:(k,v)=>expected.set(k,v),delete:k=>expected.delete(k)};
 writeRewardRegistry(tx,rewards);
 const cursor=records.get(REWARD_CURSOR),after=cursorValue(cursor);if(after!==null)assert(Object.hasOwn(nodes,after),'orphan payout cursor');expected.set(REWARD_CURSOR,cursor);
 assert.deepEqual(new Map(rows.sort(([a],[b])=>a<b?-1:1)),new Map([...expected].sort(([a],[b])=>a<b?-1:1)),'reward records, aggregates or indexes differ');
 return rewards;
}
