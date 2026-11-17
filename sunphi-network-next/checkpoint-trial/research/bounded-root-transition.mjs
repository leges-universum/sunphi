// Offline preparation/verification only. Does not route ABCI or activate a root.
import assert from 'node:assert/strict';
import {auditState} from '../core.mjs';
import {hash,exact,canonical,hex,integer} from '../crypto.mjs';
import {validatorQuorum} from '../authority.mjs';
import {BOUNDED_DOMAIN} from './bounded-network-interpreter.mjs';
import {verifyBoundedArchive} from './bounded-archive-migration.mjs';
import {verifyCheckpoint} from '../checkpoint.mjs';
export function prepareBoundedRootTransition(source,config,handler,trustedSourceRoot){
 auditState(source,config);assert.equal(hash(source),trustedSourceRoot,'trusted source root');assert.equal(hash(handler.config),hash(config));assert(source.authority,'transition authority required');
 const root=handler.root,anchor=handler.store.proof('meta/anchor',root).value;assert.equal(anchor.domain,BOUNDED_DOMAIN);assert.equal(anchor.sourceStateHash,trustedSourceRoot);assert.equal(anchor.height,source.height);assert.equal(anchor.issuance,false);
 assert.equal(handler.store.meta.sequence,1,'transition must follow only archive migration');assert.equal(canonical(handler.snapshotForAudit()),canonical(source),'migration state mismatch');
 assert(anchor.archive?.status==='READY','complete archive required');assert.equal(anchor.archive.first,0,'transition requires history from genesis');assert.equal(anchor.archive.count,source.height+1,'transition requires every source block');verifyBoundedArchive(handler);
 return {domain:'DUEBYTE_INDEXED_ROOT_TRANSITION_V1',network:config.chainId,configHash:hash(config),generation:source.authority.generation,sourceHeight:source.height,activationHeight:source.height+1,sourceRoot:trustedSourceRoot,targetRoot:root,targetSchema:BOUNDED_DOMAIN,archive:anchor.archive,issuance:false};
}
export function verifyBoundedRootTransition(certificate,source,config,handler,trustedSourceRoot){
 exact(certificate,['body','approvals']);const expected=prepareBoundedRootTransition(source,config,handler,trustedSourceRoot);assert.deepEqual(certificate.body,expected,'root transition terms');validatorQuorum(certificate.body,certificate.approvals,source.authority.validators);return expected;
}
// Client validation still requires the source root to have been independently
// authenticated by a checkpoint/header path. A peer-supplied source is not trust.
export function verifyBoundedTransitionTerms(certificate,source,config,trustedSourceRoot){
 exact(certificate,['body','approvals']);auditState(source,config);assert.equal(hash(source),trustedSourceRoot);const b=certificate.body;
 exact(b,['domain','network','configHash','generation','sourceHeight','activationHeight','sourceRoot','targetRoot','targetSchema','archive','issuance']);
 assert.equal(b.domain,'DUEBYTE_INDEXED_ROOT_TRANSITION_V1');assert.equal(b.network,config.chainId);assert.equal(b.configHash,hash(config));assert.equal(b.generation,source.authority.generation);
 assert.equal(b.sourceRoot,trustedSourceRoot);assert.equal(b.sourceHeight,source.height);assert.equal(b.activationHeight,source.height+1);hex(b.targetRoot);assert.equal(b.targetSchema,BOUNDED_DOMAIN);assert.equal(b.issuance,false);
 const a=b.archive;exact(a,['status','domain','count','first','last','appHash','digest']);assert.equal(a.status,'READY');assert.equal(a.domain,'DUEBYTE_BOUNDED_LEGACY_ARCHIVE_V1');integer(a.count,1);integer(a.first);assert.equal(a.last,b.sourceHeight);assert.equal(a.count,a.last-a.first+1);assert.equal(a.appHash,trustedSourceRoot);hex(a.digest);
 assert.equal(a.first,0,'transition requires history from genesis');
 validatorQuorum(b,certificate.approvals,source.authority.validators);return b;
}
export function verifyBoundedViewAnchor(anchor,terms){
 if(terms.kind==='indexed-schema-upgrade'){
  assert.equal(anchor.domain,terms.targetSchema);assert.equal(anchor.configHash,terms.configHash);assert.equal(anchor.height,0);assert.equal(anchor.sourceStateHash,terms.genesisStateHash);assert.equal(anchor.issuance,false);assert.equal(anchor.retainsTerminalHistory,true);assert.equal(anchor.archive,null);return;
 }
 assert.equal(anchor.domain,terms.targetSchema);assert.equal(anchor.configHash,terms.configHash);assert.equal(anchor.height,terms.sourceHeight);assert.equal(anchor.sourceStateHash,terms.sourceRoot);assert.equal(anchor.issuance,false);assert.equal(anchor.retainsTerminalHistory,true);assert.deepEqual(anchor.archive,terms.archive);
}
// A fresh trusted checkpoint can authenticate the immutable migration anchor
// through its indexed root. Never relax expiry on a historical source document.
export function indexedTrustAnchor(doc,terms,candidates,policy,config){
 verifyCheckpoint(doc,policy,{configHash:hash(config)});
 if(doc.body.appHeight>=terms.activationHeight)return null;
 const source=candidates.find(cp=>cp?.body.appHeight===terms.sourceHeight&&cp.body.appHash===terms.sourceRoot);
 assert(source,'authenticated source checkpoint required for first indexed view');verifyCheckpoint(source,policy,{configHash:hash(config)});assert.equal(source.body.snapshotHash,terms.sourceRoot);return source;
}
