// Isolated, authenticated seller API. Consensus remains the escrow authority.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {hash,hex,exact,publicKey,verify,integer} from '../crypto.mjs';
import {checkPurchaseConfig} from './purchase-native.mjs';
import {PURCHASE,acceptance,verifyPurchaseOffer,orderId} from './purchase-contract.mjs';
import {purchaseTransport,securePurchaseRequest} from './purchase-transport.mjs';
export const API_DOMAIN=PURCHASE+'/API';
export function isolatedPurchaseConfig(config){
 assert(config.purchaseLab,'protected purchase admission disabled');checkPurchaseConfig(config);
 assert.equal(config.trialOnly,true);return config.purchaseLab.policy;
}
export function loopbackPurchaseURL(value){
 const u=new URL(value);assert(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/','loopback purchase endpoint required');return u;
}
export function refundAddress(route,address){
 assert(typeof address==='string');
 if(route==='BTC'&&address.startsWith('BCRT1')&&address===address.toUpperCase())address=address.toLowerCase();
 // Syntax only. Seller's route adapter must also validate the actual address.
 assert(route==='BTC'?/^(bcrt1[ac-hj-np-z02-9]{8,87}|[mn2][1-9A-HJ-NP-Za-km-z]{25,61})$/.test(address):route==='USDC'&&/^0x[a-fA-F0-9]{40}$/.test(address)&&!/^0x0{40}$/.test(address),'Enter a refund address on the selected test network.');
 return route==='USDC'?address.toLowerCase():address;
}
export class PurchaseBroker {
 constructor({file,config,quote,prepare,submit,proof,clock=()=>Math.floor(Date.now()/1000)}){
  this.policy=isolatedPurchaseConfig(config);this.configHash=hash(config);
  this.lease=new DatabaseSync(file+'.lease');
  try{this.lease.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');this.db=new DatabaseSync(file);
   this.db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS meta(config TEXT NOT NULL); CREATE TABLE IF NOT EXISTS quotes(request TEXT PRIMARY KEY,id TEXT UNIQUE NOT NULL,buyer TEXT NOT NULL,quote TEXT NOT NULL,wire TEXT);');
   const pin=this.db.prepare('SELECT config FROM meta').get();if(pin)assert.equal(pin.config,this.configHash);else this.db.prepare('INSERT INTO meta VALUES(?)').run(this.configHash);
  }catch(e){this.db?.close();this.lease.close();throw e;}
  Object.assign(this,{quote,prepare,submit,proof,clock});this.busy=false;
 }
 async handle(request){
  assert(!this.busy,'Seller busy; retry the same order.');this.busy=true;
  try{
   exact(request,['body','signature']);const b=request.body;exact(b,['domain','configHash','buyer','action','payload','nonce','at']);
   assert.equal(b.domain,API_DOMAIN);assert.equal(b.configHash,this.configHash);publicKey(b.buyer);hex(b.nonce);integer(b.at);
   assert(Math.abs(this.clock()-b.at)<=60,'request expired');assert(verify(b,request.signature,b.buyer),'buyer request signature');
   const p=b.payload;
   if(b.action==='quote'){
    exact(p,['dubytMicro','route','refundDestination']);assert(/^[1-9][0-9]{0,17}$/.test(p.dubytMicro));assert.equal(refundAddress(p.route,p.refundDestination),p.refundDestination,'canonical refund address required');
    const requestId=hash(b),prior=this.db.prepare('SELECT quote FROM quotes WHERE request=?').get(requestId);if(prior)return JSON.parse(prior.quote);
    assert(this.db.prepare('SELECT count(*) AS n FROM quotes').get().n<64,'isolated quote capacity reached');
    const q=await this.quote({...p,buyer:b.buyer});exact(q,['offer','sellerSignature']);verifyPurchaseOffer(this.policy,q.offer,q.sellerSignature,this.clock());
    for(const k of ['dubytMicro','route','refundDestination'])assert.equal(q.offer[k],p[k]);assert.equal(q.offer.buyer,b.buyer);
    this.db.prepare('INSERT INTO quotes VALUES(?,?,?,?,NULL)').run(requestId,orderId(q.offer),b.buyer,JSON.stringify(q));return q;
   }
   assert(['accept','order'].includes(b.action),'unknown purchase action');exact(p,b.action==='accept'?['id','buyerSignature']:['id']);hex(p.id);
   const row=this.db.prepare('SELECT * FROM quotes WHERE id=? AND buyer=?').get(p.id,b.buyer);assert(row,'unknown buyer order');const q=JSON.parse(row.quote);
   if(b.action==='accept'){
    assert(verify(acceptance(this.policy,q.offer),p.buyerSignature,b.buyer),'buyer acceptance required');
    if(!row.wire){
     verifyPurchaseOffer(this.policy,q.offer,q.sellerSignature,this.clock());
     const wire=await this.prepare({type:'RESERVE',...q,buyerSignature:p.buyerSignature});
     assert(Buffer.isBuffer(wire)&&wire.length>0&&wire.length<=262144,'bounded reservation wire');
     // Durable bytes before any broadcast: timeout/restart cannot create a new order.
     row.wire=wire.toString('base64');this.db.prepare('UPDATE quotes SET wire=? WHERE id=?').run(row.wire,p.id);
    }
    await this.submit(Buffer.from(row.wire,'base64'),p.id);
   }
   assert(row.wire,'reservation has not been accepted');return {proof:await this.proof(p.id)};
  }finally{this.busy=false;}
 }
 close(){this.db.close();this.lease.close();}
}
export async function servePurchaseBroker(broker,{onError=()=>{}}={}){
 const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
  try{
   assert.equal(req.headers.host,'127.0.0.1:'+server.address().port);assert.equal(req.method,'POST');assert.equal(req.url,'/');
   assert(!req.headers.origin,'browser access is not admitted');
   let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;assert(size<=16384,'request too large');chunks.push(chunk);}
   res.end(JSON.stringify(await broker.handle(JSON.parse(Buffer.concat(chunks)))));
  }catch(e){onError(e);res.statusCode=400;res.end(JSON.stringify({error:'Purchase could not be verified. Retry the existing order; do not send another payment.'}));}
 });
 server.requestTimeout=15000;await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {url:'http://127.0.0.1:'+server.address().port+'/',close:()=>new Promise(r=>{server.close(r);server.closeIdleConnections();})};
}
export async function purchaseRequest(url,request,transport=null){
 if(transport){purchaseTransport(transport);assert.equal(transport.url,url);return securePurchaseRequest(transport,request);}
 loopbackPurchaseURL(url);const response=await fetch(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(60000)});
 const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>4*1024*1024){await response.body.cancel().catch(()=>{});throw Error('Purchase response too large.');}chunks.push(chunk);}
 const data=JSON.parse(Buffer.concat(chunks));assert(response.ok&&!data.error,data.error??'Purchase API unavailable.');return data;
}
