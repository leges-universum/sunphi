import test from 'node:test';
import assert from 'node:assert/strict';
import {compileUpdateCoverage} from '../qa/update-coverage.mjs';

const hash='a'.repeat(64),manifest='b'.repeat(64),archive='c'.repeat(64),trust='d'.repeat(64);
function row(version,updater='routes',extra={}){return {version,updater,edition:'home',platform:'windows-x64',networkPin:hash,rootSha256:trust,manifestSha256:manifest,archiveSha256:archive,...extra};}
function offer(version){const folder=`DueByte-Home-${version}-Windows-x64`;return {schema:1,edition:'home',platform:'windows-x64',networkPin:hash,channel:'stable',version,sequence:100,summary:'Qualified update',required:false,deadline:null,activationHeight:null,dataFormat:1,protocolChange:false,dataMigration:false,autoFrom:[],rolloutPercent:100,notBefore:'2026-01-01T00:00:00Z',manifestSha256:manifest,folder,artifact:folder+'.zip',artifactBaseUrl:`https://github.com/leges-universum/sunphi/releases/download/duebyte-v${version}/`};}
function proof(predecessor,version){return {passed:true,authority:'isolated',liveConnection:false,productionChanged:false,issuance:false,edition:'home',platform:'windows-x64',predecessor,version,networkPin:hash,rootSha256:trust,predecessorManifestSha256:manifest,targetManifestSha256:manifest,archiveSha256:archive};}
function input(){return {inventory:{schema:1,releases:[row('0.3.59'),row('0.3.66'),row('0.3.67')]},head:offer('0.3.67'),bridges:[offer('0.3.66')],proofs:[proof('0.3.59','0.3.66'),proof('0.3.66','0.3.67')]};}

test('coverage compiles qualified direct and intermediate paths without invented versions',()=>{
 const x=input(),r=compileUpdateCoverage(x);assert(r.publishable);
 assert.deepEqual(r.coverage.map(c=>c.status),['intermediate','direct','current']);
 assert.deepEqual(r.coverage[0].route,['0.3.66','0.3.67']);assert.deepEqual(r.head.autoFrom,['0.3.66']);
 assert.equal(r.routeTarget,'routes-home-windows-x64.json');assert(r.head.routes.sha256);
 assert.deepEqual(x.head.autoFrom,[],'Input evidence must remain unchanged');
 x.proofs.push(proof('0.3.59','0.3.67'));assert.equal(compileUpdateCoverage(x).coverage[0].status,'direct');
});
test('an unqualified released version blocks publication',()=>{
 const x=input();x.inventory.releases.push(row('0.3.60'));const r=compileUpdateCoverage(x);
 assert(!r.publishable);assert.equal(r.coverage.find(c=>c.version==='0.3.60').status,'blocked');
});
test('legacy direct-only updater cannot be assigned a route it cannot execute',()=>{
 const x=input();x.inventory.releases[0].updater='direct';assert(!compileUpdateCoverage(x).publishable);
 x.proofs.push(proof('0.3.59','0.3.67'));assert(compileUpdateCoverage(x).publishable);
});
test('bridge executability is checked at every hop',()=>{
 const x=input();x.inventory.releases.splice(1,0,row('0.3.63','direct'));x.bridges.push(offer('0.3.63'));
 x.proofs=[proof('0.3.59','0.3.63'),proof('0.3.63','0.3.66'),proof('0.3.66','0.3.67')];
 assert(!compileUpdateCoverage(x).publishable);
 x.proofs.push(proof('0.3.63','0.3.67'));assert(compileUpdateCoverage(x).publishable);
});
test('one-time manual repair and identity boundaries remain explicit',()=>{
 const x=input();x.inventory.releases.push(row('0.3.1','none'),row('0.3.20','broken-extractor'),row('0.3.50','direct',{networkPin:'e'.repeat(64)}));
 const r=compileUpdateCoverage(x);assert(r.publishable);assert.deepEqual(r.coverage.slice(0,3).map(c=>c.status),['manual-install','manual-install','manual-review']);
});
test('proofs must bind exact source, destination, archive and isolated execution',()=>{
 for(const [key,value] of Object.entries({passed:false,authority:'live',liveConnection:true,productionChanged:true,issuance:true,predecessor:'0.3.58',version:'0.3.68',platform:'linux-x64',networkPin:'e'.repeat(64),rootSha256:'e'.repeat(64),predecessorManifestSha256:'e'.repeat(64),targetManifestSha256:'e'.repeat(64),archiveSha256:'e'.repeat(64)})){
  const x=input();x.proofs[0]={...x.proofs[0],[key]:value};assert.throws(()=>compileUpdateCoverage(x),key);
 }
 const x=input();delete x.proofs[0].targetManifestSha256;assert.throws(()=>compileUpdateCoverage(x));
});
