// Isolated relay adapter. The provider wallet signs locally; no remote key input.
import assert from 'node:assert/strict';
import {exact,hash,hex,sign,verify} from '../crypto.mjs';
import {envelope} from '../core.mjs';
import {WalletExchange,EXCHANGE_API} from '../wallet-exchange.mjs';
import {EXCHANGE_ACTION} from './exchange-native.mjs';
import {checkExchangeQuote,exchangeAcceptance} from './exchange-escrow.mjs';
export class ExchangeLabService{
 constructor(wallet,{createQuote,clock=()=>Math.floor(Date.now()/1000)}){
  this.flow=new WalletExchange(wallet,{clock});this.wallet=wallet;this.clock=clock;this.createQuote=createQuote;this.busy=false;this.closed=false;
  assert.equal(wallet.key.publicKey,this.flow.p.provider);this.pin=hash(wallet.client.config);
  wallet.db.exec('CREATE TABLE IF NOT EXISTS exchange_lab_offers(pin TEXT NOT NULL,id TEXT NOT NULL,offer TEXT NOT NULL,wire TEXT,PRIMARY KEY(pin,id))');
 }
 async handle(message){assert(!this.closed&&!this.busy,'Exchange relay is busy or closed.');this.busy=true;
  try{exact(message,['body','signature']);const b=message.body;exact(b,['domain','configHash','owner','action','payload','nonce','at']);assert.equal(b.domain,EXCHANGE_API);assert.equal(b.configHash,this.pin);hex(b.nonce);assert(Number.isSafeInteger(b.at)&&Math.abs(this.clock()-b.at)<=60);assert(verify(b,message.signature,b.owner),'Invalid wallet request signature.');
   const {state}=await this.flow.current();assert(!this.closed);const c=this.wallet.client.config,p=c.exchangeLab.policy;
   if(b.action==='quote'){
    const r=b.payload;exact(r,['direction','asset','dubytAtomic','address']);assert(['BUY_DUBYT','SELL_DUBYT'].includes(r.direction)&&['BTC','USDC'].includes(r.asset));
    assert(this.wallet.db.prepare('SELECT count(*) AS n FROM exchange_lab_offers WHERE pin=?').get(this.pin).n<32,'Isolated offer capacity reached.');
    const quote=await this.createQuote(b.owner,structuredClone(r),state.money.time);assert(!this.closed);checkExchangeQuote(p,quote,state.money.time);checkExchangeQuote(p,quote,this.clock());assert.equal(quote.user,b.owner);for(const field of ['direction','asset','dubytAtomic'])assert.equal(quote[field],r[field]);assert.equal(quote[r.direction==='BUY_DUBYT'?'externalRefund':'externalRecipient'],r.address);
    if(r.direction==='BUY_DUBYT')this.flow.funding(state,quote);
    const offer={quote,providerSignature:sign(quote,this.wallet.key.privateKey)};this.wallet.db.prepare('INSERT INTO exchange_lab_offers VALUES(?,?,?,NULL)').run(this.pin,hash(quote),JSON.stringify(offer));return offer;
   }
   assert.equal(b.action,'accept');const command=b.payload;exact(command,['type','quote','providerSignature','userSignature']);assert.equal(command.type,'LOCK');const quote=command.quote,id=hash(quote);assert.equal(quote.direction,'BUY_DUBYT');assert.equal(quote.user,b.owner);assert(verify(exchangeAcceptance(quote),command.userSignature,b.owner));
   const row=this.wallet.db.prepare('SELECT * FROM exchange_lab_offers WHERE pin=? AND id=?').get(this.pin,id);assert(row,'Unknown locally offered exchange.');assert.deepEqual(JSON.parse(row.offer),{quote,providerSignature:command.providerSignature});
   const order=state.exchangeBook?.orders[id];if(order){assert.deepEqual(order.quote,quote);return {id,status:order.status};}
   checkExchangeQuote(p,quote,state.money.time);checkExchangeQuote(p,quote,this.clock());
   let wire=row.wire&&JSON.parse(row.wire);if(!wire){wire=envelope(c,{type:EXCHANGE_ACTION,command,inputs:this.flow.funding(state,quote)},this.wallet.key);this.wallet.db.prepare('UPDATE exchange_lab_offers SET wire=? WHERE pin=? AND id=?').run(JSON.stringify(wire),this.pin,id);}
   await this.wallet.broadcast(wire);return {id,status:'SUBMITTED'};
  }finally{this.busy=false;}
 }
 close(){this.closed=true;this.flow.close();}
}
