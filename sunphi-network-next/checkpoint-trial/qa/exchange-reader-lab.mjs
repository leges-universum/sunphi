// Three real validating Bitcoin databases; no mainnet or operational wallets.
import fs from 'node:fs';import assert from 'node:assert/strict';import {join,resolve} from 'node:path';
import {bitcoinLab} from './helpers/purchase-external-networks.mjs';import {bitcoinReplica} from './helpers/purchase-bitcoin-replica.mjs';
import {independentReaders,readFinalityQuorum} from '../research/exchange-readers.mjs';
import {readAnchorQuorum} from '../research/exchange-source-anchor.mjs';
const out=resolve(process.argv[2]),exe=process.argv[3];assert(exe&&!fs.existsSync(out));fs.mkdirSync(out,{recursive:true});let btc,a,b;const checks=[];
const pass=s=>{checks.push(s);console.log('PASS '+s);};
try{
 btc=await bitcoinLab(join(out,'source'),exe);const transaction=await btc.pay(await btc.destination(),'100000');await btc.mine(6);
 a=await bitcoinReplica(join(out,'replica-a'),exe,35540,btc);b=await bitcoinReplica(join(out,'replica-b'),exe,35541,btc);await a.sync();await b.sync();
 const readers=independentReaders([btc,a,b].map((n,i)=>({id:'reader-'+i,operator:'lab-operator-'+i,url:n.connection.url,headers:()=>({authorization:'Basic '+Buffer.from(fs.readFileSync(n.connection.cookieFile,'utf8').trim()).toString('base64')})})),{chain:'BTC',isolated:true,timeoutMs:1500});
 const args=()=>({chain:'BTC',transaction,genesis:btc.genesis,bitcoinChain:'regtest',now:Math.floor(Date.now()/1000),timeoutMs:5000});
 const proof=await readFinalityQuorum(readers,args());assert.equal(proof.sources.length,2);pass('three real databases return canonical six-confirmation agreement');
 const anchor=await readAnchorQuorum(readers,args());assert.equal(anchor.sources.length,2);assert.equal(anchor.settlementAuthorized,false);pass('fresh six-deep canonical source anchor checked twice across real databases');
 await a.stop();await readFinalityQuorum(readers,args());pass('one actual reader outage preserves two-source agreement');
 await b.stop();await assert.rejects(()=>readFinalityQuorum(readers,args()));pass('two actual reader outages stop finality admission');
 await assert.rejects(()=>readAnchorQuorum(readers,args()));pass('two actual reader outages also stop source readiness');
 await a.restart();await b.restart();await a.sync();await b.sync();await readFinalityQuorum(readers,args());pass('both readers restore from their own database');
 await a.rpc('invalidateblock',[proof.block]);await b.rpc('invalidateblock',[proof.block]);await assert.rejects(()=>readFinalityQuorum(readers,args()));pass('two readers with reorganized outcome prevent settlement evidence');
 await a.rpc('reconsiderblock',[proof.block]);await b.rpc('reconsiderblock',[proof.block]);await readFinalityQuorum(readers,args());pass('canonical chain recovery restores agreement');
 await assert.rejects(()=>readFinalityQuorum(readers,{...args(),bitcoinChain:'main'}));pass('regtest cannot pass as Bitcoin mainnet');
 fs.writeFileSync(join(out,'result.json'),JSON.stringify({passed:true,checks,productionChanged:false,issuance:false,scope:'Three local Bitcoin Core databases; isolated source/finality integration, not independent mainnet operators or full exchange qualification.'},null,2));
}finally{await b?.stop();await a?.stop();await btc?.stop();}
