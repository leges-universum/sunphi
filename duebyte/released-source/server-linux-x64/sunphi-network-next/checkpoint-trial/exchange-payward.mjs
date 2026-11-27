// Payward Services V2, NOT Kraken Spot /0/private authentication.
// Reference: docs.services.payward.com (OpenAPI snapshot reviewed 2026-11-16).
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {canonical,exact} from './crypto.mjs';
import {decimal,units} from './exchange-provider.mjs';

const hosts={sandbox:'https://api.sandbox.services.payward.com',production:'https://api.services.payward.com'};
const assetTypes={BTC:'crypto',USDC:'stablecoin',USDT:'stablecoin',XMR:'crypto',DUBYT:'crypto'};
const id=x=>{assert(typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x),'invalid provider identifier');return encodeURIComponent(x);};
const asset=x=>{assert(assetTypes[x],'unsupported asset');return {symbol:x,type:assetTypes[x]};};
function amount(a) { assert(a&&a.type===assetTypes[a.symbol],'asset mismatch'); return {...asset(a.symbol),amount:decimal(a.amount)}; }

export function paywardSignature(secret,timestamp,method,path,body='') {
  assert(typeof secret==='string'&&Buffer.from(secret,'base64').toString('base64')===secret,'base64 API secret required');
  assert(/^\d{13}$/.test(String(timestamp)));
  const digest=createHash('sha256').update(body,'utf8').digest('hex').toUpperCase();
  return createHmac('sha512',Buffer.from(secret,'base64')).update(`${timestamp}\n${method.toUpperCase()}\n${path}\n${digest}`,'utf8').digest('base64');
}
export class PaywardError extends Error {
  constructor(status=0,retryAfterMs=0) { super(status?`Payward HTTP ${status}`:'Payward response unavailable'); this.name='PaywardError'; this.status=status;this.retryAfterMs=retryAfterMs; }
}
export class PaywardTransport {
  constructor({environment='sandbox',credentials,fetchImpl=globalThis.fetch,clock=Date.now}) {
    assert(hosts[environment]); assert(typeof credentials==='function');
    this.environment=environment;this.credentials=credentials;this.fetch=fetchImpl;this.clock=clock;this.lastTimestamp=0;
  }
  async request(method,path,body,idem=null) {
    assert(['GET','POST'].includes(method)&&/^\/v1\/[A-Za-z0-9_/?=&%.+:-]+$/.test(path)&&!path.includes('..'),'invalid API path');
    assert(method!=='GET'||body===undefined);
    const serialized=body===undefined?'':JSON.stringify(body),c=await this.credentials();
    assert(c.environment===this.environment&&c.version===2,'credential environment/signature mismatch');
    const now=this.clock(),timestamp=Math.max(now,this.lastTimestamp+1);
    assert(Number.isSafeInteger(timestamp)&&timestamp-now<1000,'clock moved backwards or signing rate exceeded'); this.lastTimestamp=timestamp;
    const headers={'API-Key':c.key,'API-Timestamp':String(timestamp),'API-Sign':paywardSignature(c.secret,String(timestamp),method,path,serialized),'Accept':'application/json'};
    if(body!==undefined) headers['Content-Type']='application/json';
    if(idem!==null) {assert(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(idem)); headers['Idempotency-Key']=idem;}
    // No redirects (credentials), no automatic POST retries, bounded time and streaming response size.
    let response;
    try {
      response=await this.fetch(hosts[this.environment]+path,{method,headers,...(body===undefined?{}:{body:serialized}),redirect:'error',signal:AbortSignal.timeout(12000)});
      if(!response.ok) {
        const raw=response.headers.get('Retry-After'),seconds=raw&&/^\d+$/.test(raw)?Number(raw):null;
        const retryAfterMs=raw?Math.min(86400000,Math.max(0,seconds!==null?seconds*1000:(Date.parse(raw)-this.clock())||0)):0;
        await response.body?.cancel();throw new PaywardError(response.status,retryAfterMs);
      }
      const reader=response.body.getReader(),chunks=[];let size=0;
      try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1024*1024)throw new PaywardError();chunks.push(Buffer.from(value));}}
      finally {await reader.cancel();}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch(e) {throw e instanceof PaywardError?e:new PaywardError();}
  }
}

function quoteTerms(q) {
  assert(q&&typeof q.id==='string'); id(q.id);
  assert(['offered','executing','executed','expired','failed','pending'].includes(q.status),'unknown quote status');
  const from=amount(q.from),to=amount(q.to),tradeFee=amount(q.fees?.trade);
  assert(units(from.amount)>0n&&units(to.amount)>0n);
  assert(typeof q.expires_at==='string'&&q.expires_at.endsWith('Z')&&Number.isSafeInteger(Date.parse(q.expires_at)),'UTC quote expiry required');
  return {quoteId:q.id,from,to,tradeFee,expiresAt:Date.parse(q.expires_at),custody:'provider',withdrawalFee:'quoted separately before withdrawal'};
}
function quoteState(q) {
  return {offered:'UNKNOWN',pending:'EXECUTING',executing:'EXECUTING',executed:'TRADED',expired:'EXPIRED',failed:'FAILED'}[q.status];
}
function feeTerms(q,symbol,gross) {
  const fee=amount(q.fee),net=amount(q.net_amount),total=amount(q.gross_amount);
  assert([fee,net,total].every(a=>a.symbol===symbol),'withdrawal fee asset mismatch');
  assert.equal(units(total.amount),units(gross));assert.equal(units(total.amount),units(net.amount)+units(fee.amount));assert(units(net.amount)>0n);
  return {gross:total,net,fee};
}

export class PaywardAdapter {
  constructor({transport,admit,clock=Date.now}) {
    assert(typeof admit==='function','explicit per-owner/account/route admission required');
    this.transport=transport;this.admit=admit;this.clock=clock;this.identity=`payward-services-v2:${transport.environment}`;
  }
  path(account,suffix) {return `/v1/accounts/${id(account)}${suffix}`;}
  async authorize(context) {
    // Host service owns this decision: verified account ownership, KYC/region, exact assets/networks,
    // funding-method/destination binding and approved native listing. Never trust client booleans.
    assert(await this.admit({...context,environment:this.transport.environment})===true,'route/account not admitted');
  }
  async review({owner,account,request}) {
    await this.authorize({owner,account,request});
    if(request.kind==='trade') {
      exact(request,['kind','from','to','amount']);asset(request.from);asset(request.to);
      assert(request.from!==request.to);assert(units(request.amount)>0n);
      const q=(await this.transport.request('POST',this.path(account,'/quotes'),{from:{...asset(request.from),amount:request.amount},to:asset(request.to)})).data;
      const terms=quoteTerms(q);assert.equal(q.status,'offered');
      assert.equal(terms.from.symbol,request.from);assert.equal(terms.to.symbol,request.to);assert.equal(units(terms.from.amount),units(request.amount));
      assert(terms.expiresAt>this.clock());
      return {reference:q.id,expiresAt:terms.expiresAt,terms,payload:{quoteId:q.id,terms}};
    }
    exact(request,['kind','symbol','amount','methodId','network','addressId','address','tag','memo']);
    assert.equal(request.kind,'withdraw');asset(request.symbol);assert(units(request.amount)>0n);id(request.methodId);id(request.addressId);
    assert(typeof request.network==='string'&&request.network.length>0&&request.network.length<=128);
    const dest=(await this.transport.request('GET',this.path(account,`/funds/addresses/${id(request.addressId)}`))).data;
    // Initial adapter supports exact method scope only; network-group resolution requires a separately verified mapping.
    assert.equal(dest.address_id,request.addressId);assert.equal(dest.scope?.method_id,request.methodId);
    assert.deepEqual(dest.address_details?.crypto,{address:request.address,...(request.tag?{tag:request.tag}:{}),...(request.memo?{memo:request.memo}:{})});
    const q=(await this.transport.request('POST',this.path(account,'/funds/fees'),{method_id:request.methodId,amount:request.amount})).data;
    const fees=feeTerms(q,request.symbol,request.amount);
    assert(typeof q.fee_token==='string'&&q.fee_token.length>0&&q.fee_token.length<=2000,'firm withdrawal fee token required');
    const terms={...fees,network:request.network,address:request.address,tag:request.tag,memo:request.memo,methodId:request.methodId,addressId:request.addressId,custody:'provider'};
    return {reference:request.addressId+':'+request.amount,expiresAt:this.clock()+30000,terms,
      payload:{body:{scope:{method_id:request.methodId},destination:{type:'funding_address',address_id:request.addressId},symbol:request.symbol,amount:request.amount,fee_token:q.fee_token},terms,startedAt:new Date(this.clock()).toISOString()}};
  }
  async execute({account,kind,payload,idempotencyKey}) {
    if(kind==='trade') {
      const q=(await this.transport.request('POST',this.path(account,`/quotes/${id(payload.quoteId)}/execute`),{})).data;
      assert.equal(q.id,payload.quoteId);assert(quoteState(q));
      // Even an "executed" acknowledgement is reconciled through the full immutable quote before completion.
      return {state:'EXECUTING',reference:q.id};
    }
    assert.equal(kind,'withdraw');
    const dest=(await this.transport.request('GET',this.path(account,`/funds/addresses/${id(payload.terms.addressId)}`))).data;
    assert.equal(dest.address_id,payload.terms.addressId);assert.equal(dest.scope?.method_id,payload.terms.methodId);
    assert.deepEqual(dest.address_details?.crypto,{address:payload.terms.address,...(payload.terms.tag?{tag:payload.terms.tag}:{}),...(payload.terms.memo?{memo:payload.terms.memo}:{})});
    const q=(await this.transport.request('POST',this.path(account,'/funds/withdrawals'),payload.body,idempotencyKey)).data;
    id(q.withdrawal_id);const fees=feeTerms(q,payload.body.symbol,payload.body.amount);
    assert.deepEqual(fees,{gross:payload.terms.gross,net:payload.terms.net,fee:payload.terms.fee});
    return {state:'WITHDRAWAL_PENDING',reference:q.withdrawal_id};
  }
  async reconcile({account,kind,payload,result}) {
    if(kind==='trade') {
      const q=(await this.transport.request('GET',this.path(account,`/quotes/${id(payload.quoteId)}`))).data;
      assert.equal(canonical(quoteTerms(q)),canonical(payload.terms),'quote terms changed');
      return {state:quoteState(q),reference:q.id};
    }
    assert.equal(kind,'withdraw');
    // The public API does not specify an idempotency retention horizon or lookup by that key.
    // A missing ID must be reconciled with Payward; absence in a page is not proof of nonexecution.
    if(!result?.reference) return {state:'ACTION_REQUIRED',reason:'withdrawal_response_unknown'};
    id(result.reference);
    const query=new URLSearchParams({types:'withdrawal',page_size:'100',start_timestamp:payload.startedAt,sort_direction:'asc'});
    if(result.cursor) query.set('page_token',result.cursor);
    let page;
    try {page=await this.transport.request('GET',this.path(account,'/portfolio/transactions?'+query));}
    catch(e) {
      // Pagination tokens expire after 24h. Restart the bounded scan without dropping the funding ID.
      if(e.status===400&&result.cursor)return {state:'WITHDRAWAL_PENDING',reference:result.reference,cursor:null};
      throw e;
    }
    assert(Array.isArray(page.data)&&page.data.length<=100);
    const matches=page.data.filter(t=>t.type==='withdrawal'&&t.reference?.kind==='funding'&&t.reference.id===result.reference);
    assert(matches.length<=1,'ambiguous withdrawal evidence');
    if(matches.length) {
      const t=matches[0];assert(['in_progress','successful','failed'].includes(t.status));
      // Exact funding reference binds the command; receipt still needs the wallet's chain verifier.
      return {state:t.status==='successful'?'PROVIDER_COMPLETED':t.status==='failed'?'FAILED':'WITHDRAWAL_PENDING',reference:result.reference};
    }
    const cursor=page.next_page_token??null;assert(cursor===null||(typeof cursor==='string'&&cursor.length>0&&cursor.length<=256));
    assert(!cursor||cursor!==result.cursor,'provider pagination did not advance');
    return {state:'WITHDRAWAL_PENDING',reference:result.reference,cursor};
  }
}
