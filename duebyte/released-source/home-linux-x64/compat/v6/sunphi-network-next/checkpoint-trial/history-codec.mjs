// Lossless local storage encoding. It does not certify consensus or change appHash.
import assert from 'node:assert/strict';
import {deflateSync,inflateSync} from 'node:zlib';
import {exact,hash,hex,integer} from './crypto.mjs';

export const HISTORY_INTERVAL=64;
export const HISTORY_PREFIX='DUEBYTE_HISTORY_V1:';
const MAX_BYTES=8*1024*1024,MAX_OPS=100000,MAX_DEPTH=128;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const own=(x,k)=>Object.hasOwn(x,k);
function pack(value){
 const json=JSON.stringify(value);assert(Buffer.byteLength(json)<=MAX_BYTES,'history payload limit');
 return HISTORY_PREFIX+deflateSync(json,{level:3}).toString('base64');
}
function unpack(body){
 assert(typeof body==='string'&&Buffer.byteLength(body)<=2*MAX_BYTES,'history encoded limit');
 if(!body.startsWith(HISTORY_PREFIX))return {kind:'full',state:JSON.parse(body)};
 const text=body.slice(HISTORY_PREFIX.length),data=Buffer.from(text,'base64');
 assert(data.toString('base64')===text,'history base64');
 const value=JSON.parse(inflateSync(data,{maxOutputLength:MAX_BYTES}).toString('utf8'));
 assert(value.kind==='full'||value.kind==='delta','history kind');
 exact(value,value.kind==='full'?['kind','state']:['kind','baseHeight','baseRoot','ops']);return value;
}
function diff(before,after,path,ops){
 assert(path.length<=MAX_DEPTH,'history path depth');
 if(before===after)return;
 if(object(before)&&object(after)){
  for(const key of Object.keys(before))if(!own(after,key))ops.push(['delete',[...path,key]]);
  for(const key of Object.keys(after)){
   if(!own(before,key))ops.push(['set',[...path,key],after[key]]);
   else diff(before[key],after[key],[...path,key],ops);
  }
 }else if(JSON.stringify(before)!==JSON.stringify(after))ops.push(['set',path,after]);
 assert(ops.length<=MAX_OPS,'history operation limit');
}
function apply(state,ops){
 assert(Array.isArray(ops)&&ops.length<=MAX_OPS,'history operation limit');
 for(const op of ops){
  assert(Array.isArray(op)&&(op[0]==='set'?op.length===3:op[0]==='delete'&&op.length===2),'history operation');
  const path=op[1];assert(Array.isArray(path)&&path.length>0&&path.length<=MAX_DEPTH&&path.every(k=>typeof k==='string'),'history path');
  let target=state;
  for(const key of path.slice(0,-1)){assert(object(target)&&own(target,key),'history missing parent');target=target[key];}
  assert(object(target),'history object required');const key=path.at(-1);
  if(op[0]==='delete'){assert(own(target,key),'history missing field');delete target[key];}
  else Object.defineProperty(target,key,{value:op[2],enumerable:true,writable:true,configurable:true});
 }
 return state;
}
export function encodeHistory(state,previous=null,previousRoot=null){
 integer(state.height);const full=pack({kind:'full',state});
 if(!previous||state.height!==previous.height+1||state.height%HISTORY_INTERVAL===0)return full;
 hex(previousRoot);const ops=[];diff(previous,state,[],ops);
 const delta=pack({kind:'delta',baseHeight:previous.height,baseRoot:previousRoot,ops});
 return delta.length<full.length?delta:full;
}
export function decodeHistoryRow(row,previousState=null,previousRow=null){
 const value=unpack(row.body);hex(row.root);integer(row.height);let state;
 if(value.kind==='full')state=value.state;
 else{
  integer(value.baseHeight);hex(value.baseRoot);
  assert(previousState&&previousRow&&value.baseHeight===previousRow.height&&row.height===previousRow.height+1,'history height gap');
  assert.equal(previousState.height,previousRow.height,'history base height');
  assert.equal(hash(previousState),previousRow.root,'history base integrity');
  assert.equal(value.baseRoot,previousRow.root,'history parent root');state=apply(structuredClone(previousState),value.ops);
 }
 assert.equal(state.height,row.height,'history state height');assert.equal(hash(state),row.root,'stored state integrity');return state;
}
// Bounded reconstruction, with every intermediate state's original root checked.
// A row root is a local integrity check, NOT a trusted network checkpoint.
export function readHistory(db,height){
 integer(height);const rows=db.prepare('SELECT height,body,root FROM blocks WHERE height<=? ORDER BY height DESC LIMIT ?').all(height,HISTORY_INTERVAL);
 assert(rows[0]?.height===height,'snapshot unavailable');const chain=[];
 for(const row of rows){hex(row.root);const value=unpack(row.body);chain.push({row,value});if(value.kind==='full')break;}
 assert(chain.at(-1)?.value.kind==='full','history checkpoint unavailable');
 let state,previous;
 for(const {row} of chain.reverse()){state=decodeHistoryRow(row,state,previous);previous=row;}
 return state;
}
