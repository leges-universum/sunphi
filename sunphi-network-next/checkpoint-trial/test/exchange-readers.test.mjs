import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {hash} from '../crypto.mjs';import {BTC_GENESIS} from '../research/exchange-finality.mjs';
import {readOnlyRpc,independentReaders,readFinalityQuorum} from '../research/exchange-readers.mjs';
const transaction=hash('transaction'),block=hash('block'),genesis=hash('base genesis'),tip=hash('tip');
async function server(fn){const s=createServer(async(req,res)=>{try{let body='';for await(const part of req)body+=part;await fn(JSON.parse(body),res);}catch{res.destroy();}});await new Promise(r=>s.listen(0,'127.0.0.1',r));return {url:'http://127.0.0.1:'+s.address().port,close:()=>new Promise(r=>{s.closeAllConnections();s.close(r);})};}
function response(chain,mode='good'){return (q,res)=>{
 let result;if(mode==='offline'){res.writeHead(503);res.end();return;}if(mode==='slow')return;
 if(chain==='BTC'){
  if(q.method==='getblockchaininfo')result={chain:mode==='wrong-chain'?'test':'main',blocks:20,headers:20,initialblockdownload:false,bestblockhash:tip};
  if(q.method==='getblockhash')result=q.params[0]===0?BTC_GENESIS:(mode==='conflict'?hash('fork'):block);
  if(q.method==='getblockheader')result=q.params[0]===tip?{time:9990}:{hash:block,height:15,confirmations:6,time:9900};
  if(q.method==='getrawtransaction')result={txid:transaction,blockhash:block};
 }else{
  if(q.method==='eth_chainId')result=mode==='wrong-chain'?'0x1':'0x2105';
  if(q.method==='eth_getTransactionReceipt')result={transactionHash:'0x'+transaction,blockHash:'0x'+block,blockNumber:'0x1f',status:mode==='revert'?'0x0':'0x1'};
  if(q.method==='eth_getBlockByNumber')result=q.params[0]==='0x0'?{hash:'0x'+genesis}:q.params[0]==='finalized'?{hash:'0x'+tip,number:'0x20',timestamp:mode==='stale'?'0x1':'0x2700'}:{hash:'0x'+(q.params[0]==='0x20'?tip:mode==='conflict'?hash('fork'):block)};
 }res.end(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));};}

for(const chain of ['BTC','BASE'])for(const mode of ['offline','slow','wrong-chain','conflict'])test(chain+' two independent readers survive one '+mode,async()=>{
 const servers=await Promise.all(['good','good',mode].map(m=>server(response(chain,m))));try{
  const sources=servers.map((s,i)=>({url:s.url,id:'reader-'+i,operator:'operator-'+i})),readers=independentReaders(sources,{chain,isolated:true,timeoutMs:400});
  const result=await readFinalityQuorum(readers,{chain,transaction,genesis:chain==='BTC'?BTC_GENESIS:genesis,now:10000,timeoutMs:1000});assert.equal(result.block,block);assert.equal(result.sources.length,2);
 }finally{await Promise.all(servers.map(s=>s.close()));}
});
for(const chain of ['BTC','BASE'])test(chain+' one good reader cannot authorize finality',async()=>{
 const servers=await Promise.all(['good','wrong-chain','offline'].map(m=>server(response(chain,m))));try{const readers=independentReaders(servers.map((s,i)=>({url:s.url,id:'reader-'+i,operator:'operator-'+i})),{chain,isolated:true});await assert.rejects(()=>readFinalityQuorum(readers,{chain,transaction,genesis:chain==='BTC'?BTC_GENESIS:genesis,now:10000}),/quorum unavailable/);}finally{await Promise.all(servers.map(s=>s.close()));}
});
test('Base finalized REVERT is separate from successful payment',async()=>{
 const servers=await Promise.all(['revert','revert','stale'].map(m=>server(response('BASE',m))));try{const readers=independentReaders(servers.map((s,i)=>({url:s.url,id:'reader-'+i,operator:'operator-'+i})),{chain:'BASE',isolated:true});const input={chain:'BASE',transaction,genesis,now:10000};await assert.rejects(()=>readFinalityQuorum(readers,input));assert.equal((await readFinalityQuorum(readers,{...input,outcome:'REVERT'})).outcome,'REVERT');}finally{await Promise.all(servers.map(s=>s.close()));}
});
test('RPC cannot sign, submit, redirect, disclose provider errors or accept oversized/foreign replies',async()=>{
 let calls=0;const s=await server((q,res)=>{calls++;res.end(JSON.stringify({id:q.id,result:'ok'}));});try{const rpc=readOnlyRpc(s.url,{chain:'BTC',isolated:true});await assert.rejects(()=>rpc('sendrawtransaction',['aa']),/read-only/);assert.equal(calls,0);assert.equal(await rpc('getblockhash',[0]),'ok');}finally{await s.close();}
 for(const fn of [(q,r)=>{r.writeHead(302,{Location:'http://127.0.0.1:1/secret'});r.end();},(q,r)=>r.end(JSON.stringify({id:q.id+1,result:'x'})),(q,r)=>r.end(JSON.stringify({id:q.id,error:{message:'SECRET'}})),(q,r)=>r.end('x'.repeat(1000))]){const srv=await server(fn);try{await assert.rejects(()=>readOnlyRpc(srv.url,{chain:'BASE',isolated:true,maxBytes:128})('eth_chainId'),e=>e.message==='read-only source unavailable or invalid');}finally{await srv.close();}}
});
test('full-body stalls time out and cancellation is bounded',async()=>{const s=await server((q,r)=>{r.writeHead(200);r.write('{');});try{await assert.rejects(()=>readOnlyRpc(s.url,{chain:'BASE',isolated:true,timeoutMs:50})('eth_chainId'));const c=new AbortController();c.abort();await assert.rejects(()=>readOnlyRpc(s.url,{chain:'BASE',isolated:true})('eth_chainId',[],{signal:c.signal}));}finally{await s.close();}});

test('exact-state reads are available without admitting signing or arbitrary large parameters',async()=>{
 const seen=[],s=await server((q,r)=>{seen.push(q.method);r.end(JSON.stringify({id:q.id,result:'read'}));});try{
  const btc=readOnlyRpc(s.url,{chain:'BTC',isolated:true}),base=readOnlyRpc(s.url,{chain:'BASE',isolated:true});
  for(const m of ['getblockcount','gettxout'])assert.equal(await btc(m,[]),'read');
  assert.equal(await btc('decoderawtransaction',['ab'.repeat(3000)]),'read');
  for(const m of ['eth_getCode','eth_call'])assert.equal(await base(m,[]),'read');
  const count=seen.length;
  for(const args of [['decoderawtransaction',['ab'.repeat(100001)]],['decoderawtransaction',['zz']],['decoderawtransaction',['aa',true]],['getrawtransaction',['a'.repeat(5000)]],['signrawtransactionwithwallet',['aa']],['sendrawtransaction',['aa']]])await assert.rejects(()=>btc(...args));
  for(const m of ['eth_sendRawTransaction','eth_sign','personal_unlockAccount'])await assert.rejects(()=>base(m,[]));
  assert.equal(seen.length,count);
 }finally{await s.close();}
});
test('duplicate operators/endpoints and insecure production RPC are refused',()=>{
 const sources=[0,1,2].map(i=>({id:'r'+i,operator:'o'+i,url:'https://reader'+i+'.example/rpc'}));assert.equal(independentReaders(sources,{chain:'BTC'}).length,3);
 assert.throws(()=>independentReaders(sources.map((s,i)=>({...s,operator:i===2?'o0':s.operator})),{chain:'BTC'}));assert.throws(()=>independentReaders(sources.map(s=>({...s,url:'https://same.example/'+s.id})),{chain:'BTC'}));
 for(const url of ['http://public.example','http://127.0.0.1','https://u:p@example.com','https://example.com/?key=secret'])assert.throws(()=>readOnlyRpc(url,{chain:'BASE'}));
});
