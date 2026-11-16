// Bounded, overlapping windows. A cursor is saved only after signature verification.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFileSync} from 'node:fs';
import {fetchHeaderProof} from './header-transport.mjs';
const execute=promisify(execFile);
export async function fetchWindow({binary,genesisFile,url,anchor,end,file,fresh}){
 assert(Number.isSafeInteger(end)&&end>=anchor.height&&end-anchor.height<512,'window bound');
 const common=['-genesis',genesisFile,'-anchor-height',String(anchor.height),'-anchor-hash',anchor.blockHash,...(fresh?[]:['-historical'])];
 const options={encoding:'utf8',windowsHide:true,timeout:40000,maxBuffer:10*1048576};
 const text=await fetchHeaderProof({url,start:anchor.height,end});
 writeFileSync(file,text,{mode:0o600});
 const result=await execute(binary,['-verify-file',file,...common],options);
 return {proof:JSON.parse(text),verified:JSON.parse(result.stdout),bytes:Buffer.byteLength(text)};
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
export async function recoverPath({binary,genesisFile,url,file,anchor,target,requirements=[],progress=null,save=()=>{},window=256,onWindow=()=>{},onProgress=()=>{},adaptive=false,fetch=fetchWindow,refreshTarget}){
 assert(Number.isSafeInteger(window)&&window>=2&&window<=512);
 assert(Number.isSafeInteger(target)&&target>=anchor.height);
 let cursor=progress?.cursor??anchor,seen=progress?.seen??[],count=0,totalBytes=0,verified;
 let span=adaptive?Math.min(window,Number.isSafeInteger(progress?.span)&&progress.span>=2?progress.span:32):window,refreshes=0;
 assert(cursor.height>=anchor.height&&cursor.height<=target,'cursor bounds');
 for(;;){
  // A long offline recovery can outlive the freshness of its starting target.
  // Extend the same verified path, never replace its anchors or accept an old
  // head as current. Each fetch remains bounded and the final bridge check is fresh.
  if(refreshTarget&&cursor.height+span-1>=target){
   assert(++refreshes<=64,'recovery target keeps advancing; retry verified progress');
   const next=await refreshTarget({cursor:{...cursor},target});assert(Number.isSafeInteger(next)&&next>=target,'recovery target rollback');target=next;
  }
  const end=Math.min(target,cursor.height+span-1),fresh=end===target;
  let result;const started=Date.now();
  await onProgress({phase:'headers',height:cursor.height,target,windows:count,bytes:totalBytes});
  try{result=await fetch({binary,genesisFile,url,file,anchor:cursor,end,fresh});}
  catch(e){
   const attempted=end-cursor.height+1;
   if(!['RECOVERY_TRANSPORT_TIMEOUT','RECOVERY_WINDOW_TOO_LARGE'].includes(e.code)||attempted<=2)throw e;
   span=Math.max(2,Math.ceil(attempted/2));continue;
  }
  assert.equal(result.verified.height,end,'verified recovery window end');
  verified=result.verified;seen=inspectRequired(result.proof,requirements,seen);
  cursor={height:verified.height,blockHash:verified.blockHash};
  if(adaptive){const duration=Math.max(1,Date.now()-started);span=Math.max(2,Math.min(window,Math.floor(span*Math.min(2,4000/duration))));}
  save({cursor,seen,...(adaptive?{span}:{})});count++;totalBytes+=result.bytes;
  await onWindow({height:cursor.height,target,windows:count,bytes:result.bytes});
  await onProgress({phase:'headers',height:cursor.height,target,windows:count,bytes:totalBytes});
  if(fresh)break;
 }
 for(const r of requirements)assert(seen.includes(r.id),'required retained anchor not visited');
 return {verified,windows:count,totalBytes};
}
