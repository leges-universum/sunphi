import test from 'node:test';import assert from 'node:assert/strict';import {hash} from '../crypto.mjs';
import {readAnchorQuorum} from '../research/exchange-source-anchor.mjs';
const genesis=hash('genesis'),now=10000;
function reader(chain,id,mode='good'){
 let commonReads=0;const height=mode==='old'?14:20,block=h=>hash(['block',h]);
 return {id:'r'+id,operator:'o'+id,rpc:async(method,p)=>{
  if(mode==='offline')throw Error('offline');if(mode==='hang')return new Promise(()=>{});
  if(chain==='BASE'){
   if(method==='eth_chainId')return mode==='wrong'?'0x1':'0x2105';
   if(p[0]==='0x0')return mode==='missing-genesis'?null:{hash:'0x'+genesis};
   const h=p[0]==='finalized'?height:Number(BigInt(p[0]));
   const fork=(mode==='fork'||(mode==='reorg'&&++commonReads>2));
   return {number:'0x'+h.toString(16),hash:'0x'+(fork?hash(['fork',h]):block(h)),timestamp:'0x'+(mode==='stale'?100:9990).toString(16)};
  }
  if(method==='getblockchaininfo')return {chain:mode==='wrong'?'test':'main',initialblockdownload:mode==='ibd',blocks:height,headers:height,bestblockhash:block(height)};
  if(method==='getblockhash'){if(p[0]===0)return mode==='missing-genesis'?null:genesis;return mode==='fork'?hash(['fork',p[0]]):block(p[0]);}
  if(method==='getblockheader'){const h=Array.from({length:21},(_,i)=>i).find(n=>block(n)===p[0]||hash(['fork',n])===p[0]);return {hash:p[0],height:h,time:mode==='stale'?100:9990,confirmations:height-h+1};}
 }};
}
for(const chain of ['BTC','BASE'])for(const bad of ['offline','missing-genesis','wrong','stale','fork'])test(chain+' readiness tolerates one '+bad+' reader',async()=>{
 const proof=await readAnchorQuorum([reader(chain,0),reader(chain,1),reader(chain,2,bad)],{chain,genesis,now,maxAge:100});assert.equal(proof.sources.length,2);assert.equal(proof.settlementAuthorized,false);assert.deepEqual(proof.sources.map(s=>s.id),['r0','r1']);
});
for(const chain of ['BTC','BASE'])test(chain+' two stale readers cannot authorize a shared old anchor',async()=>{await assert.rejects(readAnchorQuorum([reader(chain,0),reader(chain,1,'stale'),reader(chain,2,'stale')],{chain,genesis,now,maxAge:100}));});
test('Base reorg during observation is not a stable anchor',async()=>{await assert.rejects(readAnchorQuorum([reader('BASE',0,'reorg'),reader('BASE',1,'reorg'),reader('BASE',2,'offline')],{chain:'BASE',genesis,now}));});
test('readiness timeout and duplicate operators fail closed',async()=>{const a=[reader('BASE',0),reader('BASE',1,'hang'),reader('BASE',2,'hang')];await assert.rejects(readAnchorQuorum(a,{chain:'BASE',genesis,now,timeoutMs:50}));a[2].operator=a[0].operator;await assert.rejects(readAnchorQuorum(a,{chain:'BASE',genesis,now}));});
test('a hung third reader cannot suppress two fresh agreeing readers',async()=>{const proof=await readAnchorQuorum([reader('BASE',0),reader('BASE',1),reader('BASE',2,'hang')],{chain:'BASE',genesis,now,timeoutMs:100});assert.deepEqual(proof.sources.map(s=>s.id),['r0','r1']);});
