// Pure release gate. Inputs must include an independently collected release list.
import assert from 'node:assert/strict';
import {compileUpdateCoverage} from './update-coverage.mjs';
import {sha256,versionCompare} from '../update-core.mjs';

export const SUPPORTED_UPDATE_BASELINE='0.3.66';

export function prepareUpdateChannel({inventory,head,bridges=[],proofs=[],published,previous,artifacts}){
 assert(Array.isArray(published)&&published.length>0,'Published release inventory is required');
 assert(previous&&Number.isSafeInteger(previous.sequence),'Verified previous channel is required');
 assert.equal(previous.edition,head.edition);assert.equal(previous.platform,head.platform);
 assert(versionCompare(head.version,previous.version)>0,'A new release must advance the channel version');
 const relevant=published.filter(r=>r.edition===head.edition&&r.platform===head.platform&&versionCompare(r.version,SUPPORTED_UPDATE_BASELINE)>=0);
 assert(relevant.length>0,'Published channel inventory is empty');
 const publishedVersions=new Set();
 for(const p of relevant){
  assert(versionCompare(p.version,head.version)<=0,'Published release is newer than the proposed channel');
  assert(!publishedVersions.has(p.version),'Duplicate published release');publishedVersions.add(p.version);
  const row=inventory.releases.find(r=>r.version===p.version&&r.edition===p.edition&&r.platform===p.platform);
  assert(row,'Published release omitted from coverage: '+p.version);
  assert.equal(row.archiveSha256,p.archiveSha256,'Published archive fingerprint mismatch');
 }
 assert(Number.isSafeInteger(previous.sequence+1));
 const report=compileUpdateCoverage({inventory,head:{...head,sequence:previous.sequence+1},bridges,proofs});
 report.supportedFrom=SUPPORTED_UPDATE_BASELINE;
 assert(report.publishable,'Publication blocked: released versions have no qualified update path');
 for(const p of relevant){
  const coverage=report.coverage.find(r=>r.version===p.version);
  assert(coverage,'Supported release has no coverage result');
  if(p.version===head.version)continue;
  if(head.edition==='server'){
   assert(report.head.autoFrom.includes(p.version),'Server update requires an exact-package qualification');
  }else{
   assert(['direct','intermediate'].includes(coverage.status),'Supported Home release requires an executable update path');
  }
 }
 const targets={};
 for(const d of [report.head,...report.catalog.bridges]){
  const row=inventory.releases.find(r=>r.version===d.version&&r.edition===d.edition&&r.platform===d.platform);
  const bytes=artifacts[d.artifact];assert(Buffer.isBuffer(bytes),'Missing signed-route archive');
  assert.equal(sha256(bytes),row.archiveSha256,'Route archive fingerprint mismatch');targets[d.artifact]=bytes;
 }
 targets[`${head.edition}-${head.platform}.json`]=Buffer.from(JSON.stringify(report.head));
 if(report.routeTarget)targets[report.routeTarget]=Buffer.from(JSON.stringify(report.catalog));
 return {report,targets};
}
