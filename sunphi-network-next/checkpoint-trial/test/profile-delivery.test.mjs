import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {authority,rootBytes,feed} from '../qa/update-signing.mjs';
import {profileDeliveryFixture} from '../qa/profile-delivery-fixture.mjs';
import {stageTransitionProfile,validateTransitionDelivery} from '../profile-delivery.mjs';
import {homeLaunchProfile,rememberHomeTransition} from '../consumer-launch-profile.mjs';
import {sha256,writeJSON,readJSON} from '../update-core.mjs';import {hash} from '../crypto.mjs';
async function fixture(t){
 const home=fs.mkdtempSync(join(tmpdir(),'duebyte-profile-delivery-')),root=join(home,'app'),state=join(home,'state'),f=profileDeliveryFixture(home),a=authority(),trust=rootBytes(a);fs.mkdirSync(root);
 fs.writeFileSync(join(root,'update-root.json'),trust);writeJSON(join(root,'connection-profile.json'),f.original);writeJSON(join(root,'connection-pin.json'),{sha256:f.body.fromProfileHash});
 const release={schema:1,version:'0.3.42',edition:'home',platform:process.platform==='win32'?'windows-x64':'linux-x64',networkPin:f.body.fromProfileHash,rootSha256:sha256(trust),metadataUrl:'https://duebyte.com/updates/stable/metadata/',targetsUrl:'https://duebyte.com/updates/stable/targets/'};writeJSON(join(root,'release-config.json'),release);
 writeJSON(join(state,'installation.json'),{version:1,network:f.original.config.chainId,profileHash:f.body.fromProfileHash});writeJSON(join(state,'wallet/retained.json'),{balance:'123.000004',history:['preserved'],pending:['retained']});
 let content={},cut=false,cuts=0;
 const server=http.createServer((req,res)=>{if(cut&&req.url==='/targets/home-indexed-profile.json'){cuts++;res.writeHead(200);res.write('{');res.destroy();return;}const b=content[req.url];if(!b){res.writeHead(404);res.end();}else res.end(b);});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>server.close(ok)));const base='http://127.0.0.1:'+server.address().port,urls={metadata:base+'/metadata/',targets:base+'/targets/'};
 function publish({body=f.body,version=1,timestampDays=30,mutate}={}){const bytes=Buffer.from(JSON.stringify(body,null,1)+'\n'),targets={'home-indexed-profile.json':bytes},meta=feed(a,targets,{version,timestampDays});content={'/metadata/1.root.json':trust,...Object.fromEntries(Object.entries(meta).map(([n,b])=>['/metadata/'+n,b])),'/targets/home-indexed-profile.json':bytes};mutate?.(content);return bytes;}
 publish();return {...f,home,root,state,a,release,publish,check:()=>stageTransitionProfile({root,state,urls}),cut:value=>{cut=value;},cuts:()=>cuts};
}
test('threshold-signed profile delivery is exact, repeatable and never activates or changes saved data',async t=>{
 const f=await fixture(t),before=['installation.json','wallet/retained.json'].map(n=>[n,fs.readFileSync(join(f.state,n))]),bytes=f.publish(),r=await f.check();assert.equal(r.status,'STAGED_COORDINATED_TRANSITION_REQUIRED');assert.equal(r.active,false);assert.equal(r.issuance,false);assert.deepEqual(fs.readFileSync(r.file),bytes);assert.deepEqual(await f.check(),r);
 for(const [n,b]of before)assert.deepEqual(fs.readFileSync(join(f.state,n)),b);assert(!fs.existsSync(join(f.state,'wallet/indexed-wallet.json')));assert(!fs.existsSync(join(f.state,'node-indexed-v6')));
});
test('one release signer and altered target bytes cannot deliver a profile',async t=>{
 const f=await fixture(t);f.a.roles.targets.threshold=1;f.publish();await assert.rejects(f.check());
 f.a.roles.targets.threshold=2;f.publish({version:2,mutate:c=>c['/targets/home-indexed-profile.json']=Buffer.from('{}')});await assert.rejects(f.check());assert(!fs.existsSync(join(f.state,'updates/profiles/highest.json')));
});
test('catalog expiry and signed profile expiry are both mandatory',async t=>{
 const f=await fixture(t);f.publish({timestampDays:-1});await assert.rejects(f.check());f.publish({version:2,body:{...f.body,issuedAt:f.body.issuedAt-7200,expiresAt:f.body.issuedAt-1}});await assert.rejects(f.check(),/expired\/future profile/);
});
test('rollback and changed same-sequence profiles fail even under newer valid catalog signatures',async t=>{
 const f=await fixture(t);f.publish({body:{...f.body,sequence:2},version:2});const first=await f.check();f.publish({version:3});await assert.rejects(f.check(),/sequence rollback/);f.publish({version:4,body:{...f.body,sequence:2,expiresAt:f.body.expiresAt+1}});await assert.rejects(f.check(),/same sequence/);assert.equal(readJSON(join(f.state,'updates/profiles/highest.json')).sha256,first.sha256);
});
test('wrong network, incompatible software, changed routing and incomplete validator quorum are rejected',async t=>{
 const f=await fixture(t);
 for(const mutate of [b=>b.fromProfileHash='a'.repeat(64),b=>b.minimumVersion='0.3.99',b=>b.profile.indexed.certificate.approvals.pop(),b=>b.profile.indexed.url='http://example.com',b=>b.profile.basePort=29000]){const b=structuredClone(f.body);mutate(b);b.toProfileHash=hash(b.profile);assert.throws(()=>validateTransitionDelivery(b,f.release,f.original));}
 writeJSON(join(f.root,'release-config.json'),{...f.release,edition:'server',platform:'linux-x64'});await assert.rejects(f.check());
});
test('interrupted download does not advance delivery or touch the wallet; retry completes',async t=>{
 const f=await fixture(t);f.cut(true);await assert.rejects(f.check());assert(f.cuts()>0);assert(!fs.existsSync(join(f.state,'updates/profiles/highest.json')));f.cut(false);assert.equal((await f.check()).sequence,1);assert.equal(readJSON(join(f.state,'wallet/retained.json')).balance,'123.000004');
});
test('delivery lock excludes concurrent writers and recovers after transaction loss',async t=>{
 const f=await fixture(t);await f.check();const db=new DatabaseSync(join(f.state,'updates/profiles/delivery.sqlite'));db.exec('BEGIN IMMEDIATE');try{await assert.rejects(f.check(),/locked/);}finally{db.close();}assert.equal((await f.check()).sequence,1);
});
test('orphan verified blob resumes without a receipt; damaged stored bytes fail closed',async t=>{
 const f=await fixture(t),first=await f.check();fs.unlinkSync(join(f.state,'updates/profiles/highest.json'));assert.equal((await f.check()).sha256,first.sha256);fs.appendFileSync(first.file,' ');await assert.rejects(f.check(),/stored profile damaged/);
});

test('Home launch stays on the old profile until binding commits and never downgrades after commit',async t=>{
 const f=await fixture(t),receipt=await f.check();
 assert.equal(homeLaunchProfile(f.root,f.state).pin,f.body.fromProfileHash);
 assert.throws(()=>rememberHomeTransition(f.root,f.state,{...receipt}),/authenticated/);
 const selected=rememberHomeTransition(f.root,f.state,receipt);
 assert.equal(selected.pin,f.body.toProfileHash);
 assert.equal(homeLaunchProfile(f.root,f.state).pin,f.body.fromProfileHash);
 writeJSON(join(f.state,'installation.json'),{version:1,network:f.original.config.chainId,profileHash:selected.pin});
 assert.deepEqual(homeLaunchProfile(f.root,f.state),selected);
 fs.unlinkSync(join(f.state,'updates/profiles/highest.json'));
 assert.deepEqual(homeLaunchProfile(f.root,f.state),selected);
 fs.appendFileSync(receipt.file,' ');
 assert.throws(()=>homeLaunchProfile(f.root,f.state),/damaged/);
 fs.unlinkSync(receipt.file);
 assert.throws(()=>homeLaunchProfile(f.root,f.state));
 assert.equal(readJSON(join(f.state,'wallet/retained.json')).balance,'123.000004');
});
