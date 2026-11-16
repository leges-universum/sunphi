import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {hash} from '../../crypto.mjs';
import {CHECKPOINT} from '../../checkpoint.mjs';
import {VerifiedClient} from '../../client.mjs';
import {Wallet} from '../../wallet.mjs';
import {WalletExchange,exchangeLabTransport} from '../../wallet-exchange.mjs';
import {ExchangeLabService} from '../../research/exchange-lab-service.mjs';
import {purchaseCometNetwork,until} from './purchase-comet-network.mjs';
export async function exchangeCometWallets(out,f,{admitOrder}={}){
 // Policy signers here are disposable validator keys, never operational keys.
 f.c.control.policy.members=f.validators.slice(0,4).map((k,i)=>({key:k.publicKey,group:hash(['policy',i])}));
 const net=await purchaseCometNetwork(out,f,{walletReady:true}),wallets=[];let flow,service,server,offered;
 const close=async()=>{flow?.close();service?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}for(const w of wallets){w.db.close();w.client.close();}await net.close();};
 try{
  const genesisFile=join(net.homes[0],'config/genesis.json'),genesis=JSON.parse(fs.readFileSync(genesisFile)),policy={domain:CHECKPOINT+'/POLICY',network:f.c.chainId,genesisHash:hash(genesis),...f.c.control.policy};
  for(const [name,key]of [['provider',f.provider],['user',f.user]]){
   const home=join(out,name);fs.mkdirSync(home);
   const client=new VerifiedClient({home,config:f.c,policy,genesisFile,binary:resolve(import.meta.dirname,'../../build/duebyte-abci'+(process.platform==='win32'?'.exe':'')),bounded:net.walletTrust.bounded});
   wallets.push(new Wallet({client,key,home,routes:{},url:'http://127.0.0.1:36001',checkpoint:net.walletTrust.checkpoint}));
  }
  const [provider,user]=wallets;
  for(const wallet of wallets)await until(()=>wallet.view());
  service=new ExchangeLabService(provider,{createQuote:async()=>offered,admitOrder});
  server=createServer(async(req,res)=>{try{assert.equal(req.method,'POST');let size=0,parts=[];for await(const p of req){size+=p.length;assert(size<16384);parts.push(p);}const result=await service.handle(JSON.parse(Buffer.concat(parts)));res.setHeader('content-type','application/json');res.end(JSON.stringify(result));}catch(e){console.error('Laboratory relay:',e.message);res.writeHead(400);res.end(JSON.stringify({error:e.message}));}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const reopen=()=>{flow?.close();flow=new WalletExchange(user,{request:exchangeLabTransport({configHash:hash(f.c),url:'http://127.0.0.1:'+server.address().port+'/'},f.c)});};reopen();
  return {net,close,reopen,get flow(){return flow;},
   async lock(q){await until(async()=>assert(net.state().money.time>q.createdAt));offered=q;const review=await flow.quote({direction:q.direction,asset:q.asset,amount:'10.000001',address:q[q.direction==='BUY_DUBYT'?'externalRefund':'externalRecipient']});await flow.confirm({id:review.review});await until(async()=>assert.equal((await flow.status()).orders.find(o=>o.id===hash(q))?.status,'LOCKED'));},
   async apply(command){const observedAt=(command.funding??command.settlement)?.body.observedAt;if(observedAt)await until(async()=>assert(net.state().money.time>=observedAt));await net.submit(f.wire(command));await until(async()=>assert.equal((await flow.status()).orders.find(o=>o.id===command.id)?.status,command.type==='CLAIM'?'CLAIMED':'REFUNDED'));},
   async balances(){const values=[];for(const w of wallets){const {state}=await w.view();values.push(Object.values(state.money.outputs).filter(o=>o.owner===w.key.publicKey&&o.unlock<=state.money.time).reduce((n,o)=>n+BigInt(o.value),0n).toString());}return values;}
  };
 }catch(e){await close();throw e;}
}
