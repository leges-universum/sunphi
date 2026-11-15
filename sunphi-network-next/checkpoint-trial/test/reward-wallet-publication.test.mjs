import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
import {fixture} from '../../research/transition-core-20261103/fixture.mjs';
import {PROFILE} from '../core.mjs';
import {hash,keys} from '../crypto.mjs';
import {CHECKPOINT} from '../checkpoint.mjs';
import {createVault} from '../vault.mjs';
import {prepareRewardIdentity} from '../reward-identity.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate,message){
 const end=Date.now()+3000;
 while(Date.now()<end){const value=await predicate();if(value)return value;await sleep(20);}
 assert.fail(message);
}
async function freePort(){
 for(let n=0;n<30;n++){const server=createServer(),port=20000+Math.floor(Math.random()*6000);
  try{await new Promise((r,j)=>{server.once('error',j);server.listen(port,'127.0.0.1',r);});await new Promise(r=>server.close(r));return port;}catch{}
 }
 throw Error('No test port available');
}

for(const indexed of [false,true])for(const existing of [false,true])test(`reward wallet catalogue is available without verified network history (${indexed?'bounded':'legacy'}, ${existing?'existing wallet':'create wallet'})`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'duebyte-reward-publication-')),home=join(root,'wallet'),password='synthetic-test-password';mkdirSync(home);
 const config={profile:PROFILE,chainId:'duebyte-trial-reward-publication-test',trialOnly:true,initial:fixture().state};
 const genesis={chain_id:config.chainId,app_state:config,validators:Array.from({length:10},()=>({pub_key:{type:'tendermint/PubKeyEd25519',value:Buffer.from(keys().publicKey,'base64url').toString('base64')},power:'10'}))};
 const policy={domain:CHECKPOINT+'/POLICY',version:1,network:config.chainId,genesisHash:hash(genesis),members:Array.from({length:4},(_,i)=>({key:keys().publicKey,group:hash({i})})),threshold:3,maxAge:3600,notAfter:Math.floor(Date.now()/1000)+86400};
 prepareRewardIdentity(root,config);
 for(const [name,value]of Object.entries({'app-config':config,genesis,'trust-policy':policy,connections:{rpc:'http://127.0.0.1:1',workers:{}},checkpoint:{}}))writeFileSync(join(home,name+'.json'),JSON.stringify(value));
 if(indexed)writeFileSync(join(home,'indexed-wallet.json'),JSON.stringify({bounded:{url:'http://127.0.0.1:1',source:{},certificate:{}}}));
 if(existing)writeFileSync(join(home,'wallet.encrypted.json'),JSON.stringify(createVault(password)));
 const port=await freePort(),token=randomBytes(32).toString('hex');let child,messages;
 async function start(){
  messages=[];child=fork(process.env.DUEBYTE_TEST_WALLET_SERVER??resolve(import.meta.dirname,'../wallet-server.mjs'),[home,String(port),hash(policy)],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
  child.on('message',m=>messages.push(m));
  await until(()=>messages.find(m=>m.ready===port),'Wallet server did not start');
 }
 async function stop(){if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}}
 async function call(path,data){const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:data?'POST':'GET',headers:{'x-duebyte-token':token,'content-type':'application/json'},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(5000)});const body=await r.json();assert.equal(r.status,200,body.error);return body;}
 const latest=()=>messages.findLast(m=>Array.isArray(m.rewardWallets));
 async function catalog(count){return until(()=>latest()?.rewardWallets.length===count&&latest(),'Local reward wallet catalogue was withheld while network verification failed');}
 async function idle(){await until(async()=>!(await call('/status')).working,'Verification did not finish');}
 try{
  await start();await idle();
  if(existing){const before=await catalog(1);assert.equal(before.rewardWallets[0].rewardsReady,false,'A locked original wallet must not gain consent without unlocking');}
  const created=await call(existing?'/unlock':'/create',{password,name:'Offline creation'}),id=created.activeWallet;
  await until(()=>latest()?.rewardWallets[0]?.rewardsReady,'Unlock did not publish payout consent');
  const first=await catalog(1);assert.equal(first.rewards,null);assert.equal(first.rewardWallets[0].id,id);assert.equal(first.rewardWallets[0].rewardsReady,true);assert.equal(first.rewardWallets[0].rewardsSelected,true);
  const backup=await call('/backup');await idle();await call('/lock',{});
  assert.equal((await call('/status')).checkedAt,null,'Local visibility must not claim network verification');
  await stop();await start();
  assert.deepEqual((await catalog(1)).rewardWallets,first.rewardWallets,'Locked restart must restore the catalogue without unlocking keys');
  await idle();await call('/unlock',{walletId:id,password});assert.deepEqual(await call('/backup'),backup);await idle();await call('/lock',{});
  await call('/restore',{password,name:'Offline restore',backup:{format:'DueByte encrypted wallet',network:config.chainId,vault:createVault(password)}});
  const second=(await catalog(2)).rewardWallets.find(w=>w.id!==id);assert(second.rewardsReady);assert.equal(second.rewardsSelected,false,'Restoring a second wallet must not change payout selection');
  child.send({command:'reward-wallets',request:'select-second',ids:[second.id]});
  await until(()=>messages.find(m=>m.rewardRequest==='select-second'&&m.ok),'Selection was not acknowledged');
  assert.deepEqual(latest().rewardWallets.filter(w=>w.rewardsSelected).map(w=>w.id),[second.id]);
  await stop();await start();assert.deepEqual((await catalog(2)).rewardWallets.filter(w=>w.rewardsSelected).map(w=>w.id),[second.id]);
  await idle();const status=await call('/status');assert.equal(status.locked,true);assert.equal(status.checkedAt,null);assert.equal(status.height,null);assert(status.error);assert.equal(status.rewards,null);
  for(const m of messages.filter(m=>m.rewardWallets))for(const row of m.rewardWallets)assert.deepEqual(Object.keys(row).sort(),['id','name','owner','rewardsReady','rewardsSelected'],'IPC publishes only public wallet metadata');
 }finally{await stop();}
});
