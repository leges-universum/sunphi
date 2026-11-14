// Qualified release preparation. Writes a signed candidate; never publishes it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Metadata,Targets,TargetFile,Snapshot,Timestamp,MetaFile} from '@tufjs/models';
import {sha256,readJSON,writeJSON,versionCompare} from '../update-core.mjs';
import {verifyProfileCatalog} from './profile-catalog-plan.mjs';
import {prepareUpdateChannel,SUPPORTED_UPDATE_BASELINE} from './prepare-update-channel.mjs';
import {collectPublishedUpdates} from './published-update-inventory.mjs';
import {signStoredCatalogMetadata} from './update-signing.mjs';

export async function qualifiedUpdateFeed({catalog,pinnedRootSha256,previousChannels,channels,published,artifacts,signer}){
 const prior=verifyProfileCatalog({catalog,pinnedRootSha256}),json=prior.targets.signed.toJSON();
 assert(Array.isArray(channels)&&channels.length===3,'All three package channels must be reviewed together');
 json.version++;assert(Number.isSafeInteger(json.version));const targets=Targets.fromJSON(json),files={},reports=[],seen=new Set();
 for(const channel of channels){
  const name=channel.head.edition+'-'+channel.head.platform+'.json';
  assert(['home-windows-x64.json','home-linux-x64.json','server-linux-x64.json'].includes(name)&&!seen.has(name));seen.add(name);
  const bytes=previousChannels[name],binding=prior.targets.signed.targets[name];assert(binding&&Buffer.isBuffer(bytes));await binding.verify([bytes]);
  const previous=JSON.parse(bytes);assert.equal(previous.networkPin,channel.head.networkPin,'Different network needs explicit migration');
  const candidate=channel.inventory.releases.find(r=>r.version===channel.head.version&&r.edition===channel.head.edition&&r.platform===channel.head.platform);
  assert.equal(candidate?.rootSha256,pinnedRootSha256,'Candidate changes release trust');
  const prepared=prepareUpdateChannel({...channel,previous,published,artifacts});reports.push(prepared.report);
  for(const [target,b]of Object.entries(prepared.targets)){
   if(files[target])assert.equal(sha256(files[target]),sha256(b),'Conflicting target');
   files[target]=b;targets.addTarget(new TargetFile({path:target,length:b.length,hashes:{sha256:sha256(b)}}));
  }
 }
 // In particular, retain the authenticated network transition profile.
 for(const [name,value]of Object.entries(prior.targets.signed.targets))if(!files[name])assert.deepEqual(targets.targets[name].toJSON(),value.toJSON());
 const sign=(value,role)=>{const body=structuredClone(value.toJSON()),b=signer(value,role),m=Metadata.fromJSON(role,JSON.parse(b));assert.deepEqual(m.signed.toJSON(),body);prior.root.verifyDelegate(role,m);return b;};
 const t=sign(targets,'targets'),sj=prior.snapshot.signed.toJSON();sj.version++;assert(Number.isSafeInteger(sj.version));sj.meta['targets.json']=new MetaFile({version:targets.version,length:t.length,hashes:{sha256:sha256(t)}}).toJSON();
 const s=sign(Snapshot.fromJSON(sj),'snapshot'),tj=prior.timestamp.signed.toJSON();tj.version++;assert(Number.isSafeInteger(tj.version));tj.meta['snapshot.json']=new MetaFile({version:sj.version,length:s.length,hashes:{sha256:sha256(s)}}).toJSON();
 const next={root:catalog.root,targets:t,snapshot:s,timestamp:sign(Timestamp.fromJSON(tj),'timestamp')};
 verifyProfileCatalog({catalog:next,pinnedRootSha256});return {catalog:next,files,reports,published:false,issuance:false};
}

if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)){
 const [input,out]=process.argv.slice(2);assert(input&&out&&!fs.existsSync(out),'Use a fresh output directory');
 const spec=readJSON(input),published=await collectPublishedUpdates();
 // Every supported archive needs classification; pre-baseline packages are
 // outside the mandatory coverage policy, not silently declared compatible.
 const legacy=published.unclassified.filter(p=>versionCompare(p.version,SUPPORTED_UPDATE_BASELINE)>=0).map(p=>{const row=spec.legacyPackages?.find(r=>r.url===p.url);assert(row,'Unclassified published archive: '+p.name);assert.equal(row.archiveSha256,p.archiveSha256);return {...p,edition:row.edition,platform:row.platform};});
 const base='https://api.github.com/repos/leges-universum/sunphi/git/ref/heads/duebyte-updates-stable';
 const get=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(30000)});assert(r.ok,'Public catalog HTTP '+r.status);return Buffer.from(await r.arrayBuffer());};
 const commit=JSON.parse(await get(base)).object.sha;assert(/^[a-f0-9]{40}$/.test(commit));
 const origin=`https://raw.githubusercontent.com/leges-universum/sunphi/${commit}/`,catalog={},previousChannels={};
 for(const role of ['root','targets','snapshot','timestamp'])catalog[role]=await get(origin+'metadata/'+role+'.json');
 const pin=sha256(fs.readFileSync(spec.rootFile));verifyProfileCatalog({catalog,pinnedRootSha256:pin});
 for(const c of spec.channels){const name=c.head.edition+'-'+c.head.platform+'.json';previousChannels[name]=await get(origin+'targets/'+name);}
 const artifacts=Object.fromEntries(Object.entries(spec.artifactPaths).map(([name,file])=>[name,fs.readFileSync(file)]));
 const result=await qualifiedUpdateFeed({catalog,pinnedRootSha256:pin,previousChannels,channels:spec.channels,published:[...published.packages,...legacy],artifacts,signer:signStoredCatalogMetadata});
 assert.equal(JSON.parse(await get(base)).object.sha,commit,'Catalog changed while preparing; rerun against current state');
 for(const [role,b]of Object.entries(result.catalog)){const file=path.join(out,'metadata',role+'.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,b,{flag:'wx'});}
 // Archives stay in their immutable release location; only small targets need upload.
 for(const [name,b]of Object.entries(result.files))if(name.endsWith('.json')){assert(!name.includes('/')&&!name.includes('\\'));const file=path.join(out,'targets',name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,b,{flag:'wx'});}
 writeJSON(path.join(out,'review.json'),{baseCommit:commit,publishedInventory:published,coverage:result.reports,published:false,issuance:false});
 console.log('Qualified signed candidate prepared. Publication must compare baseCommit; nothing published.');
}
