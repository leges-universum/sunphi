// Compression runs off the consensus event loop. No ledger is opened for writing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {deflateRawSync} from 'node:zlib';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readChunk,verifyChunk,chunkProof,validateManifest} from './indexed-snapshot.mjs';
import {PACK_HEADER,PACK_ENTRY,packHeader,readPackedBytes} from './snapshot-pack-codec.mjs';
export function packIndexedSnapshot(file,manifest,levels){
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL(import.meta.url),{workerData:{operation:'pack-indexed-snapshot',file,manifest,levels}});let result;
  worker.once('message',r=>{result=r;});worker.once('error',reject);worker.once('exit',code=>{if(code===0&&result)resolve(result);else reject(Error('snapshot pack verification failed'));});
 });
}
function verify(file,manifest,levels){
 for(let index=0;index<manifest.chunks;index++)verifyChunk(manifest,{index,data:readPackedBytes(file,manifest,index).toString('base64'),proof:chunkProof(levels,index)});
}
if(!isMainThread&&parentPort&&workerData?.operation==='pack-indexed-snapshot'){
 const {file,manifest,levels}=workerData;validateManifest(manifest);assert(file.endsWith('state.sqlite'),'generated snapshot required');
 const packed=file.slice(0,-6)+'pack';
 if(fs.existsSync(packed)){verify(packed,manifest,levels);parentPort.postMessage({file:packed,bytes:fs.statSync(packed).size,verified:true});}
 else{
  const temp=packed+'.'+randomUUID()+'.pending';
  const stat=fs.statfsSync(file),budget=manifest.bytes+manifest.chunks*(PACK_ENTRY+1024)+PACK_HEADER;assert(stat.bavail*stat.bsize>=budget+256*1024**2,'insufficient snapshot compression space');
  let fd;try{
   fd=fs.openSync(temp,'wx',0o600);assert.equal(fs.writeSync(fd,packHeader(manifest)),PACK_HEADER);let offset=PACK_HEADER+manifest.chunks*PACK_ENTRY;
   for(let index=0;index<manifest.chunks;index++){
    const bytes=verifyChunk(manifest,readChunk(file,manifest,levels,index)),compressed=deflateRawSync(bytes,{level:3}),entry=Buffer.alloc(PACK_ENTRY);assert(compressed.length<=manifest.chunkSize+1024);
    entry.writeBigUInt64LE(BigInt(offset));entry.writeUInt32LE(compressed.length,8);assert.equal(fs.writeSync(fd,entry,0,entry.length,PACK_HEADER+index*PACK_ENTRY),entry.length);assert.equal(fs.writeSync(fd,compressed,0,compressed.length,offset),compressed.length);offset+=compressed.length;
   }
   fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;verify(temp,manifest,levels);
   fs.linkSync(temp,packed);
   if(process.platform!=='win32'){const directory=fs.openSync(dirname(packed),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}
   fs.unlinkSync(temp);parentPort.postMessage({file:packed,bytes:fs.statSync(packed).size,verified:true});
  }catch(e){if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);throw e;}
 }
}
