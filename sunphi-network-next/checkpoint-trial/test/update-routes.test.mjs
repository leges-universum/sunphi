import test from 'node:test';
import assert from 'node:assert/strict';
import {selectUpdateRoute,automaticEligible,automaticRouteEligible} from '../update-core.mjs';

const release={version:'0.3.59',edition:'home',platform:'windows-x64',networkPin:'a'.repeat(64)};
function offer(version,from,overrides={}){return {schema:1,edition:'home',platform:'windows-x64',networkPin:release.networkPin,channel:'stable',version,sequence:67,summary:'Qualified transition',required:false,deadline:null,activationHeight:null,dataFormat:1,protocolChange:false,dataMigration:false,autoFrom:from,rolloutPercent:100,notBefore:'2026-01-01T00:00:00Z',manifestSha256:'b'.repeat(64),folder:`DueByte-Home-${version}-Windows-x64`,artifact:`DueByte-Home-${version}-Windows-x64.zip`,artifactBaseUrl:`https://github.com/leges-universum/sunphi/releases/download/duebyte-v${version}/`,...overrides};}
const catalog=(head,bridges)=>({schema:1,version:head.version,sequence:head.sequence,bridges});
test('shortest qualified route prefers direct updates and otherwise uses bridges',()=>{
 const bridge=offer('0.3.63',['0.3.59']),head=offer('0.3.67',['0.3.63']);
 assert.deepEqual(selectUpdateRoute(head,release,catalog(head,[bridge])).map(x=>x.version),['0.3.63','0.3.67']);
 assert.deepEqual(selectUpdateRoute(head,{...release,version:'0.3.63'},catalog(head,[bridge])).map(x=>x.version),['0.3.67']);
 const direct={...head,autoFrom:['0.3.59','0.3.63']};assert.deepEqual(selectUpdateRoute(direct,release,catalog(direct,[bridge])).map(x=>x.version),['0.3.67']);
 assert.equal(selectUpdateRoute(head,release),null);
 assert.deepEqual(selectUpdateRoute(head,{...release,version:'0.3.67'}),[]);
});
test('routes cannot cross migrations, protocols, identities or platform boundaries',()=>{
 const bridge=offer('0.3.63',['0.3.59']),head=offer('0.3.67',['0.3.63']);
 for(const patch of [{protocolChange:true},{dataMigration:true},{autoFrom:[]}])assert.equal(selectUpdateRoute(head,release,catalog(head,[{...bridge,...patch}])),null);
 for(const patch of [{networkPin:'c'.repeat(64)},{platform:'linux-x64'},{edition:'server'},{dataFormat:2},{routes:{}}])assert.throws(()=>selectUpdateRoute(head,release,catalog(head,[{...bridge,...patch}])));
 assert.throws(()=>selectUpdateRoute(head,release,{...catalog(head,[bridge]),sequence:66}));
 assert.throws(()=>selectUpdateRoute(head,release,catalog(head,[bridge,bridge])));
 assert.throws(()=>selectUpdateRoute(head,release,catalog(head,Array(257).fill(bridge))));
});
test('rollout and release windows apply to the selected bridge without unsafe skipping',()=>{
 const bridge=offer('0.3.63',['0.3.59'],{rolloutPercent:0}),head=offer('0.3.67',['0.3.63']);
 const route=selectUpdateRoute(head,release,catalog(head,[bridge]));assert.equal(route[0],bridge);assert(!automaticEligible(route[0],release,'test'));
 assert(!automaticEligible({...bridge,rolloutPercent:100,notBefore:'2099-01-01'},release,'test'));
 assert(!automaticEligible({...head,autoFrom:['0.3.59']},{...release,edition:'server'},'test'));
});
test('back edges, disconnected versions and overlong paths do not authorize updates',()=>{
 const head=offer('0.3.100',['0.3.99']);
 const bridges=Array.from({length:40},(_,i)=>offer('0.3.'+(60+i),['0.3.'+(59+i)]));
 assert.equal(selectUpdateRoute(head,release,catalog(head,bridges)),null);
 const cycle=offer('0.3.63',['0.3.65']),later=offer('0.3.65',['0.3.63']);
 assert.equal(selectUpdateRoute(offer('0.3.67',['0.3.65']),release,catalog(offer('0.3.67',['0.3.65']),[cycle,later])),null);
});

test('a bridge cannot bypass a held or revoked final release',()=>{
 const bridge=offer('0.3.63',['0.3.59']),head=offer('0.3.67',['0.3.63']);
 const checked={descriptor:bridge,channelDescriptor:head,routeAvailable:true};
 assert(automaticRouteEligible(checked,release,'installation'));
 for(const patch of [{rolloutPercent:0},{notBefore:'2099-01-01'},{protocolChange:true},{dataMigration:true}]){
  assert(!automaticRouteEligible({...checked,channelDescriptor:{...head,...patch}},release,'installation'));
 }
 assert(!automaticRouteEligible({...checked,routeAvailable:false},release,'installation'));
});
