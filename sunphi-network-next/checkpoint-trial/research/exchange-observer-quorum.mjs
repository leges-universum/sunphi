// Reader/observer admission helpers. No mainnet route or signer is activated.
import assert from 'node:assert/strict';
import {hash,verify,hex,integer} from '../crypto.mjs';
import {verifyExchangeResolution} from './exchange-resolution.mjs';
import {bitcoinFinality,baseFinality,ethereumFinality,BASE_USDC,BTC_GENESIS} from './exchange-finality.mjs';
import {evmNetwork} from './exchange-evm-networks.mjs';

// Apply this after exact escrow/asset/recipient inspection and before signing.
// Finality alone does not prove that a transfer belongs to an exchange order.
export async function verifyObservationFinality({body,rpc,now,genesis}){
 hex(genesis);hex(body.transaction);hex(body.block);integer(now);
 assert.equal(body.genesis,genesis);let proof;
 if(body.asset==='BTC'){
  assert.equal(body.network,'bitcoin-mainnet');assert.equal(genesis,BTC_GENESIS);
  proof=await bitcoinFinality(rpc,{transaction:body.transaction,now,genesis});
 }else{
  assert.equal(body.asset,'USDC');
  if(body.network==='ethereum-mainnet'){
   const network=evmNetwork('ETHEREUM');assert.equal(body.contract,network.contract);assert.equal(genesis,network.genesis);
   proof=await ethereumFinality(rpc,{transaction:body.transaction,genesis,now});
  }else{
   assert.equal(body.network,'base-mainnet');assert.equal(body.contract,BASE_USDC);
   proof=await baseFinality(rpc,{transaction:body.transaction,genesis,now});
  }
 }
 assert.equal(proof.transaction,body.transaction);assert.equal(proof.block,body.block,'finality belongs to a different outcome block');
 return proof;
}

// Three configured identities, two matching signed outcomes. A slow, invalid
// or conflicting third reply cannot delay or poison a valid pair. Independent
// operation of these identities must be established outside this algorithm.
export function collectExchangeObservations({policy,request,clients,now,timeoutMs=10000}){
 integer(now);integer(timeoutMs,10);assert(timeoutMs<=30000);
 assert(Array.isArray(clients)&&clients.length===3);
 const identities=new Set();for(const c of clients){assert(policy.observers.includes(c.observer)&&!identities.has(c.observer));identities.add(c.observer);assert(typeof c.read==='function');}
 return new Promise((resolve,reject)=>{
  const controllers=clients.map(()=>new AbortController()),groups=new Map();let settled=false,remaining=3;
  const finish=(receipt)=>{if(settled)return;settled=true;clearTimeout(timer);for(const c of controllers)c.abort();receipt?resolve(receipt):reject(Error('independent observer quorum unavailable'));};
  const timer=setTimeout(()=>finish(),timeoutMs);
  clients.forEach((client,i)=>{
   Promise.resolve().then(()=>client.read(request,{signal:controllers[i].signal})).then(value=>{
    if(settled)return;
    try{
     assert.equal(value.signature.observer,client.observer);assert(verify(value.body,value.signature.signature,client.observer));
     assert.equal(value.body.transaction,request.transaction);assert.equal(value.body.status,request.kind);
     const id=hash(value.body),group=groups.get(id)??[];group.push(value);groups.set(id,group);
     if(group.length>=2){const receipt={body:group[0].body,signatures:group.map(x=>x.signature)};
      verifyExchangeResolution(policy,request.quote,request.arm.plan,receipt,now);finish(receipt);
     }
    }catch{/* Invalid remote data is not a vote and is never logged. */}
   },()=>{}).finally(()=>{remaining--;if(!remaining&&!settled)finish();});
  });
 });
}
