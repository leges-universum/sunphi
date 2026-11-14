// Disposable loopback consensus network with per-edge TCP fault switches.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {hash,keys,sign} from '../../crypto.mjs';
import {origin} from '../../core.mjs';
import {Store} from '../../store.mjs';
import {CHECKPOINT} from '../../checkpoint.mjs';
import {migrateBoundedArchive} from '../../research/bounded-archive-migration.mjs';
import {prepareBoundedRootTransition} from '../../research/bounded-root-transition.mjs';
import {createBoundedApi} from '../../research/bounded-api.mjs';
import {BoundedNetworkInterpreter} from '../../research/bounded-network-interpreter.mjs';
import {BoundedApplication} from '../../research/bounded-application.mjs';
import {createFreshChain} from '../../research/fresh-chain-preparation.mjs';
import {openFreshApplication} from '../../research/fresh-application.mjs';
export async function until(fn,ms=120000){let error;const end=Date.now()+ms;while(Date.now()<end){try{return await fn();}catch(e){error=e;await new Promise(r=>setTimeout(r,500));}}throw error;}
export async function purchaseCometNetwork(out,f,{walletReady=false,labSourceState=null,rpcTimeoutMs=4000,standbyValidators=[],bridgeBinary=null,freshGenesis=false,bridgeBinaries=[],applicationRuntimes=[],workerKeys=[]}={}){
 assert(Number.isInteger(rpcTimeoutMs)&&rpcTimeoutMs>=4000&&rpcTimeoutMs<=30000);
 assert(Array.isArray(standbyValidators));const signers=[...f.validators,...standbyValidators],count=signers.length;assert(count>=4&&count<=16,'isolated harness size');assert.equal(new Set(signers.map(k=>k.publicKey)).size,count);
 assert(Array.isArray(workerKeys)&&(workerKeys.length===0||workerKeys.length===count),'one lab worker key per application');
 assert(!fs.existsSync(out));fs.mkdirSync(out,{recursive:true});const base=36000,proxyBase=36200,apps=[],servers=[],proxies=[],homes=[],children=new Map();let partition=false;
 const bridge=bridgeBinary?resolve(bridgeBinary):resolve(import.meta.dirname,'../../build/duebyte-abci'+(process.platform==='win32'?'.exe':'')),nodeKeys=Array.from({length:count},keys),address=k=>createHash('sha256').update(Buffer.from(k.publicKey,'base64url')).digest('hex').slice(0,40),raw=k=>Buffer.concat([Buffer.from(k.privateKey,'base64url').subarray(-32),Buffer.from(k.publicKey,'base64url')]).toString('base64');
 const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v),{flag:'wx'});
 const rpc=async(i,method,params={})=>{const r=await(await fetch('http://127.0.0.1:'+(base+i*10+1),{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(rpcTimeoutMs)})).json();assert(!r.error,JSON.stringify(r.error));return r.result;};
 async function stop(i){const p=children.get(i);if(p&&p.exitCode===null){const done=new Promise(r=>p.once('exit',r));p.kill();await done;}children.delete(i);}
 function start(i){const fd=fs.openSync(join(out,'node'+i+'.log'),'a'),p=spawn(bridgeBinaries[i]??bridge,['-home',homes[i],'-app',String(base+i*10+4)],{windowsHide:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);children.set(i,p);}
 const state=()=>apps[0].handler.snapshotForAudit(),snapshotRepositories=new Map();
 // Synthetic funded genesis uses the existing authenticated indexed transition.
 // The production fresh-genesis zero-supply rule is deliberately not relaxed.
 assert(!freshGenesis||!labSourceState,'fresh chain cannot import synthetic or legacy state');
 const source=labSourceState?structuredClone(labSourceState):origin(f.c);let walletTrust=null,certificate=null,fresh=null;
 if(labSourceState){assert(!walletReady&&f.c.trialOnly);assert.equal(source.configHash,hash(f.c));assert(Number.isSafeInteger(source.height)&&source.height>=0);assert.equal(BigInt(source.money.supply)*BigInt(f.c.initial.unitScale??'1'),BigInt(f.c.initial.supply)*BigInt(source.money.unitScale??'1'),'synthetic supply conservation across precision migration');assert.deepEqual(source.money.requests,{});}
 const initialHeight=source.height+1;
 const create=(file,i=0)=>{if(freshGenesis){const result=(applicationRuntimes[i]?.createFreshChain??createFreshChain)(file,f.c);const terms={manifest:result.manifest,manifestHash:hash(result.manifest)};if(fresh)assert.deepEqual(terms,fresh);else fresh=terms;return result.handler;}if(!walletReady)return BoundedNetworkInterpreter.create(file,source,f.c,hash(source));const legacy=file+'.legacy';new Store(legacy,f.c).close();return migrateBoundedArchive(legacy,file,f.c,hash(source));};
 const open=i=>{const file=join(homes[i],'state.sqlite');if(freshGenesis){apps[i]=(applicationRuntimes[i]?.openFreshApplication??openFreshApplication)(file,f.c,fresh);return;}const reader=new DatabaseSync(file,{readOnly:true}),root=reader.prepare('SELECT rootHash FROM meta WHERE id=1').get().rootHash;reader.close();apps[i]=new BoundedApplication(BoundedNetworkInterpreter.open(file,f.c,root),{kind:'fresh-genesis'});};
 async function close(){await Promise.all([...children.keys()].map(stop));for(const p of proxies){for(const s of p.sockets)s.destroy();await new Promise(r=>p.server.close(r));}for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}for(const a of apps)try{a.close();}catch{}}
 try{
  for(let i=0;i<count;i++)for(let j=0;j<count;j++)if(i!==j){const sockets=new Set(),cross=(i<Math.floor(count/2))!==(j<Math.floor(count/2)),server=net.createServer(socket=>{if(partition&&cross){socket.destroy();return;}const remote=net.connect(base+j*10,'127.0.0.1');sockets.add(socket);sockets.add(remote);const end=()=>{socket.destroy();remote.destroy();sockets.delete(socket);sockets.delete(remote);};socket.on('error',end);remote.on('error',end);socket.on('close',end);remote.on('close',end);socket.pipe(remote).pipe(socket);});await new Promise((ok,bad)=>{server.once('error',bad);server.listen(proxyBase+i*count+j,'127.0.0.1',ok);});proxies.push({server,sockets,cross});}
  const genesis={genesis_time:new Date(f.c.initial.time*1000).toISOString(),chain_id:f.c.chainId,initial_height:String(initialHeight),validators:f.validators.map((k,i)=>({address:address(k).toUpperCase(),pub_key:{type:'tendermint/PubKeyEd25519',value:Buffer.from(k.publicKey,'base64url').toString('base64')},power:String(f.c.control.validators[i].power??10),name:'joint-lab-'+i})),app_hash:'',app_state:f.c};
  for(let i=0;i<count;i++){
   const home=join(out,'node'+i);homes.push(home);fs.mkdirSync(join(home,'config'),{recursive:true});fs.mkdirSync(join(home,'data'));const auth=randomBytes(32).toString('hex');fs.writeFileSync(join(home,'application-auth'),auth);
   write(join(home,'config/priv_validator_key.json'),{address:address(signers[i]).toUpperCase(),pub_key:{type:'tendermint/PubKeyEd25519',value:Buffer.from(signers[i].publicKey,'base64url').toString('base64')},priv_key:{type:'tendermint/PrivKeyEd25519',value:raw(signers[i])}});write(join(home,'config/node_key.json'),{priv_key:{type:'tendermint/PrivKeyEd25519',value:raw(nodeKeys[i])}});write(join(home,'data/priv_validator_state.json'),{height:'0',round:0,step:0});
   fs.writeFileSync(join(home,'config/config.toml'),`moniker = "joint-lab-${i}"
log_level = "error"
[rpc]
laddr = "tcp://127.0.0.1:${base+i*10+1}"
[p2p]
laddr = "tcp://127.0.0.1:${base+i*10}"
persistent_peers = "${nodeKeys.map((k,j)=>j===i?null:address(k)+'@127.0.0.1:'+(proxyBase+i*count+j)).filter(Boolean).join(',')}"
addr_book_strict = false
allow_duplicate_ip = true
pex = false
[consensus]
timeout_commit = "10s"
skip_timeout_commit = false
create_empty_blocks = true
`);
   const handler=create(join(home,'state.sqlite'),i);
   if(labSourceState){genesis.app_hash=handler.root.toUpperCase();genesis.genesis_time=new Date(source.money.time*1000).toISOString();}
   write(join(home,'config/genesis.json'),genesis);
   if(walletReady&&!freshGenesis&&i===0){const body=prepareBoundedRootTransition(source,f.c,handler,hash(source));certificate={body,approvals:f.validators.slice(0,7).map(k=>({key:k.publicKey,signature:sign(body,k.privateKey)}))};}
   if(freshGenesis){handler.close();open(i);}else apps[i]=new BoundedApplication(handler,{kind:'fresh-genesis'});
   const server=createServer(async(req,res)=>{try{assert.equal(req.headers['x-duebyte-app-auth'],auth);let size=0,parts=[];for await(const p of req){size+=p.length;assert(size<=2097152);parts.push(p);}const q=JSON.parse(Buffer.concat(parts)),repo=snapshotRepositories.get(i),result=q.method==='listSnapshots'&&repo?repo.list():q.method==='loadSnapshotChunk'&&repo?repo.load(q):apps[i].dispatch(q,{work:workerKeys[i]??null});
    // A synthetic prepared genesis has no committed Comet blocks yet. Report
    // zero until its first commit so Comet executes InitChain and installs the
    // genesis validator set, even when the laboratory starts above height one.
    if(labSourceState&&q.method==='info'&&result.height===source.height)result.height=0;
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));}catch(e){fs.appendFileSync(join(out,'application-errors.log'),`node${i}: ${e.stack}\n`);res.writeHead(400);res.end(JSON.stringify({error:e.message}));}});
   servers.push(server);await new Promise((ok,bad)=>{server.once('error',bad);server.listen(base+i*10+4,'127.0.0.1',ok);});start(i);
  }
  await until(async()=>{const s=await Promise.all(apps.map((_,i)=>rpc(i,'status')));assert(s.every(x=>Number(x.sync_info.latest_block_height)>=initialHeight+1));});
  if(walletReady){
   const api=createBoundedApi(apps[0].handler);servers.push(api);await new Promise(r=>api.listen(0,'127.0.0.1',r));
   const genesisHash=hash(genesis),policy={domain:CHECKPOINT+'/POLICY',network:f.c.chainId,genesisHash,...f.c.control.policy},b=await rpc(0,'block',{height:'2'}),now=Math.floor(Date.now()/1000);
   const body={domain:CHECKPOINT,policyHash:hash(policy),network:f.c.chainId,genesisHash,sequence:1,height:2,blockHash:b.block_id.hash.toLowerCase(),appHeight:1,appHash:b.block.header.app_hash.toLowerCase(),snapshotHash:hash('unused indexed synthetic snapshot'),previous:null,issuedAt:now,expiresAt:now+3500};
   walletTrust={checkpoint:{body,signatures:f.validators.slice(0,3).map(k=>({key:k.publicKey,signature:sign(body,k.privateKey)}))},bounded:{url:'http://127.0.0.1:'+api.address().port,...(freshGenesis?{fresh}:{source,certificate})}};
  }
 }catch(e){await close();throw e;}
 return {apps,homes,rpc,state,stop,start,close,walletTrust,fresh,
  setSnapshotRepository(i,repo){assert(Number.isInteger(i)&&i>=0&&i<count);snapshotRepositories.set(i,repo);},
  split(value){partition=value;for(const p of proxies)if(p.cross)for(const s of p.sockets)s.destroy();},
  async restart(i){await stop(i);apps[i].close();open(i);start(i);},
  async restartAll(){await Promise.all(apps.map((_,i)=>stop(i)));for(let i=0;i<count;i++){apps[i].close();open(i);}for(let i=0;i<count;i++)start(i);await until(async()=>{assert((await rpc(0,'status')).sync_info.catching_up===false);});},
  async broadcast(wire){const r=await rpc(0,'broadcast_tx_sync',{tx:wire.toString('base64')});assert.equal(r.code,0,'mempool rejected '+r.log);return r.hash;},
  async confirmed(txHash){const t=await until(()=>rpc(0,'tx',{hash:Buffer.from(txHash,'hex').toString('base64')}));assert.equal(t.tx_result.code,0,'committed transaction rejected: '+t.tx_result.log);return t;},
  async submit(wire){return this.confirmed(await this.broadcast(wire));},
  async replay(){const statuses=await Promise.all(apps.map((_,i)=>rpc(i,'status'))),height=Math.min(...statuses.map(s=>Number(s.sync_info.latest_block_height)))-1,heads=await Promise.all(apps.map((_,i)=>rpc(i,'block',{height:String(height+1)})));assert.equal(new Set(heads.map(x=>x.block.header.app_hash)).size,1);
   const replay=create(join(out,'replay.sqlite'));try{for(let h=initialHeight;h<=height;h++){const b=await rpc(0,'block',{height:String(h)}),next=await rpc(0,'block',{height:String(h+1)});replay.commitBlock({height:h,time:Math.floor(Date.parse(b.block.header.time)/1000),blockHash:b.block_id.hash.toLowerCase(),txs:(b.block.data.txs??[]).map(x=>Buffer.from(x,'base64'))},replay.root);assert.equal(replay.root.toUpperCase(),next.block.header.app_hash);}return {height,root:replay.root,supply:replay.snapshotForAudit().money.supply};}finally{replay.close();}
  }
 };
}
