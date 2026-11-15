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
export async function until(fn,ms=120000){let error;const end=Date.now()+ms;while(Date.now()<end){try{return await fn();}catch(e){error=e;await new Promise(r=>setTimeout(r,500));}}throw error;}
export async function purchaseCometNetwork(out,f,{walletReady=false}={}){
 assert(!fs.existsSync(out));fs.mkdirSync(out,{recursive:true});const base=36000,proxyBase=36200,apps=[],servers=[],proxies=[],homes=[],children=new Map();let partition=false;
 const bridge=resolve(import.meta.dirname,'../../build/duebyte-abci'+(process.platform==='win32'?'.exe':'')),nodeKeys=Array.from({length:10},keys),address=k=>createHash('sha256').update(Buffer.from(k.publicKey,'base64url')).digest('hex').slice(0,40),raw=k=>Buffer.concat([Buffer.from(k.privateKey,'base64url').subarray(-32),Buffer.from(k.publicKey,'base64url')]).toString('base64');
 const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v),{flag:'wx'});
 const rpc=async(i,method,params={})=>{const r=await(await fetch('http://127.0.0.1:'+(base+i*10+1),{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(4000)})).json();assert(!r.error,JSON.stringify(r.error));return r.result;};
 async function stop(i){const p=children.get(i);if(p&&p.exitCode===null){const done=new Promise(r=>p.once('exit',r));p.kill();await done;}children.delete(i);}
 function start(i){const fd=fs.openSync(join(out,'node'+i+'.log'),'a'),p=spawn(bridge,['-home',homes[i],'-app',String(base+i*10+4)],{windowsHide:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);children.set(i,p);}
 const state=()=>apps[0].handler.snapshotForAudit();
 // Synthetic funded genesis uses the existing authenticated indexed transition.
 // The production fresh-genesis zero-supply rule is deliberately not relaxed.
 const source=origin(f.c);let walletTrust=null,certificate=null;
 const create=file=>{if(!walletReady)return BoundedNetworkInterpreter.create(file,source,f.c,hash(source));const legacy=file+'.legacy';new Store(legacy,f.c).close();return migrateBoundedArchive(legacy,file,f.c,hash(source));};
 const open=i=>{const file=join(homes[i],'state.sqlite'),reader=new DatabaseSync(file,{readOnly:true}),root=reader.prepare('SELECT rootHash FROM meta WHERE id=1').get().rootHash;reader.close();apps[i]=new BoundedApplication(BoundedNetworkInterpreter.open(file,f.c,root),{kind:'fresh-genesis'});};
 async function close(){await Promise.all([...children.keys()].map(stop));for(const p of proxies){for(const s of p.sockets)s.destroy();await new Promise(r=>p.server.close(r));}for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}for(const a of apps)try{a.close();}catch{}}
 try{
  for(let i=0;i<10;i++)for(let j=0;j<10;j++)if(i!==j){const sockets=new Set(),cross=Math.floor(i/5)!==Math.floor(j/5),server=net.createServer(socket=>{if(partition&&cross){socket.destroy();return;}const remote=net.connect(base+j*10,'127.0.0.1');sockets.add(socket);sockets.add(remote);const end=()=>{socket.destroy();remote.destroy();sockets.delete(socket);sockets.delete(remote);};socket.on('error',end);remote.on('error',end);socket.on('close',end);remote.on('close',end);socket.pipe(remote).pipe(socket);});await new Promise((ok,bad)=>{server.once('error',bad);server.listen(proxyBase+i*10+j,'127.0.0.1',ok);});proxies.push({server,sockets,cross});}
  const genesis={genesis_time:new Date(f.c.initial.time*1000).toISOString(),chain_id:f.c.chainId,initial_height:'1',validators:f.validators.map((k,i)=>({address:address(k).toUpperCase(),pub_key:{type:'tendermint/PubKeyEd25519',value:Buffer.from(k.publicKey,'base64url').toString('base64')},power:'10',name:'joint-lab-'+i})),app_hash:'',app_state:f.c};
  for(let i=0;i<10;i++){
   const home=join(out,'node'+i);homes.push(home);fs.mkdirSync(join(home,'config'),{recursive:true});fs.mkdirSync(join(home,'data'));const auth=randomBytes(32).toString('hex');fs.writeFileSync(join(home,'application-auth'),auth);write(join(home,'config/genesis.json'),genesis);
   write(join(home,'config/priv_validator_key.json'),{address:genesis.validators[i].address,pub_key:genesis.validators[i].pub_key,priv_key:{type:'tendermint/PrivKeyEd25519',value:raw(f.validators[i])}});write(join(home,'config/node_key.json'),{priv_key:{type:'tendermint/PrivKeyEd25519',value:raw(nodeKeys[i])}});write(join(home,'data/priv_validator_state.json'),{height:'0',round:0,step:0});
   fs.writeFileSync(join(home,'config/config.toml'),`moniker = "joint-lab-${i}"
log_level = "error"
[rpc]
laddr = "tcp://127.0.0.1:${base+i*10+1}"
[p2p]
laddr = "tcp://127.0.0.1:${base+i*10}"
persistent_peers = "${nodeKeys.map((k,j)=>j===i?null:address(k)+'@127.0.0.1:'+(proxyBase+i*10+j)).filter(Boolean).join(',')}"
addr_book_strict = false
allow_duplicate_ip = true
pex = false
[consensus]
timeout_commit = "10s"
skip_timeout_commit = false
create_empty_blocks = true
`);
   const handler=create(join(home,'state.sqlite'));
   if(walletReady&&i===0){const body=prepareBoundedRootTransition(source,f.c,handler,hash(source));certificate={body,approvals:f.validators.slice(0,7).map(k=>({key:k.publicKey,signature:sign(body,k.privateKey)}))};}
   apps[i]=new BoundedApplication(handler,{kind:'fresh-genesis'});
   const server=createServer(async(req,res)=>{try{assert.equal(req.headers['x-duebyte-app-auth'],auth);let size=0,parts=[];for await(const p of req){size+=p.length;assert(size<=2097152);parts.push(p);}const result=apps[i].dispatch(JSON.parse(Buffer.concat(parts)));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));}catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message}));}});
   servers.push(server);await new Promise((ok,bad)=>{server.once('error',bad);server.listen(base+i*10+4,'127.0.0.1',ok);});start(i);
  }
  await until(async()=>{const s=await Promise.all(apps.map((_,i)=>rpc(i,'status')));assert(s.every(x=>Number(x.sync_info.latest_block_height)>=2));});
  if(walletReady){
   const api=createBoundedApi(apps[0].handler);servers.push(api);await new Promise(r=>api.listen(0,'127.0.0.1',r));
   const genesisHash=hash(genesis),policy={domain:CHECKPOINT+'/POLICY',network:f.c.chainId,genesisHash,...f.c.control.policy},b=await rpc(0,'block',{height:'2'}),now=Math.floor(Date.now()/1000);
   const body={domain:CHECKPOINT,policyHash:hash(policy),network:f.c.chainId,genesisHash,sequence:1,height:2,blockHash:b.block_id.hash.toLowerCase(),appHeight:1,appHash:b.block.header.app_hash.toLowerCase(),snapshotHash:hash('unused indexed synthetic snapshot'),previous:null,issuedAt:now,expiresAt:now+3500};
   walletTrust={checkpoint:{body,signatures:f.validators.slice(0,3).map(k=>({key:k.publicKey,signature:sign(body,k.privateKey)}))},bounded:{url:'http://127.0.0.1:'+api.address().port,source,certificate}};
  }
 }catch(e){await close();throw e;}
 return {apps,homes,rpc,state,stop,start,close,walletTrust,
  split(value){partition=value;for(const p of proxies)if(p.cross)for(const s of p.sockets)s.destroy();},
  async restart(i){await stop(i);apps[i].close();open(i);start(i);},
  async restartAll(){await Promise.all(apps.map((_,i)=>stop(i)));for(let i=0;i<10;i++){apps[i].close();open(i);}for(let i=0;i<10;i++)start(i);await until(async()=>{assert((await rpc(0,'status')).sync_info.catching_up===false);});},
  async broadcast(wire){const r=await rpc(0,'broadcast_tx_sync',{tx:wire.toString('base64')});assert.equal(r.code,0,'mempool rejected '+r.log);return r.hash;},
  async confirmed(txHash){return until(async()=>{const t=await rpc(0,'tx',{hash:Buffer.from(txHash,'hex').toString('base64')});assert.equal(t.tx_result.code,0);return t;});},
  async submit(wire){return this.confirmed(await this.broadcast(wire));},
  async replay(){const statuses=await Promise.all(apps.map((_,i)=>rpc(i,'status'))),height=Math.min(...statuses.map(s=>Number(s.sync_info.latest_block_height)))-1,heads=await Promise.all(apps.map((_,i)=>rpc(i,'block',{height:String(height+1)})));assert.equal(new Set(heads.map(x=>x.block.header.app_hash)).size,1);
   const replay=create(join(out,'replay.sqlite'));try{for(let h=1;h<=height;h++){const b=await rpc(0,'block',{height:String(h)}),next=await rpc(0,'block',{height:String(h+1)});replay.commitBlock({height:h,time:Math.floor(Date.parse(b.block.header.time)/1000),blockHash:b.block_id.hash.toLowerCase(),txs:(b.block.data.txs??[]).map(x=>Buffer.from(x,'base64'))},replay.root);assert.equal(replay.root.toUpperCase(),next.block.header.app_hash);}return {height,root:replay.root,supply:replay.snapshotForAudit().money.supply};}finally{replay.close();}
  }
 };
}
