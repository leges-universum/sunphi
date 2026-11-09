import assert from 'node:assert/strict';
import {canonical} from './crypto.mjs';
// A checkpoint can advance between snapshot discovery and chunk download.
// Serve the requested immutable height within a bounded grace window. The
// receiver still checks its signed snapshot hash and verified header appHash.
export function snapshotChunk(q,publishedHeight,snapshot){
 assert.equal(q.index,0);assert(Number.isSafeInteger(q.height)&&q.height>0);
 assert(q.height<=publishedHeight&&q.height>=Math.max(1,publishedHeight-256),'snapshot outside download window');
 const state=snapshot(q.height);assert.equal(state.height,q.height);
 const bytes=Buffer.from(canonical(state));assert(bytes.length<=1048576);
 return {chunk:bytes.toString('base64')};
}
