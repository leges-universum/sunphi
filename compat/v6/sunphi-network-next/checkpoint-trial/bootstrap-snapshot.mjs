import assert from 'node:assert/strict';
import {verifyCheckpoint} from './checkpoint.mjs';
import {hash} from './crypto.mjs';
// CometBFT supplies appHash only after its light client has verified the header
// against the pinned bootstrap block. A newer snapshot also needs its own quorum.
export function acceptSnapshot(q,previous,policy,config,currentHeight){
 assert.equal(currentHeight,0);const sn=q.snapshot;assert(sn&&sn.format===1&&sn.chunks===1);
 assert(typeof sn.metadata==='string'&&sn.metadata.length<=131072);
 const doc=JSON.parse(Buffer.from(sn.metadata,'base64'));
 verifyCheckpoint(doc,policy,{previous,allowGap:true,configHash:hash(config)});
 assert.equal(Number(sn.height),doc.body.appHeight);assert.equal(q.appHash,doc.body.appHash);
 assert.equal(Buffer.from(sn.hash,'base64').toString('hex'),doc.body.snapshotHash);return doc;
}
