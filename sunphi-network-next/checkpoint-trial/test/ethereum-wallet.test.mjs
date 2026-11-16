import test from 'node:test';import assert from 'node:assert/strict';import {hash} from '../crypto.mjs';
import {ETHEREUM_USDC,ETHEREUM_USDT,ETHEREUM_GENESIS} from '../research/exchange-evm-networks.mjs';import {checkAssetProfile,observePortfolio,portfolio} from '../wallet-assets.mjs';import {observeEthereumAccount} from '../research/ethereum-wallet.mjs';
const account={asset:'USDC',network:'ethereum-mainnet',address:'0x'+'1'.repeat(40),genesis:ETHEREUM_GENESIS,contract:ETHEREUM_USDC,sources:[0,1,2].map(i=>({id:'source-'+i,operator:'operator-'+i,url:'https://reader'+i+'.invalid'}))};
const profile={version:2,isolated:false,owner:'wallet',chain:'duebyte-actual',accounts:[account]},now=10000;
function reader(i,value='1234567',mode='normal'){const head={number:'0x20',hash:'0x'+hash('head'),timestamp:'0x26ac'};return {id:'source-'+i,operator:'operator-'+i,rpc:async(m,p)=>{if(mode==='offline')throw Error('offline');if(m==='eth_chainId')return mode==='wrong-chain'?'0x2105':'0x1';if(m==='eth_getBlockByNumber')return p[0]==='0x0'?{hash:'0x'+ETHEREUM_GENESIS}:mode==='stale'?{...head,timestamp:'0x1'}:head;if(m==='eth_call')return p[0].data==='0x313ce567'?'0x6':'0x'+BigInt(value).toString(16).padStart(64,'0');throw Error('unexpected');}};}
test('read-only Ethereum profile is bound to wallet, native token and three distinct operators',()=>{checkAssetProfile(profile,'wallet','duebyte-actual');for(const p of [{...profile,owner:'other'},{...profile,chain:'other'},{...profile,accounts:[{...account,contract:'0x'+'2'.repeat(40)}]},{...profile,accounts:[{...account,network:'base-mainnet'}]},{...profile,accounts:[{...account,sources:[account.sources[0],account.sources[0],account.sources[2]]}]}])assert.throws(()=>checkAssetProfile(p,'wallet','duebyte-actual'));});
test('Ethereum balance requires matching finalized values and preserves exact fractional units',async()=>{const readers=[reader(0),reader(1),reader(2,'999')],observed=await observeEthereumAccount(account,{readers,now});assert.equal(observed.availableAtomic,'1234567');assert.equal(observed.sources.length,2);const p=portfolio({owner:'wallet',chain:'duebyte-actual',external:[observed],now:now*1000});assert.equal(p.assets[2].available,'1.234567');});
test('Ethereum balance disagreement, outage, stale source or wrong network never fabricates zero',async()=>{for(const mode of ['offline','stale','wrong-chain','disagree']){const readers=[reader(0),reader(1,'2',mode==='disagree'?'normal':mode),reader(2,'3',mode==='disagree'?'normal':mode)];const [result]=await observePortfolio(profile,{ethereumOptions:{readers,now,timeoutMs:100}});assert.equal(result.status,'unavailable');assert.equal(result.availableAtomic,null);}});
test('observed zero is distinct from unavailable and a single failed source is tolerated',async()=>{const r=await observeEthereumAccount(account,{readers:[reader(0,'0'),reader(1,'0'),reader(2,'0','offline')],now});assert.equal(r.availableAtomic,'0');assert.equal(r.sources.length,2);});
test('one hung balance source does not block two matching complete observations',async()=>{const slow=reader(2),rpc=slow.rpc;slow.rpc=(m,p)=>m==='eth_call'?new Promise(()=>{}):rpc(m,p);const r=await observeEthereumAccount(account,{readers:[reader(0),reader(1),slow],now,timeoutMs:100});assert.equal(r.availableAtomic,'1234567');});

const usdt={...account,asset:'USDT',contract:ETHEREUM_USDT};
test('new stablecoin profile preserves old USDC-only identity and refuses duplicate or substituted assets',()=>{
 const p={...profile,version:3,accounts:[account,usdt]};checkAssetProfile(p,'wallet','duebyte-actual');
 for(const accounts of [[usdt,usdt],[{...usdt,contract:ETHEREUM_USDC}],[{...account,contract:ETHEREUM_USDT}],[{...usdt,asset:'XMR'}],[]])assert.throws(()=>checkAssetProfile({...p,accounts},'wallet','duebyte-actual'));
 assert.throws(()=>checkAssetProfile({...profile,accounts:[usdt]},'wallet','duebyte-actual'));
});
test('USDT reads only its pinned contract at an agreed finalized anchor',async()=>{
 const readers=[0,1,2].map(i=>{const r=reader(i,'2000001'),rpc=r.rpc;r.rpc=(m,p)=>{if(m==='eth_call')assert.equal(p[0].to,ETHEREUM_USDT);return rpc(m,p);};return r;});
 const x=await observeEthereumAccount(usdt,{readers,now});assert.equal(x.asset,'USDT');assert.equal(x.contract,ETHEREUM_USDT);
 const p=portfolio({owner:'wallet',chain:'duebyte-actual',external:[x],now:now*1000});assert.equal(p.assets.find(a=>a.asset==='USDT').available,'2.000001');assert.equal(p.assets.find(a=>a.asset==='USDC').available,null);
});
test('USDT precision, stale values and disagreement fail closed; XMR cannot inherit an unverified balance',async()=>{
 for(const mode of ['precision','disagree']){
  const readers=[0,1,2].map(i=>{const r=reader(i,mode==='disagree'?String(i):'1'),rpc=r.rpc;r.rpc=(m,p)=>m==='eth_call'&&p[0].data==='0x313ce567'&&mode==='precision'?'0x12':rpc(m,p);return r;});
  await assert.rejects(observeEthereumAccount(usdt,{readers,now,timeoutMs:100}));
 }
 const x={asset:'USDT',status:'observed',availableAtomic:'1',pendingAtomic:'0',checkedAt:1};
 assert.equal(portfolio({external:[x],now:100000}).assets.find(a=>a.asset==='USDT').available,null);
 assert.equal(portfolio({external:[{...x,asset:'XMR',checkedAt:100000}],now:100000}).assets.find(a=>a.asset==='XMR').status,'not-supported');
});
