// Disposable IPC worker: one signing key, one locally pinned RPC pair per process.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {readOnlyRpc} from '../../research/exchange-readers.mjs';
import {attestExchange} from '../../research/exchange-observer.mjs';
import {attestExchangeResolution} from '../../research/exchange-observer-v2.mjs';
import {EXCHANGE_V2} from '../../research/exchange-resolution.mjs';
import {attestCandidate} from './ethereum-candidate-observer.mjs';
let config,busy=false;
process.on('disconnect',()=>process.exit(0));
process.on('message',async message=>{
 try{
  if(message.type==='init'){assert(!config);config=message.config;assert(config.policy.isolated);process.send({ready:true});return;}
  assert(config&&!busy,'observer unavailable');busy=true;
  const account=config.rpc[message.request.quote.asset];
  // Each attester inspects the exact outcome using its own configured database.
  // Bounded read-only transport cannot broadcast, redirect or wait indefinitely.
  const rpc=readOnlyRpc(account.url,{chain:message.request.quote.asset==='BTC'?'BTC':'BASE',isolated:config.policy.isolated,headers:()=>account.cookieFile?{authorization:'Basic '+Buffer.from(fs.readFileSync(account.cookieFile,'utf8').trim()).toString('base64')}:{}});
  // Common wall-clock bucket allows independent receipts to form one quorum.
  const now=Math.floor(Date.now()/10000)*10;
  const attest=account.pins.ethereumCandidate?attestCandidate:config.policy.domain===EXCHANGE_V2?attestExchangeResolution:attestExchange;
  const result=await attest({policy:config.policy,pins:account.pins,rpc,request:message.request,now},config.key);
  process.send({id:message.id,result});
 }catch(e){process.send({id:message.id,error:e.message});}finally{busy=false;}
});
