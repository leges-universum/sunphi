import test from 'node:test';
import assert from 'node:assert/strict';
import {authority,rootBytes,feed,signed,automaticPredecessors} from '../qa/update-signing.mjs';
import {qualifiedUpdateFeed} from '../qa/qualified-update-feed.mjs';
import {publishedPackages} from '../qa/published-update-inventory.mjs';
import {verifyProfileCatalog} from '../qa/profile-catalog-plan.mjs';
import {sha256} from '../update-core.mjs';

function fixture(){
 const a=authority(),root=rootBytes(a),pin='a'.repeat(64),rootHash=sha256(root),channels=[],published=[],artifacts={},previousChannels={};
 for(const [edition,platform]of [['home','windows-x64'],['home','linux-x64'],['server','linux-x64']]){
  const bytes=Buffer.from(edition+platform),manifest='b'.repeat(64),row=version=>({version,edition,platform,updater:'routes',networkPin:pin,rootSha256:rootHash,manifestSha256:manifest,archiveSha256:sha256(bytes)}),old=row('0.3.66'),next=row('0.3.67');
  const folder=`DueByte-${edition==='home'?'Home':'Server'}-0.3.67-${platform==='windows-x64'?'Windows':'Linux'}-x64`,head={schema:1,edition,platform,networkPin:pin,channel:'stable',version:next.version,sequence:1,summary:'Reviewed release',required:false,deadline:null,activationHeight:null,dataFormat:1,protocolChange:false,dataMigration:false,autoFrom:[],rolloutPercent:100,notBefore:'2026-01-01',manifestSha256:manifest,folder,artifact:folder+(platform==='windows-x64'?'.zip':'.tar.gz'),artifactBaseUrl:'https://github.com/leges-universum/sunphi/releases/download/duebyte-v0.3.67/'};
  channels.push({head,inventory:{schema:1,releases:[old,next]},proofs:[{passed:true,authority:'isolated',liveConnection:false,productionChanged:false,issuance:false,edition,platform,predecessor:old.version,version:next.version,networkPin:pin,rootSha256:rootHash,predecessorManifestSha256:manifest,targetManifestSha256:manifest,archiveSha256:sha256(bytes)}]});
  published.push(old);artifacts[head.artifact]=bytes;previousChannels[edition+'-'+platform+'.json']=Buffer.from(JSON.stringify({...head,version:old.version,sequence:3000069}));
 }
 const profile=Buffer.from('existing signed network profile'),original=feed(a,{...previousChannels,'home-indexed-profile.json':profile},{version:98});
 return {catalog:{root,targets:original['targets.json'],snapshot:original['snapshot.json'],timestamp:original['timestamp.json']},pinnedRootSha256:rootHash,previousChannels,channels,published,artifacts,signer:(value,role)=>signed(value,role,a)};
}
test('three-channel candidate preserves profile, repairs sequences and does not publish',async()=>{
 const x=fixture(),r=await qualifiedUpdateFeed(x),before=verifyProfileCatalog(x),after=verifyProfileCatalog({catalog:r.catalog,pinnedRootSha256:x.pinnedRootSha256});
 assert.equal(r.published,false);assert.equal(r.issuance,false);assert.equal(r.reports.length,3);
 for(const report of r.reports)assert.equal(report.head.sequence,3000070);
 assert.deepEqual(after.targets.signed.targets['home-indexed-profile.json'].toJSON(),before.targets.signed.targets['home-indexed-profile.json'].toJSON());
 assert.equal(after.timestamp.signed.version,99);
});
test('gate rejects substituted previous channel, root changes and missing package review',async()=>{
 for(const edit of [x=>x.previousChannels['home-linux-x64.json']=Buffer.from('{}'),x=>x.channels[0].inventory.releases[1].rootSha256='c'.repeat(64),x=>x.channels.pop(),x=>x.channels[0].proofs=[]]){
  const x=fixture();edit(x);await assert.rejects(qualifiedUpdateFeed(x));
 }
 assert.throws(()=>automaticPredecessors('0.3.67','windows-x64'),/qualified-update-feed/);
});
test('published inventory retains legacy archives without inventing updater support',()=>{
 const tag='duebyte-v0.3.66',name='DueByte-Home-0.3.66-Windows-x64.zip',asset={name,digest:'sha256:'+'a'.repeat(64),browser_download_url:`https://github.com/leges-universum/sunphi/releases/download/${tag}/${name}`,size:100};
 const r=publishedPackages([{tag_name:tag,draft:false,assets:[asset,{name:'legacy.zip',digest:asset.digest}]},{tag_name:'duebyte-v0.3.67',draft:true,assets:[asset]}]);
 assert.equal(r.packages.length,1);assert.equal(r.unclassified.length,1);assert.equal(r.packages[0].version,'0.3.66');assert.equal(r.packages[0].updater,undefined);
 assert.throws(()=>publishedPackages([{tag_name:tag,assets:[{...asset,digest:null}]}]));
});
