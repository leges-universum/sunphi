// A State Sync follower may lack old Comet headers retained by an existing wallet.
// Source selection is availability only: recoverPath still verifies every header.
import assert from 'node:assert/strict';
export async function selectHistorySource({local,remote,anchor,minHeight,request,boundary}){
 for(const url of [...new Set([local,remote].filter(Boolean))]){
  const endpoint=new URL(url);assert(endpoint.protocol==='http:'&&endpoint.hostname==='127.0.0.1'&&!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash&&endpoint.pathname==='/','authenticated local history route required');
  let tip,start,block;
  try{
   tip=await request(url,'commit');
   const latest=Number(tip?.signed_header?.header?.height);if(!Number.isSafeInteger(latest)||latest<minHeight)continue;
   start=await request(url,'commit',{height:String(anchor.height)});
  }catch{continue;}
  assert.equal(Number(start?.signed_header?.header?.height),anchor.height,'history anchor height conflict');
  assert.equal(start?.signed_header?.commit?.block_id?.hash?.toLowerCase(),anchor.blockHash,'retained history conflict');
  if(boundary){
   try{block=await request(url,'block',{height:String(boundary.height)});}catch{continue;}
   assert.equal(Number(block?.block?.header?.height),boundary.height,'schema boundary height conflict');
   assert.equal(block?.block?.header?.app_hash?.toLowerCase(),boundary.appHash,'schema boundary root conflict');
   assert(/^[0-9a-f]{64}$/i.test(block?.block_id?.hash??''),'schema boundary block hash');
  }
  return {url,latest:Number(tip.signed_header.header.height),...(boundary?{boundary:block}:{})};
 }
 throw Error('No authenticated history source has the retained wallet anchor yet. Saved verification progress is retained.');
}
