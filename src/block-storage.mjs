// Store the already compressed transaction envelopes as BLOBs, avoiding the
// additional 4/3 expansion from JSON/base64 in the application journal.
export function packBlock(txs){
  if(!Array.isArray(txs)||txs.length>16)throw new Error('block count');
  const h=Buffer.alloc(6);h.write('SBL2');h.writeUInt16BE(txs.length,4);
  const parts=[h];let total=6;
  for(const s of txs){const b=Buffer.from(s,'base64');if(b.toString('base64')!==s||b.length>100000)throw new Error('invalid stored envelope');const l=Buffer.alloc(4);l.writeUInt32BE(b.length);parts.push(l,b);total+=4+b.length;}
  if(total>1048646)throw new Error('block size');return Buffer.concat(parts);
}
export function unpackBlock(value){
  // Read-only compatibility with early local0.2 test databases.
  if(typeof value==='string'){if(value.length>1400000)throw new Error('legacy size');return JSON.parse(value);}
  const b=Buffer.from(value);if(b.length<6||b.length>1048646||b.subarray(0,4).toString()!=='SBL2')throw new Error('invalid stored block');
  const count=b.readUInt16BE(4);if(count>16)throw new Error('block count');const txs=[];let at=6;
  for(let i=0;i<count;i++){if(at+4>b.length)throw new Error('truncated block');const n=b.readUInt32BE(at);at+=4;if(n>100000||at+n>b.length)throw new Error('stored transaction size');txs.push(b.subarray(at,at+n).toString('base64'));at+=n;}
  if(at!==b.length)throw new Error('trailing block bytes');return txs;
}
