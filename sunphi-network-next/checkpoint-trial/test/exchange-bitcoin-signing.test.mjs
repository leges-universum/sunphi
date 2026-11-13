import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import {join} from 'node:path';import {randomBytes} from 'node:crypto';
import {hash} from '../crypto.mjs';import {resolutionFixture} from './helpers/exchange-resolution-fixture.mjs';
import {SigningCoordinator,coordinatorChannel} from '../research/exchange-signing-coordinator.mjs';
import {bitcoinSigningPlan,coordinatedBitcoinSigning} from '../research/exchange-bitcoin-signing.mjs';
function fixture(){
 const config=resolutionFixture().c,key=randomBytes(32),file=join(fs.mkdtempSync(join(os.tmpdir(),'btc-coordination-')),'ledger.sqlite');let c=new SigningCoordinator(file,{config,key,create:true}),channel=coordinatorChannel(c,c.activate()),count=0,spent=false;
 const tx={txid:hash('funding'),version:2,locktime:0,vin:[{txid:hash('input'),vout:0,sequence:0xfffffffe,scriptSig:{hex:''}}],vout:[{n:0,value:0.001,scriptPubKey:{hex:'0014'+'00'.repeat(20)}}]},signed=structuredClone(tx);signed.vin[0].txinwitness=['abcd','02'];
 const rpc=async(m,p)=>{if(m==='decoderawtransaction')return structuredClone(p[0]==='00'?tx:signed);if(m==='getblockchaininfo')return {chain:'regtest'};if(m==='getblockhash')return hash('genesis');if(m==='gettxout')return spent?null:{scriptPubKey:{type:'witness_v0_keyhash'}};throw Error('unexpected method');};
 const args={rpc,genesis:hash('genesis'),order:hash('order'),purpose:'FUNDING',request:hash('terms'),unsigned:'00',authorize:async()=>{},sign:async()=>{count++;return 'abcd';}};
 return {tx,signed,args,count:()=>count,spent:()=>spent=true,run:a=>coordinatedBitcoinSigning({...args,channel,...a}),restart:()=>{c.close();c=new SigningCoordinator(file,{config,key});channel=coordinatorChannel(c,c.activate());},close:()=>c.close()};
}
test('Bitcoin funding reserves inputs before signature and reuses committed bytes after restart',async()=>{
 const f=fixture();try{const s=await f.run();await assert.rejects(f.run({purpose:'CANCELLED'}),/UNIQUE/);await assert.rejects(f.run({genesis:hash('wrong')}));f.spent();f.restart();assert.deepEqual(await f.run(),s);assert.equal(f.count(),1);await assert.rejects(f.run({purpose:'CANCELLED'}));assert.equal(f.count(),1);}finally{f.close();}
});
test('unsigned cancellation blocks later funding and preserves input ownership',async()=>{
 const f=fixture();try{await f.run({purpose:'CANCELLED'});await assert.rejects(f.run(),/terminal action/);assert.equal(f.count(),1);await assert.rejects(f.run({order:hash('other')}),/UNIQUE/);}finally{f.close();}
});
test('Bitcoin output mutation or missing witness cannot escape; uncertain intent remains blocked',async()=>{
 const f=fixture();try{f.signed.vout[0].value=0.002;await assert.rejects(f.run(),/terms changed/);f.signed.vout[0].value=0.001;await assert.rejects(f.run(),/uncertain/);assert.equal(f.count(),1);}finally{f.close();}
 const g=fixture();try{g.signed.vin[0].txinwitness=[];await assert.rejects(g.run(),/missing Bitcoin witness/);}finally{g.close();}
});
test('unavailable inputs and wrong network fail before invoking the Bitcoin key',async()=>{
 const f=fixture();try{await assert.rejects(f.run({genesis:hash('wrong')}));f.spent();await assert.rejects(f.run(),/unavailable/);assert.equal(f.count(),0);}finally{f.close();}
});
test('Bitcoin planner rejects legacy inputs, duplicates and negative outputs',()=>{
 const f=fixture();try{f.tx.vin[0].scriptSig.hex='00';assert.throws(()=>bitcoinSigningPlan(f.tx));f.tx.vin[0].scriptSig.hex='';f.tx.vin.push({...f.tx.vin[0]});assert.throws(()=>bitcoinSigningPlan(f.tx));f.tx.vin.pop();f.tx.vout[0].value=-1;assert.throws(()=>bitcoinSigningPlan(f.tx));}finally{f.close();}
});
