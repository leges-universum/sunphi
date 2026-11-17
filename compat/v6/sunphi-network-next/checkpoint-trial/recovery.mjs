// Bounded, overlapping windows. A cursor is saved only after signature verification.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFileSync} from 'node:fs';
const execute=promisify(execFile);
export async function fetchWindow({binary,genesisFile,url,anchor,end,file,fresh}){
 assert(Number.isSafeInteger(end)&&end>=anchor.height&&end-anchor.height<512,'window bound');
 const common=['-genesis',genesisFile,'-anchor-height',String(anchor.height),'-anchor-hash',anchor.blockHash,...(fresh?[]:['-historical'])];
 const options={encoding:'utf8',windowsHide:true,timeout:40000,maxBuffer:10*1048576};
 const out=await execute(binary,['-export',url,...common,'-end',String(end)],options);
 writeFileSync(file,out.stdout,{mode:0o600});
 const result=await execute(binary,['-verify-file',file,...common],options);
 return {proof:JSON.parse(out.stdout),verified:JSON.parse(result.stdout),bytes:Buffer.byteLength(out.stdout)};
}
export function inspectRequired(proof,requirements,seen){
 const next=new Set(seen);
 for(const r of requirements){
  const s=proof.headers.find(x=>Number(x.header.height)===r.height);
  if(!s)continue;
  assert.equal(s.commit.block_id.hash.toLowerCase(),r.blockHash,'retained history conflict');
  if(r.appHash)assert.equal(s.header.app_hash.toLowerCase(),r.appHash,'checkpoint state conflict');
  next.add(r.id);
 }
 return [...next].sort();
}
export async function recoverPath({binary,genesisFile,url,file,anchor,target,requirements=[],progress=null,save=()=>{},window=256,onWindow=()=>{}}){
 assert(Number.isSafeInteger(window)&&window>=2&&window<=512);
 assert(Number.isSafeInteger(target)&&target>=anchor.height);
 let cursor=progress?.cursor??anchor,seen=progress?.seen??[],count=0,totalBytes=0,verified;
 assert(cursor.height>=anchor.height&&cursor.height<=target,'cursor bounds');
 for(;;){
  const end=Math.min(target,cursor.height+window-1),fresh=end===target;
  const result=await fetchWindow({binary,genesisFile,url,file,anchor:cursor,end,fresh});
  verified=result.verified;seen=inspectRequired(result.proof,requirements,seen);
  cursor={height:verified.height,blockHash:verified.blockHash};
  save({cursor,seen});count++;totalBytes+=result.bytes;
  await onWindow({height:cursor.height,target,windows:count,bytes:result.bytes});
  if(fresh)break;
 }
 for(const r of requirements)assert(seen.includes(r.id),'required retained anchor not visited');
 return {verified,windows:count,totalBytes};
}
