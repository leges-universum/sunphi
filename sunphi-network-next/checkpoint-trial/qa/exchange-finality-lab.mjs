// Actual disposable Bitcoin regtest. Never connects to Bitcoin or Base mainnet.
import fs from 'node:fs';import assert from 'node:assert/strict';import {join,resolve} from 'node:path';
import {bitcoinLab} from './helpers/purchase-external-networks.mjs';
import {bitcoinFinality} from '../research/exchange-finality.mjs';
const out=resolve(process.argv[2]),exe=process.argv[3];assert(exe&&!fs.existsSync(out));fs.mkdirSync(out,{recursive:true});
let btc;const passed=[];const pass=s=>{passed.push(s);console.log('PASS '+s);};
try{
 btc=await bitcoinLab(join(out,'btc'),exe);const tx=await btc.pay(await btc.destination(),'100000');
 const check=()=>bitcoinFinality(btc.rpc,{transaction:tx,genesis:btc.genesis,chain:'regtest',now:Math.floor(Date.now()/1000)});
 await assert.rejects(check);pass('mempool transaction is not final');
 await btc.mine(5);await assert.rejects(check);pass('five confirmations cannot satisfy the six-confirmation candidate policy');
 await btc.mine(1);const verified=await check();assert.equal(verified.confirmations,6);pass('six canonical confirmations accepted');
 await btc.rpc('invalidateblock',[verified.block]);await assert.rejects(check);pass('reorganized outcome cannot settle');
 await btc.rpc('reconsiderblock',[verified.block]);await btc.mine(1);await check();pass('recovery on restored canonical chain');
 await btc.restart();await check();pass('reader restart preserves verification');
 await assert.rejects(()=>bitcoinFinality(btc.rpc,{transaction:tx,now:Math.floor(Date.now()/1000)}));pass('regtest cannot impersonate Bitcoin mainnet');
 fs.writeFileSync(join(out,'result.json'),JSON.stringify({passed:true,checks:passed,isolated:true,productionChanged:false,issuance:false,scope:'Actual Bitcoin regtest only. Base finality uses separate modeled RPC tests; no Base mainnet qualification.'},null,2));
}finally{await btc?.stop();}
