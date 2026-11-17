import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareUpdateChannel} from '../qa/prepare-update-channel.mjs';
import {sha256} from '../update-core.mjs';

function fixture(){
 const bytes=Buffer.from('exact isolated package'),pin='a'.repeat(64),root='b'.repeat(64),manifest='c'.repeat(64);
 const row=version=>({version,edition:'home',platform:'linux-x64',updater:'routes',networkPin:pin,rootSha256:root,manifestSha256:manifest,archiveSha256:sha256(bytes)});
 const source=row('0.3.66'),target=row('0.3.67'),folder='DueByte-Home-0.3.67-Linux-x64';
 const head={schema:1,...target,channel:'stable',sequence:1,summary:'Qualified update',required:false,deadline:null,activationHeight:null,dataFormat:1,protocolChange:false,dataMigration:false,autoFrom:[],rolloutPercent:100,notBefore:'2026-01-01',folder,artifact:folder+'.tar.gz',artifactBaseUrl:'https://github.com/leges-universum/sunphi/releases/download/duebyte-v0.3.67/'};
 const proof={passed:true,authority:'isolated',liveConnection:false,productionChanged:false,issuance:false,edition:head.edition,platform:head.platform,predecessor:source.version,version:head.version,networkPin:pin,rootSha256:root,predecessorManifestSha256:manifest,targetManifestSha256:manifest,archiveSha256:sha256(bytes)};
 return {inventory:{schema:1,releases:[source,target]},head,proofs:[proof],published:[source],previous:{...source,sequence:3000069},artifacts:{[head.artifact]:bytes}};
}
test('new channel advances actual repaired sequence and binds exact archives',()=>{
 const x=fixture(),r=prepareUpdateChannel(x);assert.equal(r.report.head.sequence,3000070);
 assert.deepEqual(r.report.head.autoFrom,['0.3.66']);assert(r.targets['home-linux-x64.json']);
 assert.equal(x.head.sequence,1);
});

test('publication rejects a future published release and duplicate release rows',()=>{
 const future=fixture(),row={...future.inventory.releases[1],version:'0.3.68'};
 future.inventory.releases.push(row);future.published.push(row);
 assert.throws(()=>prepareUpdateChannel(future),/newer than/);
 const duplicate=fixture();duplicate.published.push({...duplicate.published[0]});
 assert.throws(()=>prepareUpdateChannel(duplicate),/Duplicate published/);
});
test('publication gate rejects omitted history, untested edges and replaced bytes',()=>{
 for(const change of [x=>x.inventory.releases=x.inventory.releases.slice(1),x=>x.proofs=[],x=>x.artifacts[x.head.artifact]=Buffer.from('changed'),x=>x.published[0]={...x.published[0],archiveSha256:'d'.repeat(64)},x=>x.previous.sequence=Number.MAX_SAFE_INTEGER,x=>x.previous.version=x.head.version]){
  const x=fixture();change(x);assert.throws(()=>prepareUpdateChannel(x));
 }
});

test('mandatory coverage starts at 66 without claiming legacy qualification',()=>{
 const x=fixture();x.published.push({...x.published[0],version:'0.3.59'});
 const r=prepareUpdateChannel(x);
 assert.equal(r.report.supportedFrom,'0.3.66');
 assert.deepEqual(r.report.head.autoFrom,['0.3.66']);
 assert(!r.report.coverage.some(v=>v.version==='0.3.59'));
});

test('supported releases cannot bypass qualification with manual-install classifications',()=>{
 for(const updater of ['none','broken-extractor']){
  const x=fixture();x.inventory.releases[0].updater=updater;x.proofs=[];
  assert.throws(()=>prepareUpdateChannel(x),/executable update path/);
 }
 const x=fixture();x.proofs=[];
 for(const row of [...x.inventory.releases,...x.published,x.head,x.previous])row.edition='server';
 x.head.folder='DueByte-Server-0.3.67-Linux-x64';x.head.artifact=x.head.folder+'.tar.gz';
 x.artifacts={[x.head.artifact]:Buffer.from('exact isolated package')};
 assert.throws(()=>prepareUpdateChannel(x),/exact-package qualification/);
});
