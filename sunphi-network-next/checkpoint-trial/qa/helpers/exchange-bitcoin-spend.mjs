// Test-only local external-wallet signing; all keys are disposable.
import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const dsha=b=>createHash('sha256').update(createHash('sha256').update(b).digest()).digest();
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;},u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
const vector=b=>{assert(b.length<253);return Buffer.concat([Buffer.from([b.length]),b]);};
export function bitcoinSpend(E,{txid,index,amount,output,script,key,secret,refundAt=0}){
 const prev=Buffer.concat([Buffer.from(txid,'hex').reverse(),u32(index)]),seq=u32(0xfffffffe),dest=Buffer.concat([u64(BigInt(amount)-1000n),vector(Buffer.from(output,'hex'))]),wscript=Buffer.from(script,'hex');
 const preimage=Buffer.concat([u32(2),dsha(prev),dsha(seq),prev,vector(wscript),u64(amount),seq,dsha(dest),u32(refundAt),u32(1)]),sig=new E.SigningKey(key).sign('0x'+dsha(preimage).toString('hex'));
 const derInt=h=>{let b=Buffer.from(h.slice(2),'hex');while(b.length>1&&b[0]===0)b=b.subarray(1);if(b[0]&128)b=Buffer.concat([Buffer.from([0]),b]);return Buffer.concat([Buffer.from([2,b.length]),b]);};
 const pair=Buffer.concat([derInt(sig.r),derInt(sig.s)]),signature=Buffer.concat([Buffer.from([0x30,pair.length]),pair,Buffer.from([1])]),witness=secret?[signature,Buffer.from(secret,'hex'),Buffer.from([1]),wscript]:[signature,Buffer.alloc(0),wscript];
 return Buffer.concat([u32(2),Buffer.from('000101','hex'),prev,Buffer.from([0]),seq,Buffer.from([1]),dest,Buffer.from([witness.length]),...witness.map(vector),u32(refundAt)]).toString('hex');
}
