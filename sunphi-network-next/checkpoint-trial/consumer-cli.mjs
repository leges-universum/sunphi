import {randomBytes} from 'node:crypto';
import {serveManagement} from './node-management.mjs';
import {consumerDashboard} from './consumer-view.mjs';
// Linux consumer entry point: one owned runner, pinned profile, persistent keys.
import {fork} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import assert from 'node:assert/strict';
import {consumerRuntime} from './runtime-compatibility.mjs';
import {consumerNodeHome} from './consumer-home.mjs';
import {HomeUpdates,forwardHome,reportHomeBoot} from './home-updates.mjs';
import {homeRuntimeHealthy} from './home-boot-health.mjs';
import {setAutomaticUpdates} from './update-core.mjs';
const here=import.meta.dirname,root=resolve(here,'../..');
const pin=JSON.parse(readFileSync(join(root,'connection-pin.json'))).sha256,p=(await consumerRuntime(root,JSON.parse(readFileSync(join(root,'connection-profile.json'))),pin)).profile;
const state=join(process.env.XDG_STATE_HOME||join(homedir(),'.local/state'),'duebyte',p.config.chainId);mkdirSync(state,{recursive:true,mode:0o700});
for(const arg of process.argv.slice(2))if(arg.startsWith('--automatic-updates=')){const v=arg.split('=')[1];assert(['on','off'].includes(v));setAutomaticUpdates(state,v==='on');}
if(process.argv.includes('--stop')){const node=consumerNodeHome(state);if(existsSync(join(node,'run-settings.json')))writeFileSync(join(node,'stop.request'),'stop');console.log('Stop requested. Wallet and signing state retained.');process.exit(0);}
if(forwardHome(root,state,{connect:true}))process.exit(0);
const lock=join(state,'consumer.pid');if(existsSync(lock)){const pid=Number(readFileSync(lock));let alive=true;try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}assert(!alive,'DueByte is already running; use the existing process');unlinkSync(lock);}writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});
let runner=null,stopping=false,last='',snapshot={progress:'stopped',network:p.config.chainId},done=Promise.resolve(),requests=new Map(),panel=null,closing=false;
function startNode(){assert(!runner,'Node already running');stopping=false;snapshot={progress:'connecting',network:p.config.chainId};runner=fork(join(here,'consumer-runner.mjs'),[join(root,'connection-profile.json'),pin,state],{stdio:['ignore','inherit','inherit','ipc']});const child=runner;let stopped;done=new Promise(r=>stopped=r);
 child.on('message',m=>{if(m?.updateRequest)requests.get(m.updateRequest)?.(m.ready===true);if(homeRuntimeHealthy(m,p.config.chainId))reportHomeBoot(root,state);if(m?.progress){snapshot={...snapshot,...m};if(m.progress!==last){last=m.progress;console.log('DueByte: '+last);}}});
 child.on('error',()=>{snapshot={progress:'failed',network:p.config.chainId};});child.on('close',code=>{if(runner===child)runner=null;snapshot={progress:stopping?'stopped':'failed',network:p.config.chainId};stopped();});
}
async function stopNode(){if(runner){stopping=true;if(runner.connected)runner.send({command:'stop'});await done;}}
function prepare(){if(!runner)return Promise.resolve(true);return new Promise(resolve=>{const request=String(Date.now()),finish=ready=>{clearTimeout(timer);requests.delete(request);resolve(ready);},timer=setTimeout(()=>finish(false),5000);requests.set(request,finish);if(runner.connected)runner.send({command:'prepare-update',request});else finish(false);});}
const updates=new HomeUpdates({root,state,connected:()=>!!runner&&!stopping,prepare,stop:stopNode,quit:async()=>{await shutdown();process.exit(0);}});
for(const arg of process.argv.slice(2))if(arg.startsWith('--automatic-updates='))updates.setAutomatic(arg.split('=')[1]==='on');
const reviews=new Map(),adapter={status:async()=>{const v=consumerDashboard(snapshot);return {edition:'Home',version:updates.release.version,updates:updates.snapshot(),requests:[],walletUrl:snapshot.walletReady?'http://127.0.0.1:'+p.walletPort+'/':null,nodes:[{id:'home',name:'Your home node',status:v.title,detail:v.message,actions:runner?[{id:'disconnect',label:'Disconnect'}]:[{id:'connect',label:'Connect'}]}]};},action:async(route,q)=>{
 if(route==='/updates/check'){assert.deepEqual(q,{});void updates.check();return {checking:true};}
 if(route==='/updates/review'){assert.deepEqual(q,{});assert(updates.checked&&!updates.busy&&!updates.ending);reviews.clear();const id=randomBytes(32).toString('hex');reviews.set(id,{action:'update',digest:updates.checked.descriptorSha256,expires:Date.now()+120000});return {id,version:updates.checked.descriptor.version,message:'Install this signed release and restart with your saved data. Lock the wallet first.'};}
 if(route==='/updates/install'){assert.deepEqual(Object.keys(q),['id']);const r=reviews.get(q.id);reviews.delete(q.id);assert(r?.action==='update'&&r.expires>Date.now()&&updates.checked?.descriptorSha256===r.digest);void updates.install({manual:true});return {installing:true};}
 if(route==='/updates/automatic'){assert.deepEqual(Object.keys(q),['enabled']);assert.equal(typeof q.enabled,'boolean');return updates.setAutomatic(q.enabled);}
 if(route==='/node/review'){assert.deepEqual(Object.keys(q).sort(),['action','id']);assert.equal(q.id,'home');assert(['connect','disconnect'].includes(q.action));reviews.clear();const id=randomBytes(32).toString('hex');reviews.set(id,{action:q.action,expires:Date.now()+120000});return {id,message:q.action==='disconnect'?'Lock your wallet first. The node will disconnect and retain its keys and saved history.':'Reconnect using your saved identity and network history.'};}
 if(route==='/node/apply'){assert.deepEqual(Object.keys(q),['id']);const r=reviews.get(q.id);reviews.delete(q.id);assert(r&&r.expires>Date.now());if(r.action==='connect')startNode();else{assert(await prepare(),'Lock your wallet first');await stopNode();}return {};}throw Error('Unsupported action');}};
async function shutdown(){if(closing)return;closing=true;updates.close();await stopNode();if(panel)await panel.close();if(existsSync(lock)&&readFileSync(lock,'utf8')===String(process.pid))unlinkSync(lock);}
try{panel=await serveManagement({state:join(state,'management'),port:p.walletPort+1,adapter});console.log('Node management: '+panel.url);console.log('Initial management password file: '+panel.credential.initial);startNode();updates.start();}catch(e){await shutdown();throw e;}
process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());

