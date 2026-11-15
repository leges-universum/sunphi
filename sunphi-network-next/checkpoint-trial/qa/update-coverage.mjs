// Release preparation only. Qualification evidence never grants chain authority.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {readJSON,writeJSON,sha256,versionCompare,validateOffer,selectUpdateRoute} from '../update-core.mjs';

const digest=v=>assert(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),'Missing release fingerprint');
const key=r=>`${r.edition}/${r.platform}/${r.version}`;
export function compileUpdateCoverage({inventory,head,bridges=[],proofs=[]}){
 assert.equal(inventory.schema,1);
 assert(Array.isArray(inventory.releases)&&inventory.releases.length>0&&inventory.releases.length<=2048);
 assert(bridges.length<=256&&proofs.length<=16384);
 const rows=new Map();
 for(const r of inventory.releases){
  versionCompare(r.version,r.version);assert(['home','server'].includes(r.edition));assert(['windows-x64','linux-x64'].includes(r.platform));
  assert(!rows.has(key(r)),'Duplicate inventory release');
  assert(['none','broken-extractor','direct','routes'].includes(r.updater));
  for(const name of ['manifestSha256','archiveSha256'])digest(r[name]);
  if(r.updater!=='none'){digest(r.networkPin);digest(r.rootSha256);}
  rows.set(key(r),r);
 }
 const channel=inventory.releases.filter(r=>r.edition===head.edition&&r.platform===head.platform&&versionCompare(r.version,head.version)<=0);
 const latest=rows.get(key(head));assert(latest,'Candidate missing from release inventory');
 assert.equal(latest.manifestSha256,head.manifestSha256);assert.equal(latest.networkPin,head.networkPin);
 const offers=[head,...bridges].map(d=>{
  validateOffer(d,latest);assert(!d.routes,'Compile routes before signing the channel');
  const r=rows.get(key(d));assert(r,'Bridge missing from release inventory');
  assert.equal(r.networkPin,latest.networkPin);assert.equal(r.rootSha256,latest.rootSha256,'Trust-root transition requires separate qualification');
  assert.equal(r.manifestSha256,d.manifestSha256);return {...d,autoFrom:[]};
 });
 const byVersion=new Map(offers.map(d=>[d.version,d]));assert.equal(byVersion.size,offers.length);
 for(const p of proofs){
  // Reports must come from the exact-package isolated qualification runner.
  assert.equal(p.passed,true);assert.equal(p.authority,'isolated');assert.equal(p.liveConnection,false);assert.equal(p.productionChanged,false);assert.equal(p.issuance,false);
  const destination=byVersion.get(p.version);assert(destination,'Qualification target is not in this channel');
  assert.equal(p.edition,head.edition);assert.equal(p.platform,head.platform);
  const from=rows.get(key({...head,version:p.predecessor})),to=rows.get(key(destination));assert(from&&to,'Qualification source missing');
  assert(versionCompare(from.version,to.version)<0);assert(['direct','routes'].includes(from.updater),'Source cannot install updates');
  assert.equal(from.networkPin,to.networkPin);assert.equal(from.rootSha256,to.rootSha256);
  assert.equal(p.networkPin,to.networkPin);assert.equal(p.rootSha256,to.rootSha256);
  assert.equal(p.predecessorManifestSha256,from.manifestSha256);assert.equal(p.targetManifestSha256,to.manifestSha256);assert.equal(p.archiveSha256,to.archiveSha256);
  if(!destination.autoFrom.includes(from.version))destination.autoFrom.push(from.version);
 }
 // A legacy updater reads only the channel head. Never publish a bridge edge
 // that the installed intermediate updater cannot execute on its next launch.
 for(const d of offers){
  if(d.version!==head.version)d.autoFrom=d.autoFrom.filter(v=>rows.get(key({...head,version:v})).updater==='routes');
  d.autoFrom.sort(versionCompare);
 }
 const compiled=offers[0],catalog={schema:1,version:head.version,sequence:head.sequence,bridges:offers.slice(1)};
 // Validate even when the inventory contains no older installations.
 selectUpdateRoute(compiled,{...latest,version:'0.0.0'},catalog);
 const coverage=channel.sort((a,b)=>versionCompare(a.version,b.version)).map(r=>{
  const base={version:r.version,edition:r.edition,platform:r.platform};
  if(r.version===head.version)return {...base,status:'current',route:[]};
  if(r.edition==='server')return {...base,status:'manual-server',reason:'Server installation remains operator-controlled.'};
  if(r.updater==='none')return {...base,status:'manual-install',reason:'This published version has no automatic updater. Install the signed package without deleting wallet data.'};
  if(r.updater==='broken-extractor')return {...base,status:'manual-install',reason:'The published updater cannot extract its repair. One signed manual installation is required; retain wallet data.'};
  if(r.networkPin!==latest.networkPin||r.rootSha256!==latest.rootSha256)return {...base,status:'manual-review',reason:'Different network or trust identity. Do not substitute the profile or migrate balances automatically.'};
  let route=selectUpdateRoute(compiled,r,catalog);
  if(r.updater==='direct')route=compiled.autoFrom.includes(r.version)&&!compiled.protocolChange&&!compiled.dataMigration?[compiled]:null;
  return route?{...base,status:route.length===1?'direct':'intermediate',route:route.map(d=>d.version)}:{...base,status:'blocked',reason:'No qualified path executable by this published updater.'};
 });
 const routeBytes=Buffer.from(JSON.stringify(catalog));
 const target=`routes-${head.edition}-${head.platform}.json`;
 if(bridges.length)compiled.routes={target,sha256:sha256(routeBytes)};
 return {schema:1,head:compiled,catalog,routeTarget:bridges.length?target:null,coverage,publishable:coverage.every(r=>r.status!=='blocked'),inventorySha256:sha256(JSON.stringify(inventory)),proofsSha256:sha256(JSON.stringify(proofs))};
}

if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)){
 const [input,out]=process.argv.slice(2);assert(input&&out);assert(!fs.existsSync(out),'Use a fresh coverage output directory');
 const report=compileUpdateCoverage(readJSON(input));writeJSON(path.join(out,'coverage.json'),report);
 if(!report.publishable){console.error('Publication blocked: released versions have no qualified update path. See coverage.json.');process.exitCode=1;}
 else{writeJSON(path.join(out,`${report.head.edition}-${report.head.platform}.json`),report.head);if(report.routeTarget)fs.writeFileSync(path.join(out,report.routeTarget),JSON.stringify(report.catalog));console.log('Qualified update coverage prepared; nothing was published.');}
}
