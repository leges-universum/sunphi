// Wallet-owned durable outbox; exchange credentials never enter this process.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {hash,sign,verify,exact,publicKey} from './crypto.mjs';
import {BROKER_API} from './exchange-broker-api.mjs';
import {providerConsent,verifyProviderReview,units,providerPendingStates} from './exchange-provider.mjs';
export function brokerTransport(profile,{testLoopback=false}={}) {
  const u=new URL(profile.url);assert((u.protocol==='https:'||(testLoopback&&u.protocol==='http:'&&u.hostname==='127.0.0.1'))&&u.pathname==='/exchange/v1'&&!u.username&&!u.password&&!u.search&&!u.hash,'authenticated broker URL required');
  return async message=>{
    const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message),redirect:'error',signal:AbortSignal.timeout(20000)});
    assert(r.ok,'Exchange connection unavailable. Check saved operations before retrying.');let size=0;const parts=[];
    for await(const p of r.body){size+=p.length;assert(size<=262144);parts.push(p);}return JSON.parse(Buffer.concat(parts));
  };
}
export class WalletBroker {
  constructor(wallet,{profile,request=brokerTransport(profile),clock=Date.now}) {
    this.wallet=wallet;this.profile=profile;this.request=request;this.clock=clock;this.closed=false;
    this.pin=hash({profile,owner:wallet.key.publicKey});
    assert(profile.providers.length>=1&&profile.providers.length<=4);
    wallet.db.exec(`CREATE TABLE IF NOT EXISTS wallet_broker_outbox (pin TEXT NOT NULL,id TEXT NOT NULL,provider TEXT NOT NULL,review TEXT NOT NULL,consent TEXT,view TEXT NOT NULL,PRIMARY KEY(pin,id));`);
    wallet.db.exec(`CREATE TABLE IF NOT EXISTS wallet_broker_funding (pin TEXT NOT NULL,id TEXT NOT NULL,review TEXT NOT NULL,pid TEXT,PRIMARY KEY(pin,id),UNIQUE(pid));`);
  }
  async remote(action,payload) {
    assert(!this.closed,'Wallet locked.');const body={domain:BROKER_API,scope:this.profile.scope,owner:this.wallet.key.publicKey,at:this.clock(),nonce:randomBytes(32).toString('hex'),action,payload};
    const reply=await this.request({body,signature:sign(body,this.wallet.key.privateKey)});assert(!this.closed,'Wallet changed.');
    exact(reply,['body','signature']);assert.equal(reply.body.domain,BROKER_API+'/REPLY');assert.equal(reply.body.requestHash,hash(body));assert(verify(reply.body,reply.signature,this.profile.key),'Broker reply not authenticated.');return reply.body.result;
  }
  provider(id) {const p=this.profile.providers.find(p=>p.id===id);assert(p,'Provider not trusted.');return p;}
  check(provider,v) {
    const p=this.provider(provider),r=v.review;assert(verifyProviderReview(r,v.signature,p.reviewKey),'Invalid exchange review.');
    assert.equal(r.scope,p.scope);assert.equal(r.provider,p.identity);assert.equal(r.owner,this.wallet.key.publicKey);
    return v;
  }
  save(provider,v) {
    this.check(provider,v);const old=this.wallet.db.prepare('SELECT review FROM wallet_broker_outbox WHERE pin=? AND id=?').get(this.pin,v.review.id);
    if(old)assert.equal(hash(JSON.parse(old.review)),hash(v.review),'Review terms changed.');
    this.wallet.db.prepare(`INSERT INTO wallet_broker_outbox VALUES(?,?,?,?,NULL,?) ON CONFLICT(pin,id) DO UPDATE SET view=excluded.view`)
      .run(this.pin,v.review.id,provider,JSON.stringify(v.review),JSON.stringify(v));return {...v,provider,fundingPid:this.funding(v.review.id)};
  }
  async availability() {const r=await this.remote('availability',{});assert(Array.isArray(r.providers)&&r.providers.length<=4);for(const p of r.providers)this.provider(p.id);return r;}
  async review(q) {
    exact(q,['provider','request','parent']);this.provider(q.provider);
    assert(!this.wallet.db.prepare(`SELECT 1 FROM wallet_broker_outbox WHERE pin=? AND consent IS NOT NULL AND json_extract(view,'$.state') IN (${['REVIEW',...providerPendingStates,'ACTION_REQUIRED'].map(s=>"'"+s+"'").join(',')}) LIMIT 1`).get(this.pin),'Resolve your saved exchange before starting another.');
    const v=this.check(q.provider,await this.remote('review',q));assert.equal(v.review.kind,q.request.kind);assert.equal(v.review.parent,q.parent);
    assert(v.review.expiresAt>this.clock(),'Review expired.');const t=v.review.terms;
    if(q.request.kind==='trade'||q.request.kind==='swap') {assert.equal(t.from.symbol,q.request.from);assert.equal(t.to.symbol,q.request.to);assert.equal(units(t.from.amount),units(q.request.amount));
      if(q.request.kind==='swap'){assert.equal(t.from.network,q.request.fromNetwork);assert.equal(t.to.network,q.request.toNetwork);for(const k of ['flow','address','extraId','refundAddress','refundExtraId'])assert.equal(t[k],q.request[k],'Swap destination or rate changed.');}
    }
    else {assert.equal(t.gross.symbol,q.request.symbol);assert.equal(units(t.gross.amount),units(q.request.amount));for(const k of ['network','methodId','addressId','address','tag','memo'])assert.equal(t[k],q.request[k],'Withdrawal destination changed.');}
    return this.save(q.provider,v);
  }
  async confirm(q) {
    exact(q,['id']);const row=this.wallet.db.prepare('SELECT * FROM wallet_broker_outbox WHERE pin=? AND id=?').get(this.pin,q.id);assert(row,'Review required.');
    const review=JSON.parse(row.review);assert(row.consent||review.expiresAt>this.clock(),'Review expired.');
    const consent=row.consent??sign(providerConsent(review),this.wallet.key.privateKey);
    this.wallet.db.prepare('UPDATE wallet_broker_outbox SET consent=? WHERE pin=? AND id=?').run(consent,this.pin,q.id);
    // Persist before I/O. A timeout retains this exact provider and consent; never reroute.
    try{return this.save(row.provider,await this.remote('accept',{provider:row.provider,id:q.id,consent}));}
    catch(e) {if(this.closed)throw e;const v={...JSON.parse(row.view),state:'UNKNOWN',progress:{label:'Checking saved exchange; do not create another',busy:true,step:2,totalSteps:4,delivered:false},localUncertain:true};this.wallet.db.prepare('UPDATE wallet_broker_outbox SET view=? WHERE pin=? AND id=?').run(JSON.stringify(v),this.pin,q.id);return {...v,provider:row.provider};}
  }
  async status({provider,offset=0}) {
    this.provider(provider);const r=await this.remote('status',{provider,offset});assert.equal(r.provider,provider);assert.equal(r.offset,offset);assert(r.orders.length<=20);
    return {...r,orders:r.orders.map(v=>this.save(provider,v))};
  }
  local(id){const r=this.wallet.db.prepare('SELECT * FROM wallet_broker_outbox WHERE pin=? AND id=?').get(this.pin,id);assert(r,'Saved exchange required.');return r;}
  fundingEnvironment(provider){assert(!this.provider(provider).identity.endsWith(':simulation')||this.wallet.client.config.exchangeLab?.policy?.isolated===true,'Simulated deposits require an isolated exchange-lab wallet.');}
  async fundingReview(q) {
    exact(q,['id','unitScale']);const row=this.local(q.id);assert(row.consent,'Confirm the exchange order first.');
    this.fundingEnvironment(row.provider);
    const old=this.wallet.db.prepare('SELECT pid FROM wallet_broker_funding WHERE pin=? AND id=?').get(this.pin,q.id);assert(!old?.pid,'Deposit already prepared. Follow the original payment in Activity.');
    const v=this.save(row.provider,await this.remote('operation',{provider:row.provider,id:q.id})),d=v.result?.deposit;
    assert(v.review.kind==='swap'&&v.review.terms.from.symbol==='DUBYT','Native deposit required.');
    assert(v.state==='SWAP_WAITING'&&v.result.canDeposit&&!v.errorCode&&v.checkedAt>this.clock()-60000&&d?.validUntil>this.clock()+30000,'Refresh the provider deposit status and deadline.');
    publicKey(d.address);assert.equal(d.extraId,'');assert.equal(d.network,v.review.terms.from.network);assert.equal(units(d.amount),units(v.review.terms.from.amount));
    const quote=await this.wallet.quote(d.amount,q.unitScale);assert(!this.closed,'Wallet changed.');
    const request={recipient:d.address,value:d.amount,unitScale:q.unitScale,protected:false,delayed:false,fee:quote.fee,abortFee:quote.abortFee,...(quote.feeSchedule?{feeSchedule:quote.feeSchedule,partsCount:quote.partsCount}:{})};
    const review={id:q.id,request,quote,provider:row.provider,reference:v.result.reference,expiresAt:Math.min(d.validUntil-10000,this.clock()+30000)};
    this.wallet.db.prepare(`INSERT INTO wallet_broker_funding VALUES(?,?,?,NULL) ON CONFLICT(pin,id) DO UPDATE SET review=excluded.review WHERE pid IS NULL`).run(this.pin,q.id,JSON.stringify(review));
    return review;
  }
  async fund(q) {
    exact(q,['id']);const r=this.wallet.db.prepare('SELECT * FROM wallet_broker_funding WHERE pin=? AND id=?').get(this.pin,q.id);assert(r,'Review the deposit and network fee first.');
    this.fundingEnvironment(this.local(q.id).provider);
    // A repeated confirmation returns the original ID. Normal wallet recovery owns its broadcast.
    if(r.pid)return {id:q.id,pid:r.pid,status:'SAVED_PAYMENT',message:'Follow this existing payment in Activity. Do not fund again.'};
    const review=JSON.parse(r.review);assert(review.expiresAt>this.clock(),'Deposit review expired.');
    const row=this.local(q.id),v=this.save(row.provider,await this.remote('operation',{provider:row.provider,id:q.id}));
    assert(v.state==='SWAP_WAITING'&&v.result?.canDeposit&&!v.errorCode&&v.checkedAt>this.clock()-60000,'Provider deposit not ready.');
    assert.equal(v.result.reference,review.reference);assert.equal(v.result.deposit.address,review.request.recipient);assert(v.result.deposit.validUntil>this.clock()+10000);
    const p=await this.wallet.prepareTokens(review.request,p=>{
      assert(!this.closed&&review.expiresAt>this.clock(),'Deposit consent expired or wallet changed.');
      const changed=this.wallet.db.prepare('UPDATE wallet_broker_funding SET pid=? WHERE pin=? AND id=? AND pid IS NULL AND review=?').run(p.pid,this.pin,q.id,r.review);
      assert.equal(changed.changes,1,'Deposit already prepared or review changed.');
    });
    // Both records were committed atomically before any network broadcast.
    try {const result=await this.wallet.resume(p.pid);return {id:q.id,...result};}
    catch{return {id:q.id,pid:p.pid,status:'RESULT_PENDING',message:'Deposit payment saved. Activity will recover this exact payment.'};}
  }
  funding(id){return this.wallet.db.prepare('SELECT pid FROM wallet_broker_funding WHERE pin=? AND id=?').get(this.pin,id)?.pid??null;}
  cached() {return this.wallet.db.prepare('SELECT id,provider,view,consent FROM wallet_broker_outbox WHERE pin=? ORDER BY rowid DESC LIMIT 80').all(this.pin).map(r=>({...JSON.parse(r.view),provider:r.provider,hasConsent:!!r.consent,fundingPid:this.funding(r.id)}));}
  close(){this.closed=true;}
}
