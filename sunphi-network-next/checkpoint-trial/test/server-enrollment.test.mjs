import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {serverInstallationPlan,installServerNode} from '../server-enrollment.mjs';
import {ServerManagement} from '../server-management.mjs';
import {serveManagement} from '../node-management.mjs';
import {writeJSON,readJSON,sha256} from '../update-core.mjs';
import {hash} from '../crypto.mjs';
function fixture(){
 const base=fs.mkdtempSync(join(tmpdir(),'server-setup-')),root=join(base,'package'),state=join(base,'state'),registry=join(base,'etc/instances.json'),systemDirectory=join(base,'system');fs.mkdirSync(root);fs.mkdirSync(systemDirectory);
 const profile={config:{chainId:'isolated-setup-fixture'}},pin=hash(profile);writeJSON(join(root,'connection-profile.json'),profile);writeJSON(join(root,'connection-pin.json'),{sha256:pin});fs.writeFileSync(join(root,'update-root.json'),'{}');
 writeJSON(join(root,'release-config.json'),{schema:1,edition:'server',platform:'linux-x64',version:'0.3.72',networkPin:pin,rootSha256:sha256('{}'),metadataUrl:'https://duebyte.com/updates/metadata/',targetsUrl:'https://duebyte.com/updates/targets/'});
 return {root,state,registry,systemDirectory,prefix:'/opt/duebyte-setup-fixture'};
}
const linux={skip:process.platform!=='linux'};
test('Server setup: reviewed paths and identity cannot be supplied by the browser',linux,()=>{
 const f=fixture(),p=serverInstallationPlan(f);assert.equal(p.network,'isolated-setup-fixture');assert.match(p.service,/KillMode=control-group/);assert.equal(p.argv[3],join(f.state,'archive-node'));
 assert.throws(()=>serverInstallationPlan({...f,prefix:'/opt/x\nExecStart=malicious'}));
 writeJSON(join(f.root,'connection-pin.json'),{sha256:'0'.repeat(64)});assert.throws(()=>serverInstallationPlan(f));
});
test('Server setup: interrupted enable resumes registered service without replacing retained files', {skip:process.platform!=='linux'||process.getuid()!==0},()=>{
 const f=fixture();let fail=true,calls=[];const run=(...a)=>{calls.push(a);if(a[0]==='show')return fail?'inactive':'failed';if(fail&&a[0]==='enable')throw Error('interrupted enable');};
 assert.throws(()=>installServerNode({...f,run}),/interrupted enable/);const registry=readJSON(f.registry),service=fs.readFileSync(join(f.systemDirectory,registry.instances[0].unit));
 assert(!calls.some(a=>a[0]==='reset-failed'),'fresh units have no failure to reset');
 fs.mkdirSync(join(f.state,'archive-node'),{recursive:true});const retained=join(f.state,'archive-node/retained-key');fs.writeFileSync(retained,'isolated identity');fail=false;
 assert.equal(installServerNode({...f,run}).status,'started');assert.deepEqual(readJSON(f.registry),registry);assert.deepEqual(fs.readFileSync(join(f.systemDirectory,registry.instances[0].unit)),service);assert.equal(fs.readFileSync(retained,'utf8'),'isolated identity');
 assert(calls.some(a=>a[0]==='reset-failed'&&a[1]===registry.instances[0].unit));
 fs.appendFileSync(join(f.systemDirectory,registry.instances[0].unit),'# unexpected change');assert.throws(()=>installServerNode({...f,run}),/Existing service retained/);
});
test('Server setup: HTTP review needs authentication and one-use confirmation; no command input',linux,async()=>{
 const f=fixture(),adapter=new ServerManagement({...f,run:async()=>JSON.stringify({updates:null})}),started=[];adapter.startJob=args=>{started.push(args);return {status:'running'};};
 const panel=await serveManagement({state:join(f.state,'management'),port:0,adapter});
 try{const post=(route,body={},headers={})=>fetch(panel.url.slice(0,-1)+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await post('/setup/review')).status,401);const login=await post('/login',{password:fs.readFileSync(panel.credential.initial,'utf8').trim()}),headers={cookie:login.headers.get('set-cookie').split(';')[0],'X-Duebyte-Csrf':(await login.json()).csrf};
  assert.equal((await post('/setup/review',{path:'/tmp/evil'},headers)).status,400);assert.equal((await post('/setup/apply',{id:'0'.repeat(64)},headers)).status,400);
  const review=await (await post('/setup/review',{},headers)).json();assert.equal(review.network,'isolated-setup-fixture');assert.equal(started.length,0);
  assert.equal((await post('/setup/apply',{id:review.id},headers)).status,200);assert.deepEqual(started,[['initialize']]);assert.equal((await post('/setup/apply',{id:review.id},headers)).status,400);
 }finally{await panel.close();}
});
