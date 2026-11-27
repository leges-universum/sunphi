import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {hash} from '../crypto.mjs';
import {ethereumConsensusFixture} from './helpers/ethereum-consensus-fixture.mjs';
import {attestEthereumExchange} from '../research/ethereum-exchange-observer.mjs';
import {attestExchangeResolution} from '../research/exchange-observer-v2.mjs';
import {collectExchangeObservations} from '../research/exchange-observer-quorum.mjs';
import {BoundedNetworkInterpreter} from '../research/bounded-network-interpreter.mjs';
import {exchangeOutput,checkExchangeConfig} from '../research/exchange-native.mjs';
import {exchangePolicy,EXCHANGE} from '../research/exchange-escrow.mjs';

for(const direction of ['BUY_DUBYT','SELL_DUBYT'])for(const kind of ['PAYOUT','REFUND','CANCELLED'])test(direction+' Ethereum '+kind+': signed evidence, blackout, restart, deterministic native settlement',async()=>{
 const f=ethereumConsensusFixture(direction,kind),o=f.o,dir=fs.mkdtempSync(join(tmpdir(),'ethereum-consensus-'));let db=BoundedNetworkInterpreter.create(dir+'/state.sqlite',f.s,f.c,hash(f.s));
 const step=(cmd,time,inputs=[])=>db.commitBlock({height:db.networkHeader().height+1,time,blockHash:hash([time,cmd]),txs:[f.wire(cmd,inputs,o.payer)]},db.root);
 try{
  step(o.lock,1000,[o.input]);step(o.arm,1010);const root=db.root;
  assert.throws(()=>step({type:'REFUND',id:o.id},12000));assert.equal(db.root,root);
  const clients=f.observers.map(k=>({observer:k.publicKey,read:()=>attestExchangeResolution(f.args,k)}));
  const unavailable=clients.map(c=>({...c,read:()=>Promise.reject(Error('offline'))}));
  await assert.rejects(()=>collectExchangeObservations({policy:f.p,request:f.args.request,clients:unavailable,now:12000,timeoutMs:50}));assert.equal(db.root,root);
  db.close();db=BoundedNetworkInterpreter.open(dir+'/state.sqlite',f.c,root);
  clients[2].read=()=>new Promise(()=>{});
  const receipt=await collectExchangeObservations({policy:f.p,request:f.args.request,clients,now:12000,timeoutMs:1000});
  const cmd={type:'RESOLVE',id:o.id,receipt};step(cmd,12000);const after=db.snapshotForAudit();
  assert.equal(after.exchangeBook.orders[o.id].status,kind==='PAYOUT'?'CLAIMED':'REFUNDED');
  assert.equal(after.money.outputs[exchangeOutput(hash(f.c),o.id,'settlement')].owner,kind==='PAYOUT'?(direction==='BUY_DUBYT'?f.user.publicKey:f.provider.publicKey):o.payer.publicKey);
  assert.equal(after.money.fees,'1000');assert.equal(after.money.supply,'200000000');
  step(cmd,12001);assert.deepEqual(db.snapshotForAudit().money.outputs,after.money.outputs);
  // Independent interpreter replay must produce the same final root.
  const mirror=BoundedNetworkInterpreter.create(dir+'/mirror.sqlite',f.s,f.c,hash(f.s));
  try{for(const [i,[command,time,inputs]]of [[o.lock,1000,[o.input]],[o.arm,1010,[]],[cmd,12000,[]],[cmd,12001,[]]].entries())mirror.commitBlock({height:i+1,time,blockHash:hash([time,command]),txs:[f.wire(command,inputs,o.payer)]},mirror.root);assert.equal(mirror.root,db.root);}finally{mirror.close();}
 }finally{db.close();}
});
test('Ethereum route remains isolated and refuses V1, wrong token/genesis and short deadlines',()=>{
 const f=ethereumConsensusFixture();for(const patch of [{domain:EXCHANGE},{isolated:false},{minGap:60},{chain:'production'}])assert.throws(()=>exchangePolicy({...f.p,...patch}));
 for(const patch of [{contract:'0x'+'9'.repeat(40)},{genesis:hash('other')},{decimals:18}])assert.throws(()=>exchangePolicy({...f.p,routes:{...f.p.routes,USDC:{...f.p.routes.USDC,...patch}}}));
 assert.throws(()=>checkExchangeConfig({...f.c,trialOnly:false}));assert.throws(()=>checkExchangeConfig({...f.c,chainId:'duebyte-live'}));
});
test('observer never signs bare receipts, wrong approvals, unreviewed code or unfinalized outcomes',async()=>{
 const mutations=[f=>f.args.request.userSignature='bad',f=>f.args.pins.codeHash=hash('unreviewed'),f=>f.args.pins.escrows=[],f=>f.d.chain='0x2105',f=>f.d.genesis=hash('other'),f=>f.d.receipt.status='0x0',f=>f.d.receipt.logs[0].data='0x'+'0'.repeat(64),f=>f.d.head.number='0x1f'];
 for(const change of mutations){const f=ethereumConsensusFixture();change(f);await assert.rejects(()=>attestEthereumExchange(f.args,f.observers[0]));}
 const f=ethereumConsensusFixture(),one=await attestEthereumExchange(f.args,f.observers[0]);
 await assert.rejects(()=>collectExchangeObservations({policy:f.p,request:f.args.request,now:12000,timeoutMs:50,clients:f.observers.map(k=>({observer:k.publicKey,read:async()=>one}))}));
});
