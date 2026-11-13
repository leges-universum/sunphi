// Dense authenticated owner slots. Swap removal bounds updates independently of
// the number of owners and outputs. Readers pin one root across every page.
import assert from 'node:assert/strict';
import {hash} from '../crypto.mjs';
import {appendPaymentEvent,auditPaymentEvents} from './bounded-payment-events.mjs';
const root=owner=>'wallet/'+hash(owner);
const positive=o=>o&&BigInt(o.value)>0n;
const active=r=>r&&['RESERVED','SCHEDULED'].includes(r.status);
export const walletHeadKey=root;
export const walletSlotKey=(owner,kind,index)=>root(owner)+'/'+kind+'/'+index;
const reverse=(kind,id,owner)=>'wallet-reverse/'+kind+'/'+hash(owner)+'/'+id;
export const emptyWalletHead=()=>({outputs:0,requests:0,history:0});
function change(tx,owner,kind,id,insert){
 const key=root(owner),head=tx.get(key)??emptyWalletHead(),rev=reverse(kind,id,owner),slot=tx.get(rev);
 if(insert){assert(slot===undefined,'duplicate owner slot');assert(Number.isSafeInteger(head[kind]+1));tx.set(walletSlotKey(owner,kind,head[kind]),{id});tx.set(rev,{index:head[kind]++});}
 else{assert(slot&&Number.isSafeInteger(slot.index)&&slot.index>=0&&slot.index<head[kind],'missing owner slot');const lastIndex=--head[kind],last=tx.get(walletSlotKey(owner,kind,lastIndex));assert(last);assert.equal(tx.get(walletSlotKey(owner,kind,slot.index))?.id,id);if(slot.index!==lastIndex){tx.set(walletSlotKey(owner,kind,slot.index),last);tx.set(reverse(kind,last.id,owner),{index:slot.index});}tx.delete(walletSlotKey(owner,kind,lastIndex));tx.delete(rev);}
 if(head.outputs||head.requests||head.history)tx.set(key,head);else tx.delete(key);
}
export function indexWalletChanges(tx,touched){for(const [key,r]of touched){
 const id=key.slice(key.indexOf('/')+1);let old=[],next=[];
 if(r.bucket==='outputs'){if(positive(r.before))old=[r.before.owner];if(positive(r.value))next=[r.value.owner];}
 else if(r.bucket==='requests'){
  if(r.value&&r.before?.status!==r.value.status)appendPaymentEvent(tx,r.value);
  if(r.before){assert(r.value,'wallet history cannot be removed');assert.equal(hash(r.before.intent),hash(r.value.intent),'payment intent is immutable');assert.equal(r.before.intent.sender,r.value.intent.sender);assert.equal(r.before.intent.recipient,r.value.intent.recipient);}
  else if(r.value)for(const owner of new Set([r.value.intent.sender,r.value.intent.recipient]))change(tx,owner,'history',id,true);
  if(active(r.before))old=[...new Set([r.before.intent.sender,r.before.intent.recipient])];if(active(r.value))next=[...new Set([r.value.intent.sender,r.value.intent.recipient])];
 }else continue;
 for(const owner of old)if(!next.includes(owner))change(tx,owner,r.bucket,id,false);
 for(const owner of next)if(!old.includes(owner))change(tx,owner,r.bucket,id,true);
}}
export function createWalletIndex(entries,money){const tx={get:k=>entries.get(k),set:(k,v)=>entries.set(k,v),delete:k=>entries.delete(k)};tx.set('meta/paymentEvents',{count:0});for(const bucket of ['outputs','requests'])for(const [id,value]of Object.entries(money[bucket]).sort(([a],[b])=>a<b?-1:1))indexWalletChanges(tx,new Map([[bucket+'/'+id,{bucket,value}]]));}
export function auditWalletIndex(records,money){
 auditPaymentEvents(records,money);
 const expected=new Map(),entry=owner=>{const k=root(owner);if(!expected.has(k))expected.set(k,{owner,outputs:new Set(),requests:new Set(),history:new Set()});return expected.get(k);};
 for(const [id,o]of Object.entries(money.outputs))if(positive(o))entry(o.owner).outputs.add(id);
 for(const [id,r]of Object.entries(money.requests))for(const owner of new Set([r.intent.sender,r.intent.recipient])){const e=entry(owner);e.history.add(id);if(active(r))e.requests.add(id);}
 const used=new Set();for(const [key,e]of expected){const h=records.get(key);assert.deepEqual(h,{outputs:e.outputs.size,requests:e.requests.size,history:e.history.size},'wallet counts');used.add(key);for(const kind of ['outputs','requests','history'])for(let n=0;n<h[kind];n++){const slot=walletSlotKey(e.owner,kind,n),id=records.get(slot)?.id;assert(e[kind].delete(id),'wallet completeness');used.add(slot);const rev=reverse(kind,id,e.owner);assert.deepEqual(records.get(rev),{index:n});used.add(rev);}}
 for(const key of records.keys())if(key.startsWith('wallet/')||key.startsWith('wallet-reverse/'))assert(used.has(key),'unexpected wallet index record');
}
