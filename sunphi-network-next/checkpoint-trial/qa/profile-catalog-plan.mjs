// Release-admin tools. Signing requires an injected signer; no private key storage,
// publishing, activation or ledger mutation is implemented here.
import assert from 'node:assert/strict';
import {Metadata,Targets,TargetFile,Snapshot,Timestamp,MetaFile} from '@tufjs/models';
import {sha256} from '../update-core.mjs';
import {prepareTransitionProfile} from '../transition-profile.mjs';
import {hash} from '../crypto.mjs';
import {validateTransitionDelivery} from '../profile-delivery.mjs';
import {verifyIndexedSchemaReadiness} from '../research/indexed-schema-readiness.mjs';
const targetName='home-indexed-profile.json';
export function verifyProfileCatalog({catalog,pinnedRootSha256,now=Math.floor(Date.now()/1000)}){
 assert(Number.isSafeInteger(now)&&now>0);assert.equal(sha256(catalog.root),pinnedRootSha256,'Untrusted release root');
 const bounds={root:262144,timestamp:32768,snapshot:262144,targets:1048576},parsed={};
 for(const role of Object.keys(bounds)){assert(Buffer.isBuffer(catalog[role])&&catalog[role].length<=bounds[role]);parsed[role]=Metadata.fromJSON(role,JSON.parse(catalog[role]));assert(!parsed[role].signed.isExpired(new Date(now*1000)),'Expired '+role);}
 parsed.root.verifyDelegate('root',parsed.root);
 for(const role of ['timestamp','snapshot','targets'])parsed.root.verifyDelegate(role,parsed[role]);
 const sm=parsed.timestamp.signed.snapshotMeta;assert.equal(sm.version,parsed.snapshot.signed.version,'Snapshot version mismatch');sm.verify(catalog.snapshot);
 const tm=parsed.snapshot.signed.meta['targets.json'];assert(tm,'Missing targets binding');assert.equal(tm.version,parsed.targets.signed.version,'Targets version mismatch');tm.verify(catalog.targets);
 return parsed;
}
export function prepareProfileCatalogPlan({profileArgs,catalog,pinnedRootSha256,previousProfileBytes,now=Math.floor(Date.now()/1000)}){
 return prepareCatalogProfile({profile:prepareTransitionProfile({...profileArgs,now}),catalog,pinnedRootSha256,previousProfileBytes,now});
}
export function prepareSchemaProfileCatalogPlan({original,certificate,trustedBoundary,readiness,sequence,expiresAt,catalog,pinnedRootSha256,previousProfileBytes,now=Math.floor(Date.now()/1000)}){
 assert(original.fresh&&!original.indexed&&!original.schemaUpgrade,'Unchanged fresh predecessor required');
 verifyIndexedSchemaReadiness(readiness,original.config,certificate,trustedBoundary);
 const originalHash=hash(original),next=structuredClone(original);
 next.schemaUpgrade={previousProfileHash:originalHash,previousManifestHash:original.fresh.manifestHash,readPort:original.fresh.readPort,url:original.fresh.url,certificate:structuredClone(certificate),trustedBoundary:structuredClone(trustedBoundary)};
 delete next.fresh;
 const body={domain:'DUEBYTE_HOME_PROFILE_DELIVERY_V1',sequence,fromProfileHash:originalHash,toProfileHash:hash(next),minimumVersion:'0.3.58',issuedAt:now,expiresAt,profile:next};
 validateTransitionDelivery(body,{edition:'home',version:'0.3.59',networkPin:originalHash},original,now);
 const bytes=Buffer.from(JSON.stringify(body,null,2)+'\n');assert(bytes.length<=16*1048576);
 const profile={body,bytes,review:{network:body.profile.config.chainId,sourceHeight:trustedBoundary.height,activationHeight:certificate.body.activationHeight,sourceRoot:trustedBoundary.root,targetRoot:certificate.body.targetRoot,certificateHash:hash(certificate),readinessHash:hash(readiness),predecessor:originalHash,successor:body.toProfileHash,sha256:sha256(bytes),length:bytes.length,profilePublished:false,active:false,issuance:false}};
 return prepareCatalogProfile({profile,catalog,pinnedRootSha256,previousProfileBytes,now});
}
function prepareCatalogProfile({profile,catalog,pinnedRootSha256,previousProfileBytes,now}){
 const current=verifyProfileCatalog({catalog,pinnedRootSha256,now}),old=current.targets.signed.targets[targetName];
 if(old){assert(Buffer.isBuffer(previousProfileBytes),'Existing profile must be checked before replacement');assert.equal(previousProfileBytes.length,old.length);assert.equal(sha256(previousProfileBytes),old.hashes.sha256);const previous=JSON.parse(previousProfileBytes);assert.equal(previous.domain,'DUEBYTE_HOME_PROFILE_DELIVERY_V1');assert.equal(previous.fromProfileHash,profile.body.fromProfileHash,'Different transition predecessor');assert(Number.isSafeInteger(previous.sequence)&&profile.body.sequence>previous.sequence,'Profile sequence must increase');}
 const json=current.targets.signed.toJSON();json.version=current.targets.signed.version+1;assert(Number.isSafeInteger(json.version));
 // The short signing-review deadline must not shorten the release catalog's
 // existing validity. The delivery body retains its own bounded expiry.
 json.expires=new Date(Math.max(Date.parse(json.expires),profile.body.expiresAt*1000)).toISOString();
 const targets=Targets.fromJSON(json);targets.addTarget(new TargetFile({path:targetName,length:profile.bytes.length,hashes:{sha256:sha256(profile.bytes)}}));
 const unsigned=Buffer.from(JSON.stringify({signed:targets.toJSON(),signatures:[]},null,2)+'\n');assert(unsigned.length<=1048576);
 const preserved=Object.keys(current.targets.signed.targets).filter(n=>n!==targetName).sort();for(const name of preserved)assert.deepEqual(targets.targets[name].toJSON(),current.targets.signed.targets[name].toJSON());
 return {profileBytes:profile.bytes,unsignedTargets:unsigned,review:{...profile.review,domain:'DUEBYTE_PROFILE_CATALOG_PLAN_V1',rootSha256:pinnedRootSha256,base:Object.fromEntries(['timestamp','snapshot','targets'].map(role=>[role,{version:current[role].signed.version,sha256:sha256(catalog[role])}])),targetsVersion:targets.version,unsignedTargetsSha256:sha256(unsigned),preservedTargets:preserved,createdAt:now,expiresAt:Math.min(profile.body.expiresAt,now+86400),signed:false,published:false,active:false,issuance:false}};
}
export function assertCatalogPlanFresh(plan,catalog,now=Math.floor(Date.now()/1000)){
 verifyProfileCatalog({catalog,pinnedRootSha256:plan.review.rootSha256,now});assert(now>=plan.review.createdAt&&now<plan.review.expiresAt,'Signing plan expired or clock reversed');
 for(const role of ['timestamp','snapshot','targets'])assert.equal(sha256(catalog[role]),plan.review.base[role].sha256,'Catalog changed; prepare a new signing plan');
 assert.equal(sha256(plan.profileBytes),plan.review.sha256);assert.equal(plan.profileBytes.length,plan.review.length);assert.equal(sha256(plan.unsignedTargets),plan.review.unsignedTargetsSha256);
 return true;
}
export function signProfileCatalogPlan(plan,catalog,signer,now=Math.floor(Date.now()/1000)){
 assertCatalogPlanFresh(plan,catalog,now);assert.equal(typeof signer,'function');
 const original=verifyProfileCatalog({catalog,pinnedRootSha256:plan.review.rootSha256,now}),unsigned=JSON.parse(plan.unsignedTargets);assert.deepEqual(unsigned.signatures,[]);
 const expiresFor=role=>new Date(Math.max(Date.parse(original[role].signed.toJSON().expires),Date.parse(unsigned.signed.expires))).toISOString();
 function signChecked(value,role){const expected=structuredClone(value.toJSON()),bytes=signer(value,role);assert(Buffer.isBuffer(bytes));const signed=Metadata.fromJSON(role,JSON.parse(bytes));assert.deepEqual(signed.signed.toJSON(),expected,'Signer changed metadata');original.root.verifyDelegate(role,signed);return bytes;}
 const targets=signChecked(Targets.fromJSON(unsigned.signed),'targets');
 const sj=original.snapshot.signed.toJSON();sj.version++;assert(Number.isSafeInteger(sj.version));sj.expires=expiresFor('snapshot');sj.meta['targets.json']=new MetaFile({version:unsigned.signed.version,length:targets.length,hashes:{sha256:sha256(targets)}}).toJSON();
 const snapshot=signChecked(Snapshot.fromJSON(sj),'snapshot');
 const tj=original.timestamp.signed.toJSON();tj.version++;assert(Number.isSafeInteger(tj.version));tj.expires=expiresFor('timestamp');tj.meta['snapshot.json']=new MetaFile({version:sj.version,length:snapshot.length,hashes:{sha256:sha256(snapshot)}}).toJSON();
 const timestamp=signChecked(Timestamp.fromJSON(tj),'timestamp'),result={root:catalog.root,targets,snapshot,timestamp};verifyProfileCatalog({catalog:result,pinnedRootSha256:plan.review.rootSha256,now});
 return {catalog:result,profileBytes:plan.profileBytes,published:false,active:false,issuance:false};
}
