import { parseWire, VERSION } from './protocol.mjs';
import { brotliCompressSync,brotliDecompressSync,constants } from 'node:zlib';

// Lossless binary framing: fixed 32-byte field values, raw proof bytes.
// A bounded Brotli envelope reduces repeated proof structure. Both wire size
// and decompressed length are capped BEFORE parsing; cryptographic bytes stay exact.
const MAGIC=Buffer.from('SUN2');
export function encodeWire(wire) {
  parseWire(wire);
  const p=wire.proof, proof=Buffer.from(p.proof,'base64');
  if(proof.toString('base64')!==p.proof)throw new Error('noncanonical proof base64');
  const fields=[...p.publicInput,...p.publicOutput];
  const header=Buffer.alloc(8);MAGIC.copy(header);header.writeUInt32BE(proof.length,4);
  const raw=Buffer.concat([header,...fields.map(f=>Buffer.from(BigInt(f).toString(16).padStart(64,'0'),'hex')),proof]);
  const frame=Buffer.alloc(8);frame.write('SZP2');frame.writeUInt32BE(raw.length,4);
  return Buffer.concat([frame,brotliCompressSync(raw,{params:{[constants.BROTLI_PARAM_QUALITY]:4,[constants.BROTLI_PARAM_LGWIN]:17}})]);
}
export function decodeWire(bytes) {
  let b=Buffer.from(bytes);
  if(b.length>100000)throw new Error('oversized transaction');
  if(b.subarray(0,4).toString()==='SZP2'){
    if(b.length<9||b.readUInt32BE(4)>100000)throw new Error('compressed size');
    const declared=b.readUInt32BE(4),result=brotliDecompressSync(b.subarray(8),{maxOutputLength:100000,info:true});
    if(result.buffer.length!==declared||result.engine.bytesWritten!==b.length-8)throw new Error('compressed frame length');
    b=result.buffer;
  }
  if(b.length<1068||b.length>100000||!b.subarray(0,4).equals(MAGIC))throw new Error('invalid binary envelope');
  const length=b.readUInt32BE(4),count=30,offset=8+count*32;
  if(b.length!==offset+length)throw new Error('invalid proof frame length');
  const fields=Array.from({length:count},(_,i)=>BigInt('0x'+b.subarray(8+i*32,40+i*32).toString('hex')).toString());
  const wire={version:VERSION,proof:{publicInput:fields.slice(0,12),publicOutput:fields.slice(12),maxProofsVerified:0,proof:b.subarray(offset).toString('base64')}};
  parseWire(wire);return wire;
}
