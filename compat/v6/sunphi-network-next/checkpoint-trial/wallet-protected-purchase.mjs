// Wallet-owned protected purchase journal. Live networks remain closed; only pinned labs.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {hash,hex,exact,sign} from './crypto.mjs';
import {parseToken,formatToken} from './token-units.mjs';
import {acceptance,orderId,verifyPurchaseOffer} from './research/purchase-contract.mjs';
import {API_DOMAIN,isolatedPurchaseConfig,loopbackPurchaseURL,purchaseRequest,refundAddress} from './research/purchase-api.mjs';
import {purchaseTransport} from './research/purchase-transport.mjs';
const terminal=new Set(['COMPLETED','CANCELLED','REFUNDED']);
const decimal=(v,n)=>{const a=BigInt(v),d=10n**BigInt(n),f=String(a%d).padStart(n,'0').replace(/0+$/,'');return String(a/d)+(f?'.'+f:'');};
export class WalletPurchase {
 constructor({file,config,key,reader,url,transport=null,clock=()=>Math.floor(Date.now()/1000)}){
  this.policy=isolatedPurchaseConfig(config);if(transport){purchaseTransport(transport);assert.equal(transport.url,url);}else loopbackPurchaseURL(url);this.configHash=hash(config);
  assert.equal(reader.configHash,this.configHash);assert.deepEqual(reader.policy,this.policy);
  Object.assign(this,{key,reader,url,clock});this.transport=transport?structuredClone(transport):null;this.closed=false;this.busy=false;
  this.lease=new DatabaseSync(file+'.lease');
  try{this.lease.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');this.db=new DatabaseSync(file);this.db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS identity(pin TEXT NOT NULL); CREATE TABLE IF NOT EXISTS purchases(id TEXT PRIMARY KEY,quote TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 0);');
   const pin=hash({configHash:this.configHash,buyer:key.publicKey}),saved=this.db.prepare('SELECT pin FROM identity').get();
   if(saved)assert.equal(saved.pin,pin,'purchase journal belongs to another wallet or chain');else this.db.prepare('INSERT INTO identity VALUES(?)').run(pin);
  }catch(e){this.db?.close();this.lease.close();throw e;}
 }
 async request(action,payload){
  assert(!this.closed,'Wallet locked.');const body={domain:API_DOMAIN,configHash:this.configHash,buyer:this.key.publicKey,action,payload,nonce:randomBytes(32).toString('hex'),at:this.clock()};
  const result=await purchaseRequest(this.url,{body,signature:sign(body,this.key.privateKey)},this.transport);assert(!this.closed,'Wallet locked.');return result;
 }
 present(q,order=null){
  const o=q.offer,r=this.policy.routes[o.route],labels={AWAITING_PAYMENT:'Waiting for payment',CONFIRMING:'Confirming payment',PAYMENT_REVIEW:'Payment needs review',LATE_PAYMENT_REVIEW:'Late payment needs a refund',COMPLETED:'DUBYT received',CANCELLED:'Purchase expired without payment',REFUNDED:'Payment refunded'};
  return {id:orderId(o),isolated:true,route:o.route,dubyt:formatToken(o.dubytMicro,'1000000'),payTotal:decimal(o.payAtomic,r.decimals),fee:decimal(o.feeAtomic,r.decimals),feeNote:'Your external wallet may charge its own network fee.',seller:this.policy.sellerName,expiresAt:o.quoteUntil,payUntil:o.payUntil,paymentNetwork:r.network,refundDestination:o.refundDestination,
   terms:'Isolated test assets only. Payment observations require 2 of 3 pinned observers. Partial, excess or late payments require review and a confirmed refund.',
   ...(order?{status:order.status,statusLabel:labels[order.status],message:order.status==='AWAITING_PAYMENT'?'DUBYT is reserved. Pay once, using only the indicated test network.':'Your order is retained. Do not send another payment.',...(order.status==='AWAITING_PAYMENT'&&this.clock()<o.payUntil?{destination:o.destination}:{})}:{})};
 }
 async readOrder(row,accept=false){
  const q=JSON.parse(row.quote),payload={id:row.id};if(accept)payload.buyerSignature=sign(acceptance(this.policy,q.offer),this.key.privateKey);
  const response=await this.request(accept?'accept':'order',payload);exact(response,['proof']);
  const order=this.reader.read(response.proof,row.id);assert.deepEqual(order.offer,q.offer,'committed order differs from approved terms');assert.equal(order.offer.buyer,this.key.publicKey);
  return this.present(q,order);
 }
 async handle(action,payload){
  assert(!this.busy&&!this.closed,'Purchase busy or wallet locked.');this.busy=true;
  try{
   if(action==='availability'){
    exact(payload,[]);const active=this.db.prepare('SELECT * FROM purchases WHERE active=1').get();
    // Retry the exact signed acceptance if its reply was lost. Never make a new quote.
    let order=null;if(active){try{order=await this.readOrder(active);}catch(e){assert(!this.closed,'Wallet locked.');order=await this.readOrder(active,true);}}
    return {available:true,isolated:true,routes:[{id:'BTC',label:'Bitcoin / regtest'},{id:'USDC',label:'USDC / local Ethereum'}],reason:'Isolated test. Choose an amount and a refund address on the selected network.',activeOrder:order};
   }
   if(action==='quote'){
    exact(payload,['amount','route','refundDestination']);refundAddress(payload.route,payload.refundDestination);
    const active=this.db.prepare('SELECT * FROM purchases WHERE active=1').get();if(active){const status=await this.readOrder(active);assert(terminal.has(status.status),'Resolve your existing purchase first.');}
    const requested={dubytMicro:parseToken(payload.amount,'1000000'),route:payload.route,refundDestination:refundAddress(payload.route,payload.refundDestination)};assert(BigInt(requested.dubytMicro)>0n);
    const q=await this.request('quote',requested);exact(q,['offer','sellerSignature']);verifyPurchaseOffer(this.policy,q.offer,q.sellerSignature,this.clock());
    assert.equal(q.offer.buyer,this.key.publicKey);for(const k of Object.keys(requested))assert.equal(q.offer[k],requested[k],'seller changed requested terms');
    assert(this.db.prepare('SELECT count(*) AS n FROM purchases').get().n<64,'isolated journal capacity reached');
    this.db.prepare('INSERT OR IGNORE INTO purchases VALUES(?,?,0)').run(orderId(q.offer),JSON.stringify(q));return this.present(q);
   }
   assert(['accept','order'].includes(action));exact(payload,['id']);hex(payload.id);
   const row=this.db.prepare('SELECT * FROM purchases WHERE id=?').get(payload.id);assert(row,'Unknown purchase.');
   if(action==='order'){assert.equal(row.active,1);return await this.readOrder(row);}
   const prior=this.db.prepare('SELECT * FROM purchases WHERE active=1').get();
   if(prior&&prior.id!==row.id){const state=await this.readOrder(prior);assert(terminal.has(state.status),'Resolve your existing purchase first.');}
   if(!row.active){const q=JSON.parse(row.quote);verifyPurchaseOffer(this.policy,q.offer,q.sellerSignature,this.clock());
    this.db.exec('BEGIN IMMEDIATE');try{this.db.exec('UPDATE purchases SET active=0');this.db.prepare('UPDATE purchases SET active=1 WHERE id=?').run(row.id);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}
   return await this.readOrder(row,true);
  }finally{this.busy=false;if(this.closed)this.dispose();}
 }
 close(){this.closed=true;this.key=null;if(!this.busy)this.dispose();}
 dispose(){this.db?.close();this.db=null;this.lease?.close();this.lease=null;this.reader?.close();this.reader=null;}
}
