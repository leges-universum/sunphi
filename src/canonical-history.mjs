// Semantic identity excludes replaceable quorum-evidence encoding. Always verify
// the signed header chain BEFORE treating this projection as authoritative.
import { canonical } from './protocol.mjs';
import { packageArchive } from './archive-store.mjs';
import { isHash } from './epoch-seal.mjs';
export function canonicalHistory(bytes,version=2){
 if(!Buffer.isBuffer(bytes)||bytes.length>16*1024*1024)throw new Error('history byte bound');
 const a=JSON.parse(bytes);if(![1,'1'].includes(a.version)||!Array.isArray(a.entries)||a.entries.length!==9)throw new Error('history framing');
 const chainId=a.entries[0]?.header?.header?.chain_id;
 if(typeof chainId!=='string'||!/^sunphi-lab-[a-z0-9-]{1,48}$/.test(chainId))throw new Error('history chain');
 let first;
 const entries=a.entries.map((e,i)=>{
  const h=e.header?.header,height=Number(h?.height),hash=e.header?.commit?.block_id?.hash?.toLowerCase(),appHash=h?.app_hash?.toLowerCase(),txs=e.txs??[];
  if(i===0)first=height;
  if(!Number.isSafeInteger(height)||height!==first+i||first<1||(first-1)%8!==0||(version===2&&height>2041)||height>2040002041||h.chain_id!==chainId||!isHash(hash)||!isHash(appHash)||!Array.isArray(txs)||txs.length>16||(i===8&&txs.length))throw new Error('history entry');
  let n=0;for(const tx of txs){if(typeof tx!=='string'||tx.length>140000)throw new Error('history transaction');const b=Buffer.from(tx,'base64');if(b.toString('base64')!==tx)throw new Error('history base64');n+=b.length;}if(n>1024*1024)throw new Error('history block bytes');
  return {height,hash,appHash,txs};
 });
 return Buffer.from(canonical({version:2,chainId,entries}));
}
export function historyIdentity(bytes,version){if(![1,2,3].includes(version))throw new Error('history version');return packageArchive(version>=2?canonicalHistory(bytes,version):bytes);}
