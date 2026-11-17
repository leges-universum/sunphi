// Local storage codec only. Signed manifests and network chunks remain unchanged.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inflateRawSync} from 'node:zlib';
import {hash} from '../crypto.mjs';
const MAGIC=Buffer.from('DBPACK01');
export const PACK_HEADER=44,PACK_ENTRY=12;
export function packHeader(manifest){const b=Buffer.alloc(PACK_HEADER);MAGIC.copy(b);Buffer.from(hash(manifest),'hex').copy(b,8);b.writeUInt32LE(manifest.chunks,40);return b;}
export function readPackedBytes(file,manifest,index){
 assert(Number.isSafeInteger(index)&&index>=0&&index<manifest.chunks);
 const fd=fs.openSync(file,'r');try{
  const header=Buffer.alloc(PACK_HEADER);assert.equal(fs.readSync(fd,header,0,header.length,0),header.length,'truncated packed header');assert.deepEqual(header,packHeader(manifest),'packed manifest mismatch');
  const entry=Buffer.alloc(PACK_ENTRY);assert.equal(fs.readSync(fd,entry,0,entry.length,PACK_HEADER+index*PACK_ENTRY),entry.length,'truncated packed index');
  const offset=Number(entry.readBigUInt64LE()),size=entry.readUInt32LE(8),length=Math.min(manifest.chunkSize,manifest.bytes-index*manifest.chunkSize);
  assert(Number.isSafeInteger(offset)&&offset>=PACK_HEADER+manifest.chunks*PACK_ENTRY,'packed offset');assert(size>0&&size<=manifest.chunkSize+1024,'packed size');assert(offset+size<=fs.fstatSync(fd).size,'truncated packed data');
  const data=Buffer.alloc(size);assert.equal(fs.readSync(fd,data,0,size,offset),size);
  const result=inflateRawSync(data,{maxOutputLength:length,info:true});assert.equal(result.buffer.length,length,'packed expanded length');assert.equal(result.engine.bytesWritten,size,'trailing compressed bytes');return result.buffer;
 }finally{fs.closeSync(fd);}
}
