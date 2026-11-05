import {createServer} from 'node:http';
import {readFileSync,existsSync,writeFileSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {Store} from './store.mjs';
import {stateHash,validateConfig,block,applyTx,workReceipt} from './core.mjs';
import {hash,canonical} from './crypto.mjs';
import {verifyCheckpoint} from './checkpoint.mjs';
import {validatorUpdates,activate} from './authority.mjs';
import {checkCheckpointState} from './checkpoint-state.mjs';
import {acceptSnapshot} from './bootstrap-snapshot.mjs';
import {snapshotChunk} from './snapshot-chunk.mjs';
const [directory,portText]=process.argv.slice(2),home=resolve(directory),port=Number(portText);assert(Number.isInteger(port)&&port>=1024&&port<=65535);
const read=f=>JSON.parse(readFileSync(join(home,f),'utf8'));
const config=read('app-config.json'),policy=read('trust-policy.json'),store=new Store(join(home,'application.sqlite'),config);
const work=existsSync(join(home,'work-key.json'))?read('work-key.json'):null;
let offered=null;const b64=h=>Buffer.from(h,'hex').toString('base64');
function publication(){if(!existsSync(join(home,'checkpoint.json')))return null;const doc=read('checkpoint.json');verifyCheckpoint(doc,policy);return doc;}
function dispatch(q){
 const s=store.state,root=stateHash(s,config);const response={height:s.height,hash:b64(root)};
 const txs=(q.txs??[]).map(x=>Buffer.from(x,'base64'));
 const req={height:q.height,blockHash:q.hash?Buffer.from(q.hash,'base64').toString('hex'):'0'.repeat(64),time:q.time,txs};
 switch(q.method){
 case 'info':return response;
 case 'init':assert.equal(q.chain,config.chainId);assert.equal(hash(JSON.parse(Buffer.from(q.state,'base64'))),validateConfig(config));return response;
 case 'check':try{applyTx({...s,height:s.height+1,...(s.authority?{authority:activate(s.authority,s.height+1)}:{})},txs[0],config,s.money.time);return {code:0};}catch{return {code:1};}
 case 'prepare':{const out=block(s,config,{...req,txs:txs.slice(0,64)},true);return {txs:out.accepted.map(x=>x.toString('base64'))};}
 case 'process':try{block(s,config,req);return {accept:true};}catch{return {accept:false};}
 case 'finalize':{const out=store.finalize(req);return {hash:b64(stateHash(out.state,config)),codes:out.codes,updates:validatorUpdates(out.state,req.height)};}
 case 'commit':store.commit();return {};
 case 'status':return {...response,value:{profile:config.profile,chain:config.chainId,height:s.height,appHash:root,money:s.money,...(s.authority?{authority:s.authority}:{}),trialOnly:true}};
 case 'snapshot':{const at=q.key?Number(q.key):s.height;const state=store.snapshot(at);return {height:at,value:{state,appHash:stateHash(state,config)}};}
 case 'work':assert(work,'no worker');return {value:workReceipt(s,q.pid,q.index,work.node,work)};
 case 'publicWork':{assert(work,'no worker');const r=JSON.parse(q.key);assert.equal(Object.keys(r).sort().join(','),'index,pid');return {value:workReceipt(s,r.pid,r.index,work.node,work)};}
 case 'runtime':return {value:{memory:process.memoryUsage(),cpu:process.cpuUsage(),height:s.height}};
 case 'publicCheckpoint':return {value:publication()};
 case 'installCheckpoint':{const previous=existsSync(join(home,'checkpoint.json'))?read('checkpoint.json'):null;verifyCheckpoint(q.document,policy,{previous,allowGap:true});const b=q.document.body;assert.equal(store.snapshot(b.height).blockHash,b.blockHash,'checkpoint must be in this node committed history');checkCheckpointState(q.document,store.snapshot(b.appHeight),config,policy);const temp=join(home,'checkpoint.pending.json');writeFileSync(temp,JSON.stringify(q.document),{mode:0o600});renameSync(temp,join(home,'checkpoint.json'));return {installed:b.sequence};}
 case 'listSnapshots':{let d;try{d=publication();}catch{return {snapshots:[]};}if(!d)return {snapshots:[]};const state=store.snapshot(d.body.appHeight);assert.equal(hash(state),d.body.snapshotHash);return {snapshots:[{height:d.body.appHeight,format:1,chunks:1,hash:b64(d.body.snapshotHash),metadata:Buffer.from(JSON.stringify(d)).toString('base64')}]};}
 case 'loadSnapshotChunk':{const d=publication();assert(d);return snapshotChunk(q,d.body.appHeight,height=>store.snapshot(height));}
 case 'offerSnapshot':{const d=read('checkpoint.json');offered=acceptSnapshot(q,d,policy,config,store.state.height);return {accept:true};}
 case 'applySnapshotChunk':{assert(offered&&q.index===0);const bytes=Buffer.from(q.chunk,'base64');assert(bytes.length<=1048576);const state=JSON.parse(bytes);checkCheckpointState(offered,state,config,policy);store.restore(state);const temp=join(home,'checkpoint.bootstrap.json');writeFileSync(temp,JSON.stringify(offered),{mode:0o600});renameSync(temp,join(home,'checkpoint.json'));offered=null;return {accept:true};}
 default:throw Error('unknown method');
 }
}
const server=createServer(async(req,res)=>{if(req.method!=='POST'||req.url!=='/'||req.headers.origin){res.writeHead(403);res.end();return;}try{let size=0,parts=[];for await(const b of req){size+=b.length;if(size>2*1048576)throw Error('request size');parts.push(b);}const q=JSON.parse(Buffer.concat(parts));const result=dispatch(q);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));}catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}});
server.requestTimeout=10000;server.headersTimeout=5000;server.listen(port,'127.0.0.1',()=>console.log('Duebyte public trial app ready '+port));
process.on('SIGTERM',()=>server.close(()=>{store.close();process.exit(0);}));
