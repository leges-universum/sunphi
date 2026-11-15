import assert from 'node:assert/strict';
// The latest seen commit may contain only the first quorum. A previous commit
// is canonical evidence carried by the next block and includes late votes.
export async function maintenanceEvidence(rpc,status,now=Date.now()){
 assert(!status.sync_info.catching_up,'Wait for synchronized history');
 const height=Number(status.sync_info.latest_block_height)-1;assert(Number.isSafeInteger(height)&&height>0);
 const c=await rpc('commit',{height:String(height)}),header=c.signed_header.header;
 assert.equal(Number(header.height),height,'Maintenance evidence height mismatch');
 assert(now-Date.parse(header.time)<30000&&Date.parse(header.time)<=now+5000,'Network must be progressing');
 assert(c.signed_header.commit.signatures.filter(s=>s.block_id_flag===2).length>=9,'Wait for at least nine available validators before maintenance');
 return {height,signatures:c.signed_header.commit.signatures.filter(s=>s.block_id_flag===2).length};
}
