// Disposable real external chains. Never loads operational keys or public RPCs.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {localRpc} from '../../research/purchase-observer.mjs';
import {until} from './purchase-comet-network.mjs';
export async function bitcoinLab(out,exe){
 assert(!fs.existsSync(out));fs.mkdirSync(out,{recursive:true});const port=35510;let child,rpc,buyer,seller;
 const start=async()=>{const fd=fs.openSync(join(out,'console.log'),'a');child=spawn(exe,['-regtest','-server=1','-listen=0','-connect=0','-dnsseed=0','-discover=0','-txindex=1','-rpcbind=127.0.0.1','-rpcport='+port,'-datadir='+out,'-fallbackfee=0.0002'],{windowsHide:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);
  await until(async()=>{const cookie=fs.readFileSync(join(out,'regtest/.cookie'),'utf8'),client=path=>localRpc('http://127.0.0.1:'+port+path,{headers:{Authorization:'Basic '+Buffer.from(cookie).toString('base64')}});rpc=client('/');await rpc('getblockchaininfo');buyer=client('/wallet/buyer');seller=client('/wallet/seller');});};
 const stop=async()=>{if(child?.exitCode===null){try{await rpc('stop');}catch{}await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);if(child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}}};
 try{await start();await rpc('createwallet',['buyer']);await rpc('createwallet',['seller']);const mining=await buyer('getnewaddress');
  const mine=async n=>{await rpc('setmocktime',[Math.floor(Date.now()/1000)]);for(let left=n;left>0;left-=Math.min(left,5))await rpc('generatetoaddress',[Math.min(left,5),mining]);};
  await mine(101);await buyer('sendtoaddress',[await seller('getnewaddress'),1]);await mine(6);assert.equal((await rpc('getnetworkinfo')).connections,0);
  return {connection:{url:'http://127.0.0.1:'+port,cookieFile:join(out,'regtest/.cookie')},get rpc(){return rpc;},get seller(){return seller;},get buyer(){return buyer;},mine,stop,
   async restart(){await stop();await start();for(const name of ['buyer','seller'])if(!(await rpc('listwallets')).includes(name))await rpc('loadwallet',[name]);},
   async destination(){return seller('getnewaddress');},async refundAddress(){return buyer('getnewaddress');},
   async pay(to,atomic){return buyer('sendtoaddress',[to,Number(BigInt(atomic))/1e8]);},
   async index(txid,to){return (await rpc('getrawtransaction',[txid,true])).vout.find(v=>v.scriptPubKey.address===to).n;},
   genesis:await rpc('getblockhash',[0])};
 }catch(e){await stop();throw e;}
}
export async function evmLab(out,tools,{replicas=0,ethereumCandidate=false}={}){
 const chainId=ethereumCandidate?1:31337;
 assert(!fs.existsSync(out));fs.mkdirSync(out,{recursive:true});const require=createRequire(join(tools,'package.json')),ganache=require('ganache'),ethers=require('ethers'),solc=require('solc'),wallets=Array.from({length:4},()=>ethers.Wallet.createRandom()),addresses=wallets.map(w=>w.address.toLowerCase());let servers=[],gateway;
 assert(Number.isInteger(replicas)&&replicas>=0&&replicas<=2);const genesisTime=new Date(Math.floor(Date.now()/1000)*1000),urls=Array.from({length:replicas+1},(_,i)=>'http://127.0.0.1:'+(35520+i)),clients=urls.map(url=>localRpc(url));
 const start=async()=>{servers=[];for(let i=0;i<=replicas;i++){const server=ganache.server({chain:{chainId,networkId:chainId,hardfork:'shanghai',time:genesisTime},wallet:{accounts:(replicas?wallets.slice(0,1):wallets).map(w=>({secretKey:w.privateKey,balance:'0x3635c9adc5dea00000'}))},database:{dbPath:join(out,'db'+i)},logging:{quiet:true},miner:{timestampIncrement:0}});servers.push(server);await server.listen(35520+i,'127.0.0.1');}};
 let tail=Promise.resolve();const rpc=(method,params=[])=>{const run=async()=>{if(['evm_setTime','evm_mine','evm_setAccountBalance','evm_setAccountCode','eth_sendRawTransaction'].includes(method)){const results=[];for(const client of clients)results.push(await client(method,params));if(method!=='evm_setTime')for(const result of results.slice(1))assert.deepEqual(result,results[0],'replica mutation result');return results[0];}return clients[0](method,params);};const p=tail.then(run);tail=p.catch(()=>{});return p;};
 try{await start();
  if(replicas){gateway=createServer(async(req,res)=>{let id=null;try{let body='',size=0;for await(const part of req){size+=part.length;assert(size<=1048576);body+=part;}const q=JSON.parse(body);id=q.id;assert(['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_getTransactionReceipt','eth_getTransactionByHash','eth_getTransactionCount','eth_call','eth_estimateGas','eth_getBalance','eth_sendRawTransaction'].includes(q.method));res.end(JSON.stringify({jsonrpc:'2.0',id,result:await rpc(q.method,q.params)}));}catch{res.end(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32000,message:'laboratory gateway failure'}}));}});await new Promise(r=>gateway.listen(35529,'127.0.0.1',r));}
  // Observer EVM nodes do not receive the refund/deposit private keys.
  if(replicas)for(const address of addresses.slice(1))await rpc('evm_setAccountBalance',[address,'0x3635c9adc5dea00000']);
  const latest=()=>rpc('eth_getBlockByNumber',['latest',false]);
  const receipt=txid=>until(async()=>{const r=await rpc('eth_getTransactionReceipt',[txid]);assert(r);return r;});
  async function send(w,to,data,gas=500000n){await rpc('evm_setTime',[Date.now()]);const b=await latest(),raw=await w.signTransaction({type:2,chainId,nonce:Number(BigInt(await rpc('eth_getTransactionCount',[w.address,'pending']))),to,data,value:0n,gasLimit:gas,maxFeePerGas:BigInt(b.baseFeePerGas)*2n+1000000000n,maxPriorityFeePerGas:1000000000n});return receipt(await rpc('eth_sendRawTransaction',[raw]));}
  const source=fs.readFileSync(new URL('../contracts/TestUSDC.sol',import.meta.url),'utf8')+(ethereumCandidate?'\ncontract CandidateToken is TestUSDC { constructor(address buyer,uint256 supply) TestUSDC(buyer,supply) {} function mint(address who,uint256 value) external onlyAdmin { balanceOf[who]+=value;totalSupply+=value; } }':''),result=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'TestUSDC.sol':{content:source}},settings:{evmVersion:'shanghai',optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}})));assert(!result.errors?.some(x=>x.severity==='error'));
  const artifact=result.contracts['TestUSDC.sol'][ethereumCandidate?'CandidateToken':'TestUSDC'],abi=new ethers.Interface(artifact.abi),deployment=await send(wallets[0],null,'0x'+artifact.evm.bytecode.object+abi.encodeDeploy([addresses[0],1000000000n]).slice(2),3000000n);assert.equal(deployment.status,'0x1');const contract=ethereumCandidate?'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':deployment.contractAddress.toLowerCase();if(ethereumCandidate){await rpc('evm_setAccountCode',[contract,await rpc('eth_getCode',[deployment.contractAddress,'latest'])]);assert.equal((await send(wallets[0],contract,abi.encodeFunctionData('mint',[addresses[0],1000000000n]))).status,'0x1');}const pins={genesis:(await rpc('eth_getBlockByNumber',['0x0',false])).hash,chainId:'0x'+chainId.toString(16),contract},codeHash=ethers.keccak256(await rpc('eth_getCode',[contract,'latest']));assert.equal(await rpc('net_peerCount'),'0x0');
  return {chainId,rpc,ethers,wallets,addresses,pins,codeHash,receipt,urls,executorUrl:replicas?'http://127.0.0.1:35529':urls[0],async assertReplicas(){const heads=await Promise.all(clients.map(c=>c('eth_getBlockByNumber',['latest',false])));assert.equal(new Set(heads.map(h=>h.hash)).size,1,'EVM replica block hashes');},async restart(){for(const s of servers)await s.close();await start();},async stop(){if(gateway){gateway.closeAllConnections();await new Promise(r=>gateway.close(r));}for(const s of servers)await s.close();},async mine(n=12){for(let i=0;i<n;i++)await rpc('evm_mine');},async pay(to,atomic){const r=await send(wallets[0],contract,abi.encodeFunctionData('transfer',[to,BigInt(atomic)]));assert.equal(r.status,'0x1');return r.transactionHash.slice(2);},async balance(owner){return BigInt(await rpc('eth_call',[{to:contract,data:abi.encodeFunctionData('balanceOf',[owner])},'latest']));}};
 }catch(e){if(gateway){gateway.closeAllConnections();await new Promise(r=>gateway.close(r));}for(const s of servers)await s.close();throw e;}
}
