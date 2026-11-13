// Validate a retained predecessor only as upgrade evidence, never as permission
// for the current interpreter to execute the old schema.
import assert from 'node:assert/strict';
import {hash,exact} from './crypto.mjs';
import {origin} from './core.mjs';
import {FIXED_BLOCK_TIMING} from './fixed-block-timing.mjs';
import {indexedSchemaRootTerms,verifyIndexedSchemaPredecessor} from './research/indexed-schema-upgrade.mjs';
export function verifyConsumerSchemaPredecessor(config,fresh,upgrade){
 const {manifest:m,manifestHash}=fresh;
 assert.equal(manifestHash,upgrade.previousManifestHash,'schema predecessor manifest');
 assert.equal(hash(m),manifestHash,'retained genesis manifest damaged');
 exact(m,['domain','network','configHash','stateHash','root','height','issuance','imports','timing']);
 assert.equal(m.domain,'DUEBYTE_FRESH_GENESIS_V2');assert.deepEqual(m.timing,FIXED_BLOCK_TIMING);
 assert.equal(m.network,config.chainId);assert.equal(m.configHash,hash(config));assert.equal(m.stateHash,hash(origin(config)));
 assert.equal(m.height,0);assert.equal(m.issuance,false);assert.equal(m.imports,false);
 const next=indexedSchemaRootTerms(config,{certificate:upgrade.certificate,trustedBoundary:upgrade.trustedBoundary});
 verifyIndexedSchemaPredecessor({kind:'fresh-genesis',manifestHash,network:m.network,configHash:m.configHash,targetSchema:next.sourceSchema,sourceHeight:0,activationHeight:1,sourceRoot:m.stateHash,targetRoot:m.root,archive:null},next);
 return next;
}
