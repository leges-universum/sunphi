import assert from 'node:assert/strict';
import {BOUNDED_DOMAIN} from '../checkpoint-trial/research/bounded-schema.mjs';
// Runtime-neutral subset: do not import the database migration executor in Edge.
export function verifyServiceAnchor(anchor,terms){
 assert(terms&&terms.targetSchema===BOUNDED_DOMAIN);assert.equal(anchor.domain,terms.targetSchema);
 assert.equal(anchor.configHash,terms.configHash);assert.equal(anchor.height,terms.sourceHeight);
 assert.equal(anchor.sourceStateHash,terms.sourceRoot);assert.equal(anchor.issuance,false);
 assert.equal(anchor.retainsTerminalHistory,true);assert.deepEqual(anchor.archive,terms.archive);
}
