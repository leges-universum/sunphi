// Per-recipient cumulative subsidy and Home fee records with authenticated totals.
import assert from 'node:assert/strict';
import {exact,integer,hex} from '../crypto.mjs';
import {changeRadix,radixCount,radixIds} from './bounded-radix-index.mjs';
import {ECONOMIC_MAPS,economicHeader,indexedEconomicRecords,storedEconomicRecords,economicRecordTotals,economicRecordChanges} from '../economic-record-view.mjs';
const prefix=field=>{assert(ECONOMIC_MAPS.includes(field));return 'economy/'+field;};
export const economicRecordKey=(field,id)=>prefix(field)+'/records/'+hex(id);
export function readEconomicTotals(get,field){const n=get(prefix(field)+'/totals');if(!n)return null;exact(n,['count','total']);integer(n.count);assert(typeof n.total==='string'&&/^(0|[1-9][0-9]*)$/.test(n.total));assert.equal(n.count,radixCount(get,prefix(field)+'/index'),'economic record count');return n;}
export const economicRecordIds=(get,field,options)=>radixIds(get,prefix(field)+'/index',options);
export function readEconomicRecords(get,book){
 if(!book)return book;const out={...book};for(const field of ECONOMIC_MAPS){if(book[field]===undefined)continue;assert.deepEqual(book[field],{});const n=readEconomicTotals(get,field);assert(n,'missing economic totals');const cache=new Map();out[field]=storedEconomicRecords({...n,total:BigInt(n.total)},id=>{if(!cache.has(id))cache.set(id,get(economicRecordKey(field,id))?.amount);return cache.get(id);});}return out;
}
export function writeEconomicRecords(tx,book){
 if(!book)return book;for(const field of ECONOMIC_MAPS){if(book[field]===undefined)continue;const map=indexedEconomicRecords(book[field]);
  for(const [id,amount]of economicRecordChanges(map)){const key=economicRecordKey(field,id),old=tx.get(key);if(old?.amount===amount)continue;assert(!old||BigInt(amount)>=BigInt(old.amount),'cumulative economic reduction');if(!old)changeRadix(tx,prefix(field)+'/index',id,true);tx.set(key,{amount});}
  const n=economicRecordTotals(map);tx.set(prefix(field)+'/totals',{count:n.count,total:String(n.total)});
 }return economicHeader(book);
}
export function auditEconomicRecords(records,book){
 const rows=[...records].filter(([k])=>k.startsWith('economy/')),out=book?{...book}:book;
 if(!book){assert.equal(rows.length,0,'orphan economic records');return book;}
 for(const field of ECONOMIC_MAPS){if(book[field]===undefined)continue;assert.deepEqual(book[field],{});out[field]={};for(const [key,n]of rows)if(key.startsWith(prefix(field)+'/records/')){const id=key.slice((prefix(field)+'/records/').length);hex(id);exact(n,['amount']);out[field][id]=n.amount;}}
 const expected=new Map(),tx={get:k=>expected.get(k),set:(k,v)=>expected.set(k,v),delete:k=>expected.delete(k)};writeEconomicRecords(tx,out);
 const sorted=m=>[...m].sort(([a],[b])=>a<b?-1:a>b?1:0);assert.deepEqual(sorted(rows),sorted(expected),'economic records, totals or indexes differ');return out;
}
