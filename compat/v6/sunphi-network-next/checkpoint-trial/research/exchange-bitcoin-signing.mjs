// Regtest qualification adapter. Production route admission remains separate.
// Only native SegWit inputs: signing must not change the pre-armed txid.
import assert from 'node:assert/strict';
import {hash,hex,integer} from '../crypto.mjs';
import {bitcoinAtomic} from './purchase-observer.mjs';
import {coordinatedExternalSigning} from './exchange-signing-coordinator.mjs';
export function bitcoinSigningPlan(tx){
 hex(tx.txid);integer(tx.version,1);integer(tx.locktime);assert(tx.locktime<=0xffffffff);
 assert(Array.isArray(tx.vin)&&tx.vin.length>0&&tx.vin.length<=64);
 const inputs=tx.vin.map(v=>{hex(v.txid);integer(v.vout);integer(v.sequence);assert(v.vout<=0xffffffff&&v.sequence<=0xffffffff);assert.equal(v.scriptSig?.hex,'','native SegWit input required');return {txid:v.txid,index:v.vout,sequence:v.sequence};});
 const resources=inputs.map(v=>'btc-regtest:'+v.txid+':'+v.index);assert.equal(new Set(resources).size,resources.length);
 assert(Array.isArray(tx.vout)&&tx.vout.length>0&&tx.vout.length<=64);
 const outputs=tx.vout.map((v,i)=>{assert.equal(v.n,i);assert(typeof v.scriptPubKey?.hex==='string'&&/^(?:[a-f0-9]{2})+$/.test(v.scriptPubKey.hex));return {atomic:bitcoinAtomic(v.value),script:v.scriptPubKey.hex};});
 return {resources,transaction:tx.txid,body:{version:tx.version,locktime:tx.locktime,inputs,outputs}};
}
export async function coordinatedBitcoinSigning({channel,rpc,genesis,order,purpose,request,unsigned,authorize,sign}){
 assert(channel,'independent Bitcoin signing inventory required');hex(genesis);hex(order);hex(request);assert(['FUNDING','PAYOUT','REFUND','CANCELLED'].includes(purpose));
 const expected=bitcoinSigningPlan(await rpc('decoderawtransaction',[unsigned]));
 return coordinatedExternalSigning(channel,{order,purpose,attempt:0,request:hash([genesis,request,expected])},{
  authorize:async()=>{
   assert.equal((await rpc('getblockchaininfo')).chain,'regtest');assert.equal(await rpc('getblockhash',[0]),genesis);await authorize();
   for(const input of expected.body.inputs){const prev=await rpc('gettxout',[input.txid,input.index,true]);assert(prev,'input already spent or unavailable');assert(['witness_v0_keyhash','witness_v0_scripthash','witness_v1_taproot'].includes(prev.scriptPubKey.type),'native SegWit funding required');}
  },
  plan:async()=>expected,
  sign:async()=>{const raw=await sign();const tx=await rpc('decoderawtransaction',[raw]);return {raw,transaction:tx.txid};},
  inspect:async(s,plan)=>{
   assert.deepEqual(plan,expected,'changed Bitcoin signing plan');const tx=await rpc('decoderawtransaction',[s.raw]);assert.equal(s.transaction,expected.transaction,'Bitcoin txid changed during signing');assert.deepEqual(bitcoinSigningPlan(tx),expected,'Bitcoin transaction terms changed');assert(tx.vin.every(v=>Array.isArray(v.txinwitness)&&v.txinwitness.length>0&&v.txinwitness[0].length>0),'missing Bitcoin witness');
  }
 });
}
