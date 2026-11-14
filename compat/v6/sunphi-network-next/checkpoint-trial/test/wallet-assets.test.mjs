import test from 'node:test';import assert from 'node:assert/strict';
import {assetDecimal,portfolio,checkAssetProfile,observeAsset,observePortfolio} from '../wallet-assets.mjs';
const base={owner:'owner',chain:'duebyte-exchange-lab-test',balance:{available:'10000001'},scale:'1000000',checkedAt:100000,now:100000};
test('exact fractions and unavailable are distinct from confirmed zero',()=>{
 assert.equal(assetDecimal('1',8),'0.00000001');assert.equal(assetDecimal('10000000000000001',6),'10000000000.000001');
 assert.throws(()=>assetDecimal('1.5',6));const p=portfolio(base);assert.equal(p.assets[0].available,'10.000001');assert.equal(p.assets[1].available,null);assert.equal(p.assets[2].status,'not-connected');assert.equal(p.combinedFiatValue,null);
 const e={asset:'BTC',status:'observed',availableAtomic:'0',pendingAtomic:'1',checkedAt:100000};assert.equal(portfolio({...base,external:[e]}).assets[1].available,'0');assert.equal(portfolio({...base,external:[e]}).assets[1].pending,'0.00000001');
 for(const checkedAt of [1,100001]){assert.equal(portfolio({...base,checkedAt}).assets[0].available,null);assert.equal(portfolio({...base,external:[{...e,checkedAt}]}).assets[1].available,null);}
 assert.equal(portfolio({...base,error:'offline'}).assets[0].available,null);
});
const account={asset:'USDC',network:'ethereum-local',address:'0x'+'1'.repeat(40),rpc:'http://127.0.0.1:35520',genesis:'2'.repeat(64),contract:'0x'+'3'.repeat(40),confirmations:1};
test('disposable Bitcoin cookies support both platforms without arbitrary file access',()=>{
 const btc={...account,asset:'BTC',network:'bitcoin-regtest',address:'bcrt1q'+'q'.repeat(40),contract:'native'};
 const check=rpcCookieFile=>checkAssetProfile({version:1,isolated:true,owner:'owner',chain:base.chain,accounts:[{...btc,rpcCookieFile}]},'owner',base.chain);
 for(const p of ['F:/DueByteWork/exchange-test/btc/regtest/.cookie','/tmp/duebyte-exchange54-home-r7/btc/regtest/.cookie'])check(p);
 for(const p of ['/root/.bitcoin/.cookie','/tmp/duebyte-exchange54-test/../btc/regtest/.cookie','/tmp/duebyte-exchange54-test/btc/mainnet/.cookie','/tmp/duebyte-exchange54-test/btc/regtest/wallet.dat','F:/DueByteWork/exchange-test/../btc/regtest/.cookie'])assert.throws(()=>check(p));
});
test('read profile rejects production routes, duplicate assets and wrong wallet',()=>{
 const p={version:1,isolated:true,owner:'owner',chain:base.chain,accounts:[account]};checkAssetProfile(p,'owner',base.chain);
 assert.throws(()=>checkAssetProfile(p,'another',base.chain));assert.throws(()=>checkAssetProfile({...p,isolated:false},'owner',base.chain));assert.throws(()=>checkAssetProfile({...p,accounts:[account,account]},'owner',base.chain));assert.throws(()=>checkAssetProfile({...p,accounts:[{...account,rpc:'https://external.example'}]},'owner',base.chain));
 assert.throws(()=>checkAssetProfile({...p,accounts:[{...account,rpcCookieFile:'C:/private/secret'}]},'owner',base.chain));
});
test('external observation pins network, asset precision and canonical block; outage cannot zero balance',async()=>{
 const block={hash:'0x'+'4'.repeat(64),number:'0x1'};let mode='normal';
 const rpc=async(method,params)=>{if(mode==='offline')throw Error('offline');if(method==='eth_chainId')return mode==='chain'?'0x1':'0x7a69';if(method==='eth_getBlockByNumber')return params[0]==='0x0'?{hash:'0x'+account.genesis}:mode==='reorg'&&params[0]==='0x1'?{...block,hash:'0x'+'5'.repeat(64)}:block;if(method==='eth_call')return params[0].data==='0x313ce567'?mode==='precision'?'0x12':'0x6':'0x'+BigInt(1234567).toString(16).padStart(64,'0');throw Error(method);};
 const observed=await observeAsset(account,rpc);assert.equal(observed.availableAtomic,'1234567');
 for(mode of ['chain','precision','reorg','offline']){await assert.rejects(observeAsset(account,rpc));const [row]=await observePortfolio({accounts:[account]},{rpcFor:()=>rpc});assert.equal(row.status,'unavailable');assert.equal(row.availableAtomic,null);}
});
