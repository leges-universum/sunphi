// ChangeNOW V2 discovery only. No orders, payment addresses, refunds or funds.
// Public schema: https://documenter.getpostman.com/view/8180765/SVfTPnM8?version=latest
import assert from 'node:assert/strict';
import {decimal,units} from './exchange-provider.mjs';

const HOST='https://api.changenow.io';
const LIMIT=4*1024*1024;
const code=x=>typeof x==='string'&&/^[a-z0-9_-]{1,40}$/.test(x);
const fields=['fromCurrency','fromNetwork','toCurrency','toNetwork','flow'];
function route(value) {
  assert(value&&Object.keys(value).length===fields.length&&fields.every(k=>Object.hasOwn(value,k)),'exact route required');
  assert(fields.slice(0,4).every(k=>code(value[k])),'explicit currency/network codes required');
  assert(['standard','fixed-rate'].includes(value.flow),'invalid flow');
  assert(value.fromCurrency!==value.toCurrency||value.fromNetwork!==value.toNetwork,'different assets or networks required');
  return Object.fromEntries(fields.map(k=>[k,value[k]]));
}

// The API uses JSON numbers for amounts. Preserve the original numeric token,
// never a rounded Number. Fail closed if the runtime lacks source contexts.
export function parseChangeNowJson(text) {
  return JSON.parse(text,(_key,value,context)=>{
    if(typeof value!=='number')return value;
    assert(typeof context?.source==='string','lossless JSON support required');
    return context.source;
  });
}
export function changeNowAmount(value) {
  assert(typeof value==='string'&&value.length<=100,'exact amount required');
  const m=/^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(value);
  assert(m,'invalid amount');
  const exponent=Number(m[3]??0);assert(Math.abs(exponent)<=100,'amount exponent too large');
  let digits=m[1]+(m[2]??''),point=m[1].length+exponent;
  let result=point<=0?'0.'+'0'.repeat(-point)+digits:
    point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point);
  result=result.replace(/^0+(?=\d)/,'');
  if(result.includes('.'))result=result.replace(/0+$/,'').replace(/\.$/,'');
  return decimal(result);
}
export class ChangeNowDiscoveryError extends Error {
  constructor(status=0,retryAfterMs=0) {
    super(status?`ChangeNOW HTTP ${status}`:'ChangeNOW response unavailable');
    this.name='ChangeNowDiscoveryError';this.status=status;this.retryAfterMs=retryAfterMs;
  }
}
export class ChangeNowDiscovery {
  constructor({credentials,fetchImpl=globalThis.fetch,clock=Date.now}) {
    assert(typeof credentials==='function');
    this.credentials=credentials;this.fetch=fetchImpl;this.clock=clock;this.busy=false;
    this.identity='changenow-v2:production:read-only';
  }
  async get(endpoint,params) {
    // Only two enumerated GET operations. Never accept a caller-supplied URL.
    assert(['currencies','range'].includes(endpoint),'read-only discovery endpoint required');
    const query=endpoint==='range'?route(params):params;
    if(endpoint==='currencies')assert.deepEqual(query,{active:'true',flow:query.flow});
    assert(['standard','fixed-rate'].includes(query.flow));
    assert(!this.busy,'discovery request already in progress');this.busy=true;
    try {
      const c=await this.credentials();
      assert(c?.environment==='production'&&typeof c.key==='string'&&/^[\x21-\x7e]{1,512}$/.test(c.key),'production discovery credentials required');
      const response=await this.fetch(`${HOST}/v2/exchange/${endpoint}?${new URLSearchParams(query)}`,{
        method:'GET',headers:{'x-changenow-api-key':c.key,Accept:'application/json'},
        redirect:'error',signal:AbortSignal.timeout(12000)
      });
      if(!response.ok) {
        const retry=response.headers.get('Retry-After');
        const ms=retry&&/^\d+$/.test(retry)?Number(retry)*1000:Date.parse(retry??'')-this.clock();
        await response.body?.cancel();
        throw new ChangeNowDiscoveryError(response.status,Number.isFinite(ms)?Math.min(86400000,Math.max(0,ms)):0);
      }
      if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')) {
        await response.body?.cancel();throw new ChangeNowDiscoveryError();
      }
      const reader=response.body.getReader(),chunks=[];let size=0;
      try {
        for(;;) {const {done,value}=await reader.read();if(done)break;size+=value.length;
          if(size>LIMIT)throw new ChangeNowDiscoveryError();chunks.push(value);}
      } finally {await reader.cancel();}
      return parseChangeNowJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    } catch(e) {throw e instanceof ChangeNowDiscoveryError?e:new ChangeNowDiscoveryError();}
    finally {this.busy=false;}
  }
  async inspectRoute(input) {
    const requested=route(input);
    const catalog=await this.get('currencies',{active:'true',flow:requested.flow});
    assert(Array.isArray(catalog)&&catalog.length<=10000,'invalid currency catalog');
    const select=(ticker,network)=>{
      const found=catalog.filter(c=>c&&c.ticker===ticker&&c.network===network);
      assert(found.length<=1,'ambiguous currency/network');
      return found[0];
    };
    const from=select(requested.fromCurrency,requested.fromNetwork),to=select(requested.toCurrency,requested.toNetwork);
    const base={provider:this.identity,checkedAt:new Date(this.clock()).toISOString(),route:requested,
      executionEnabled:false,admissionRequired:true,financialCommandsSent:0};
    // A ticker alone never establishes native-chain identity, listing or customer eligibility.
    if(!from||!to)return {...base,available:false,reason:'CURRENCY_NETWORK_NOT_LISTED'};
    if(from.sell!==true||to.buy!==true||
      (requested.flow==='fixed-rate'&&(from.supportsFixedRate!==true||to.supportsFixedRate!==true)))
      return {...base,available:false,reason:'DIRECTION_OR_FLOW_UNAVAILABLE'};
    const r=await this.get('range',requested);
    assert(r&&fields.every(k=>r[k]===requested[k]),'range route mismatch');
    const min=changeNowAmount(r.minAmount),max=r.maxAmount===null?null:changeNowAmount(r.maxAmount);
    assert(max===null||units(max)>=units(min),'invalid range');
    return {...base,available:true,reason:'DISCOVERY_ONLY',minAmount:min,maxAmount:max};
  }
}
