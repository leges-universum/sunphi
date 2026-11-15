// Private copy-on-write monetary records. Wire objects cannot claim this capability.
import assert from 'node:assert/strict';
import {hex} from './crypto.mjs';
const views=new WeakMap();
const value=v=>{assert(typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v),'canonical economic amount');return BigInt(v);};
function lookup(base,id){for(let p=base;p;p=p.parent){if(p.changes.has(id))return p.changes.get(id);if(p.read)return p.read(id);}}
function snapshot(map){
 const v=views.get(map);assert(v);const changes=new Map();let {count,total}=v.base;
 for(const [id,n]of v.loaded){const old=lookup(v.base,id);if(n===old)continue;const next=value(n);if(old===undefined)count++;else{assert(next>=value(old),'cumulative earnings cannot decrease');total-=value(old);}total+=next;changes.set(id,n);}
 return changes.size?{parent:v.base,changes,count,total}:v.base;
}
function fork(base){
 const loaded=new Map(),read=id=>{hex(id);if(!loaded.has(id)){const n=lookup(base,id);if(n!==undefined){value(n);loaded.set(id,n);}}return loaded.get(id);};
 const map=new Proxy(Object.create(null),{
  get:(_,id)=>typeof id==='string'&&/^[a-f0-9]{64}$/.test(id)?read(id):undefined,
  set:(_,id,n)=>{hex(id);value(n);loaded.set(id,n);return true;},
  has:(_,id)=>typeof id==='string'&&/^[a-f0-9]{64}$/.test(id)&&read(id)!==undefined,
  getOwnPropertyDescriptor:(_,id)=>typeof id==='string'&&/^[a-f0-9]{64}$/.test(id)&&read(id)!==undefined?{enumerable:true,configurable:true,value:read(id)}:undefined,
  ownKeys(){assert.fail('full economic record enumeration in a block frame');},
  deleteProperty(){assert.fail('cumulative economic records cannot be deleted');},
  defineProperty(){assert.fail('economic property definition forbidden');},setPrototypeOf(){assert.fail('economic prototype mutation forbidden');}
 });views.set(map,{base,loaded});return map;
}
export function indexedEconomicRecords(map){
 if(views.has(map))return fork(snapshot(map));const changes=new Map();let total=0n;
 for(const [id,n]of Object.entries(map)){hex(id);total+=value(n);changes.set(id,n);}
 return fork({parent:null,changes,count:changes.size,total});
}
export function storedEconomicRecords(totals,read){return fork({parent:null,changes:new Map(),...totals,read});}
export function economicRecordChanges(map){
 const out=new Map();for(let p=snapshot(map);p;p=p.parent)for(const [id,n]of p.changes)if(!out.has(id))out.set(id,n);return out;
}
export function economicRecordTotals(map){if(!views.has(map))return null;const {count,total}=snapshot(map);return {count,total};}
export function economicAuditEntries(map,extra=[]){
 if(!views.has(map))return Object.entries(map);
 const v=views.get(map),ids=new Set([...v.loaded.keys(),...economicRecordChanges(map).keys(),...extra]);
 return [...ids].map(id=>[id,map[id]]).filter(([,n])=>n!==undefined);
}
export const ECONOMIC_MAPS=['earned','homeFeesEarned'];
export function cloneSubsidy(book){if(!book)return book;const header={...book};for(const field of ECONOMIC_MAPS)delete header[field];const out=structuredClone(header);for(const field of ECONOMIC_MAPS)if(book[field]!==undefined)out[field]=views.has(book[field])?indexedEconomicRecords(book[field]):structuredClone(book[field]);return out;}
export function economicHeader(book){if(!book)return book;const out={...book};for(const field of ECONOMIC_MAPS)if(out[field]!==undefined)out[field]={};return out;}
