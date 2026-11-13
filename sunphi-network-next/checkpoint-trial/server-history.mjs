import assert from 'node:assert/strict';
// Local administrative continuity check. Never downloads or reconstructs state.
export async function committedHistoryEvidence(rpc,chainId,height){
 assert(typeof chainId==='string'&&chainId.length>0);
 assert(Number.isSafeInteger(height)&&height>0);
 const result=await rpc('commit',{height:String(height)}),header=result.signed_header?.header,commit=result.signed_header?.commit;
 assert(header&&commit,'Committed header required');
 assert.equal(result.canonical,true,'Canonical commit required');
 assert.equal(header.chain_id,chainId,'History chain mismatch');
 assert.equal(Number(header.height),height,'History height mismatch');
 assert.equal(Number(commit.height),height,'Commit height mismatch');
 assert(/^[a-fA-F0-9]{64}$/.test(header.app_hash),'Committed state root required');
 assert(/^[a-fA-F0-9]{64}$/.test(commit.block_id?.hash),'Committed block hash required');
 return {chainId,height,appHash:header.app_hash.toUpperCase(),blockHash:commit.block_id.hash.toUpperCase()};
}
export async function assertCommittedHistory(rpc,expected){
 const actual=await committedHistoryEvidence(rpc,expected.chainId,expected.height);
 assert.deepEqual(actual,expected,'Committed history changed across update');return actual;
}
