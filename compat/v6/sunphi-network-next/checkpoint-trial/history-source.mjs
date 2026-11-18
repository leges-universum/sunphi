// A State Sync follower may lack old Comet headers retained by an existing wallet.
// Source selection is availability only: recoverPath still verifies every header.
import assert from 'node:assert/strict';
export async function selectHistorySource({local,remote,anchor,minHeight,request}){
 for(const url of [...new Set([local,remote].filter(Boolean))]){
  const endpoint=new URL(url);assert(endpoint.protocol==='http:'&&endpoint.hostname==='127.0.0.1'&&!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash&&endpoint.pathname==='/','authenticated local history route required');
  let tip,start;
  try{
   tip=await request(url,'commit');
   const latest=Number(tip?.signed_header?.header?.height);if(!Number.isSafeInteger(latest)||latest<minHeight)continue;
   start=await request(url,'commit',{height:String(anchor.height)});
  }catch{continue;}
  assert.equal(Number(start?.signed_header?.header?.height),anchor.height,'history anchor height conflict');
  assert.equal(start?.signed_header?.commit?.block_id?.hash?.toLowerCase(),anchor.blockHash,'retained history conflict');
  return {url,latest:Number(tip.signed_header.header.height)};
 }
 throw Error('No authenticated history source has the retained wallet anchor yet. Saved verification progress is retained.');
}
