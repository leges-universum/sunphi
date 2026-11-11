// Loopback-only laboratory harness. All keys, balances and external events are synthetic.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {nativeFixture} from '../test/helpers/purchase-native-fixture.mjs';
import {BoundedNetworkInterpreter} from '../research/bounded-network-interpreter.mjs';
import {orderId} from '../research/purchase-contract.mjs';import {parseToken,formatToken} from '../token-units.mjs';import {exact,hash} from '../crypto.mjs';
const external=(value,decimals)=>{const n=BigInt(value),d=10n**BigInt(decimals),fraction=String(n%d).padStart(decimals,'0').replace(/0+$/,'');return String(n/d)+(fraction?'.'+fraction:'');};
export async function startPurchaseLab(dir,{root=path.resolve(import.meta.dirname,'..')}={}){
 assert(!fs.existsSync(dir),'fresh isolated directory');fs.mkdirSync(dir,{recursive:true});
 const f=nativeFixture(Math.floor(Date.now()/1000)),stores=[0,1,2].map(i=>{
  const db=BoundedNetworkInterpreter.create(path.join(dir,i+'.sqlite'),f.s,f.c,hash(f.s));
  return {store:db.store,get root(){return db.root;},get state(){const s=db.snapshotForAudit(),balances={};for(const o of Object.values(s.money.outputs))if(o.unlock<=s.money.time)balances[o.owner]=String(BigInt(balances[o.owner]??'0')+BigInt(o.value));return {...s.purchaseBook,orders:s.purchaseBook?.orders??{},balances,supplyMicro:s.money.supply};},
   apply(command,time){const s=db.snapshotForAudit(),inputs=command.type==='RESERVE'?Object.entries(s.money.outputs).filter(([,o])=>o.owner===f.seller.publicKey&&o.unlock<=time).map(([id])=>id).sort().slice(0,8):[],height=s.height+1;return db.commitBlock({height,time,blockHash:hash(['purchase-ui',height,time,command]),txs:[f.wire(command,inputs)]},db.root);},close(){db.close();}};
 });
 const commands=[],quotes=new Map();let online=[true,true,true],available=true,unavailable=false,active=null,clock=Math.floor(Date.now()/1000),session=null;
 const now=()=>clock=Math.max(clock,Math.floor(Date.now()/1000));
 const commit=(command,time=now())=>{
  assert(online.filter(Boolean).length>=2,'Laboratory replicas unavailable');
  // Single coordinator with replay replicas, NOT CometBFT consensus qualification.
  const n=commands.length;for(let i=0;i<3;i++)if(online[i]){assert.equal(stores[i].store.meta.sequence,n,'replay lag');stores[i].apply(command,time);}
  commands.push({command,time});assert.equal(new Set(stores.filter((_,i)=>online[i]).map(s=>s.root)).size,1);return stores[online.findIndex(Boolean)].state;
 };
 const current=()=>stores[online.findIndex(Boolean)].state;
 const present=(a,order=false)=>{
  const q=a.offer,r=f.policy.routes[q.route],o=current().orders[orderId(q)];
  const labels={AWAITING_PAYMENT:'Waiting for payment',CONFIRMING:'Confirming payment',PAYMENT_REVIEW:'Payment needs review',LATE_PAYMENT_REVIEW:'Late payment needs a refund',COMPLETED:'DUBYT received',CANCELLED:'Purchase expired without payment',REFUNDED:'Payment refunded'};
  return {id:orderId(q),isolated:true,route:q.route,dubyt:formatToken(q.dubytMicro,'1000000'),payTotal:external(q.payAtomic,r.decimals),fee:external(q.feeAtomic,r.decimals),feeNote:'Your external wallet may charge its own network fee.',seller:f.policy.sellerName,expiresAt:q.quoteUntil,payUntil:q.payUntil,paymentNetwork:r.network,
   refundDestination:q.refundDestination,terms:'Test-only signed payment attestations (2 of 3). Partial, excess or late payments require review and a full confirmed refund. No automatic cross-chain guarantee.',
   ...(order?{status:o.status,statusLabel:labels[o.status],message:o.status==='COMPLETED'?'The reserved DUBYT has been credited once.':o.status==='AWAITING_PAYMENT'?'DUBYT is reserved. Use only the indicated test network.':'Your order is retained. Do not send another payment.',...(o.status==='AWAITING_PAYMENT'?{destination:q.destination}:{})}:{})};
 };
 const state=()=>({locked:false,hasVault:true,working:false,checkedAt:Date.now(),error:null,network:f.policy.network,height:100+commands.length,owner:f.buyer.publicKey,wallets:[{id:'qa',name:'Test wallet'}],activeWallet:'qa',selectedWallet:'qa',unitScale:'1000000',balance:{available:current().balances[f.buyer.publicKey]??'0',display:{available:formatToken(current().balances[f.buyer.publicKey]??'0','1000000'),reserved:'0',scheduled:'0',protected:'0'}},payments:[],features:{},networkTime:now()});
 const server=createServer(async(req,res)=>{try{
  assert.equal(req.headers.host,'127.0.0.1:'+server.address().port);if(req.headers.origin)assert.equal(req.headers.origin,'http://127.0.0.1:'+server.address().port);
  assert(!req.headers['sec-fetch-site']||['same-origin','none'].includes(req.headers['sec-fetch-site']));res.setHeader('Cache-Control','no-store');
  if(req.url==='/'||req.url.startsWith('/brand/')){assert.equal(req.method,'GET');const name=req.url.slice(7);assert(req.url==='/'||/^[a-z0-9.-]+$/.test(name));const file=req.url==='/'?path.join(root,'wallet.html'):path.join(root,'../desktop/brand',name);res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.woff2')?'font/woff2':'text/html');res.end(fs.readFileSync(file));return;}
  const token=req.headers['x-duebyte-token'];assert(typeof token==='string'&&/^[a-f0-9]{64}$/.test(token));session??=token;assert.equal(token,session,'Laboratory session changed');
  if(unavailable&&req.url.startsWith('/purchase/'))throw Error('Simulated route outage');
  let q={};if(req.method==='POST'){let raw='';for await(const chunk of req){raw+=chunk;assert(raw.length<16384);}q=JSON.parse(raw);}else assert.equal(req.url,'/status');
  let result;
  if(req.url==='/status')result=state();
  else if(req.url==='/purchase/availability'){exact(q,[]);result={available,isolated:true,routes:available?[{id:'BTC',label:'Bitcoin · regtest'},{id:'USDC',label:'USDC · local Ethereum'}]:[],reason:available?'Choose your amount. This is an isolated test.':'Purchases are not available. No connected seller.',activeOrder:active?present(active,true):null};}
  else if(req.url==='/purchase/quote'){
   assert(available);exact(q,['amount','route','refundDestination']);assert(['BTC','USDC'].includes(q.route));assert(typeof q.refundDestination==='string'&&q.refundDestination.length>0);const value=BigInt(parseToken(q.amount,'1000000'));assert(value>0n&&value<=BigInt(current().balances[f.seller.publicKey]),'Seller inventory unavailable');assert(quotes.size<32,'laboratory quote limit');
   const pay=q.route==='BTC'?(value+999n)/1000n:(value*125n+999n)/1000n,fee=(pay+99n)/100n;
   const a=f.reserve({route:q.route,refundDestination:q.refundDestination,dubytMicro:String(value),payAtomic:String(pay),feeAtomic:String(fee)},now());quotes.set(orderId(a.offer),a);result=present(a);
  }else if(req.url==='/purchase/accept'){
   exact(q,['id']);const a=quotes.get(q.id);assert(a,'Quote expired or unknown');assert(!active||orderId(active.offer)===q.id,'An existing purchase must be resolved first');
   if(!current().orders[q.id])commit(a);active=a;result=present(a,true);
  }else if(req.url==='/purchase/order'){exact(q,['id']);assert(active&&orderId(active.offer)===q.id);result=present(active,true);}
  else throw Error('Unknown laboratory route');
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
 }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {url:'http://127.0.0.1:'+server.address().port,f,stores,commands,state,current,
  get active(){return active;},setAvailable(value){available=value;},outage(value){unavailable=value;},resetSession(){session=null;},
  disconnect(i){assert(online.filter(Boolean).length>1);online[i]=false;},
  reconnect(i){for(const x of commands.slice(stores[i].store.meta.sequence))stores[i].apply(x.command,x.time);online[i]=true;assert.equal(new Set(stores.map(s=>s.root)).size,1);},
  payment(patch={}){assert(active);clock=now()+1;const received=current().orders[orderId(active.offer)].received[0];return commit(f.evidence(active,{paidAt:received?.paidAt??clock,...patch},clock),clock);},
  next(){assert(active&&['COMPLETED','CANCELLED','REFUNDED'].includes(current().orders[orderId(active.offer)].status));active=null;},
  async close(){await new Promise(r=>server.close(r));stores.forEach(s=>s.close());}
 };
}
