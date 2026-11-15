// Read-only inventory. A release number alone never proves updater compatibility.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {writeJSON} from '../update-core.mjs';
export function publishedPackages(releases){
 const packages=[],unclassified=[],seen=new Set();
 for(const r of releases){
  if(r.draft||!/^duebyte-v\d+\.\d+\.\d+$/.test(r.tag_name))continue;
  const version=r.tag_name.slice(9);
  for(const a of r.assets??[]){
   if(!/\.(zip|tar\.gz)$/.test(a.name))continue;
   const m=/^DueByte-(Home|Server)-(\d+\.\d+\.\d+)-(Windows|Linux)-x64\.(zip|tar\.gz)$/.exec(a.name);
   const entry={version,tag:r.tag_name,name:a.name,url:a.browser_download_url,archiveSha256:a.digest?.replace(/^sha256:/,''),size:a.size};
   if(!m){unclassified.push(entry);continue;}
   assert.equal(m[2],version);assert(/^[a-f0-9]{64}$/.test(entry.archiveSha256),'Missing published digest: '+a.name);
   assert.equal(entry.url,`https://github.com/leges-universum/sunphi/releases/download/${r.tag_name}/${a.name}`);
   const row={...entry,edition:m[1].toLowerCase(),platform:m[3].toLowerCase()+'-x64'},key=[version,row.edition,row.platform].join('/');
   assert(!seen.has(key),'Duplicate published package');seen.add(key);packages.push(row);
  }
 }
 return {packages,unclassified};
}
export async function collectPublishedUpdates(){
 const releases=[];
 for(let page=1;page<=20;page++){
  const r=await fetch(`https://api.github.com/repos/leges-universum/sunphi/releases?per_page=100&page=${page}`,{headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(30000)});
  assert(r.ok,'Release inventory HTTP '+r.status);const rows=await r.json();assert(Array.isArray(rows));releases.push(...rows);
  if(rows.length<100)return {schema:1,source:'https://api.github.com/repos/leges-universum/sunphi/releases',checkedAt:new Date().toISOString(),complete:true,...publishedPackages(releases)};
 }
 throw new Error('Release inventory pagination limit; publication must remain blocked');
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)){
 const out=process.argv[2];assert(out&&!fs.existsSync(out),'Use a fresh inventory file');const report=await collectPublishedUpdates();writeJSON(out,report);
 console.log(JSON.stringify({packages:report.packages.length,unclassified:report.unclassified.length,out}));
}
