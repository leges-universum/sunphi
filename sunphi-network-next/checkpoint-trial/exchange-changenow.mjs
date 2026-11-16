// Deposit-swap adapter; shared signed consent and durable provider command journal.
// Native admission and real sandbox qualification are NOT established by this code.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {exact,publicKey} from './crypto.mjs';
import {units} from './exchange-provider.mjs';
import {parseChangeNowJson,changeNowAmount,ChangeNowDiscoveryError} from './exchange-changenow-discovery.mjs';
const text=(x,max=256)=>{assert(typeof x==='string'&&x.length<=max&&!/[\x00-\x1f\x7f]/.test(x),'invalid provider text');return x;};
const identifier=x=>{assert(typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x),'invalid provider reference');return x;};
const utc=x=>{assert(typeof x==='string'&&x.endsWith('Z')&&Number.isSafeInteger(Date.parse(x)),'UTC expiry required');return Date.parse(x);};
const requestFields=['kind','from','to','amount','fromNetwork','toNetwork','flow','address','extraId','refundAddress','refundExtraId'];
export class ChangeNowTransport {
  constructor({environment='production',simulationUrl,credentials,fetchImpl=globalThis.fetch,clock=Date.now}) {
    assert(['production','simulation'].includes(environment));
    let base='https://api.changenow.io';
    if(environment==='simulation') {const u=new URL(simulationUrl);assert(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.pathname==='/'&&!u.username&&!u.password&&!u.search&&!u.hash,'isolated loopback simulator required');base=u.origin;}
    else assert(!simulationUrl);
    assert(typeof credentials==='function');Object.assign(this,{environment,base,credentials,fetch:fetchImpl,clock});
  }
  async request(method,path,body) {
    const u=new URL(path,this.base);
    assert(u.origin===this.base&&!u.hash);
    assert(method==='GET'&&['/v2/exchange/estimated-amount','/v2/exchange/by-id','/v2/validate/address'].includes(u.pathname)&&body===undefined||method==='POST'&&u.pathname==='/v2/exchange'&&!u.search,'unsupported ChangeNOW operation');
    // No production order creation before partner admission/recovery qualification.
    assert(method!=='POST'||this.environment==='simulation','ChangeNOW live creation is not qualified');
    try {
      const c=await this.credentials();assert(c.environment===this.environment&&typeof c.key==='string'&&/^[\x21-\x7e]{1,512}$/.test(c.key));
      const r=await this.fetch(u,{method,headers:{'x-changenow-api-key':c.key,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},
        ...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(12000)});
      if(!r.ok){const v=r.headers.get('Retry-After'),n=v&&/^\d+$/.test(v)?Number(v)*1000:Date.parse(v??'')-this.clock();await r.body?.cancel();throw new ChangeNowDiscoveryError(r.status,Number.isFinite(n)?Math.max(0,Math.min(86400000,n)):0);}
      if(!/^application\/json(?:\s*;|$)/i.test(r.headers.get('content-type')??'')){await r.body?.cancel();throw new ChangeNowDiscoveryError();}
      const chunks=[];let size=0;for await(const b of r.body){size+=b.length;assert(size<=1024*1024);chunks.push(b);}
      return parseChangeNowJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    } catch(e){throw e instanceof ChangeNowDiscoveryError?e:new ChangeNowDiscoveryError();}
  }
}
export class ChangeNowAdapter {
  constructor({transport,admit,routes,clock=Date.now}) {
    assert(typeof admit==='function'&&Array.isArray(routes));
    Object.assign(this,{transport,admit,routes,clock});this.capability='deposit_swap';this.identity=`changenow-v2:${transport.environment}`;
  }
  route(request) {
    exact(request,requestFields);assert.equal(request.kind,'swap');assert(units(request.amount)>0n);
    const rs=this.routes.filter(r=>['from','to','fromNetwork','toNetwork','flow'].every(k=>r[k]===request[k]));
    assert.equal(rs.length,1,'exact admitted network route required');const r=rs[0];
    assert(['standard','fixed-rate'].includes(r.flow));
    assert([r.from,r.to].includes(r.feeSymbol),'explicit provider fee denomination required');
    for(const k of ['fromCurrency','toCurrency','fromNetwork','toNetwork'])assert(/^[a-z0-9_-]{1,40}$/.test(r[k]));
    for(const k of ['address','extraId','refundAddress','refundExtraId'])text(request[k]);
    assert(request.address&&request.refundAddress,'receiving and refund addresses required');
    return r;
  }
  async authorize(c) {
    this.route(c.request);assert(await this.admit({...c,environment:this.transport.environment})===true,'swap route not admitted');
    if(c.request.to==='DUBYT'){publicKey(c.request.address);assert.equal(c.request.address,c.owner,'receive native funds in this wallet');assert.equal(c.request.extraId,'');}
    if(c.request.from==='DUBYT'){publicKey(c.request.refundAddress);assert.equal(c.request.refundAddress,c.owner,'refund native funds to this wallet');assert.equal(c.request.refundExtraId,'');}
  }
  query(r){return {fromCurrency:r.fromCurrency,fromNetwork:r.fromNetwork,toCurrency:r.toCurrency,toNetwork:r.toNetwork,flow:r.flow};}
  async review(c) {
    await this.authorize(c);const q=c.request,r=this.route(q),pair=this.query(r);
    for(const [currency,address] of [[r.toCurrency,q.address],[r.fromCurrency,q.refundAddress]]) {
      const v=await this.transport.request('GET','/v2/validate/address?'+new URLSearchParams({currency,address}));assert(v.result===true,'address rejected by provider');
    }
    const e=await this.transport.request('GET','/v2/exchange/estimated-amount?'+new URLSearchParams({...pair,type:'direct',fromAmount:q.amount,useRateId:'true'}));
    assert(Object.keys(pair).every(k=>e[k]===pair[k])&&e.type==='direct','estimate route changed');
    assert.equal(units(changeNowAmount(e.fromAmount)),units(q.amount));const receive=changeNowAmount(e.toAmount);assert(units(receive)>0n);
    const expiresAt=e.validUntil?utc(e.validUntil):this.clock()+30000;
    assert(expiresAt>this.clock()&&expiresAt<=this.clock()+3600000,'invalid estimate expiry');
    if(r.flow==='fixed-rate')identifier(e.rateId);
    const terms={from:{symbol:q.from,network:r.fromNetwork,amount:q.amount},to:{symbol:q.to,network:r.toNetwork,amount:receive},
      flow:r.flow,address:q.address,extraId:q.extraId,refundAddress:q.refundAddress,refundExtraId:q.refundExtraId,
      depositFee:changeNowAmount(e.depositFee),withdrawalFee:changeNowAmount(e.withdrawalFee),feeSymbol:r.feeSymbol,
      feeNotice:'Provider estimate; fees are not subtracted again. Sending-wallet network fees are additional.',
      rateNotice:r.flow==='fixed-rate'?'Rate applies only to a matching deposit within the provider deadline.':'The received amount may change with the market.',
      warning:text(e.warningMessage??'',2000),custody:'provider-during-swap'};
    const body={...pair,type:'direct',fromAmount:q.amount,toAmount:'',address:q.address,extraId:q.extraId,
      refundAddress:q.refundAddress,refundExtraId:q.refundExtraId,...(r.flow==='fixed-rate'?{rateId:e.rateId}:{})};
    return {reference:randomUUID(),expiresAt,terms,payload:{body,terms,expiresAt}};
  }
  receipt(r,p,prior=null,creating=false) {
    identifier(r.id);if(prior)assert.equal(r.id,prior.reference);
    for(const k of ['fromCurrency','fromNetwork','toCurrency','toNetwork'])assert.equal(r[k],p.body[k],'swap route changed');
    assert.equal(r.payoutAddress,p.body.address);assert.equal(r.payoutExtraId??'',p.body.extraId);
    assert.equal(r.refundAddress,p.body.refundAddress);assert.equal(r.refundExtraId??'',p.body.refundExtraId);
    const payinAddress=text(r.payinAddress),payinExtraId=text(r.payinExtraId??'');assert(payinAddress);
    if(p.terms.from.symbol==='DUBYT'){publicKey(payinAddress);assert.equal(payinExtraId,'','native memo deposits not supported');}
    if(prior?.deposit){assert.equal(payinAddress,prior.deposit.address);assert.equal(payinExtraId,prior.deposit.extraId);}
    const expected=r.expectedAmountFrom??(creating?r.fromAmount:null);
    if(expected!==null&&expected!==undefined)assert.equal(units(changeNowAmount(expected)),units(p.body.fromAmount));
    const expectedTo=r.expectedAmountTo??(creating?r.toAmount:null);
    if(p.terms.flow==='fixed-rate'&&expectedTo!=null)assert.equal(units(changeNowAmount(expectedTo)),units(p.terms.to.amount),'fixed rate changed');
    if(creating&&p.terms.flow==='fixed-rate')assert(expectedTo!=null,'missing fixed quote amount');
    if(creating){assert.equal(r.flow,p.body.flow);assert.equal(r.type,'direct');assert(expected!==null&&expected!==undefined);}
    const reportedExpiry=r.validUntil?utc(r.validUntil):null;
    const validUntil=reportedExpiry&&prior?.deposit?.validUntil?Math.min(reportedExpiry,prior.deposit.validUntil):reportedExpiry;
    const deposit={address:payinAddress,extraId:payinExtraId,network:p.body.fromNetwork,symbol:p.terms.from.symbol,amount:p.body.fromAmount,validUntil};
    const status=creating?'new':r.status;
    const state={new:'SWAP_WAITING',waiting:'SWAP_WAITING',confirming:'SWAP_CONFIRMING',exchanging:'SWAP_EXCHANGING',sending:'SWAP_SENDING',finished:'PROVIDER_COMPLETED',verifying:'SWAP_VERIFYING',failed:'ACTION_REQUIRED',refunded:'REFUND_REPORTED'}[status];
    assert(state,'unknown swap status');
    const result={state,reference:r.id,deposit,providerStatus:status,canDeposit:false,delivered:false};
    // Status must confirm a deadline before any payment instruction is enabled.
    result.canDeposit=!creating&&state==='SWAP_WAITING'&&expected!=null&&(p.terms.flow!=='fixed-rate'||expectedTo!=null)&&!!validUntil&&validUntil>this.clock()&&!r.payinHash&&!r.depositReceivedAt&&(r.amountFrom==null||units(changeNowAmount(r.amountFrom))===0n);
    for(const k of ['payinHash','payoutHash','refundHash'])if(r[k])result[k]=text(r[k],256);
    if(r.amountTo!==null&&r.amountTo!==undefined)result.actualReceive=changeNowAmount(r.amountTo);
    if(p.terms.flow==='fixed-rate'&&result.actualReceive!=null&&units(result.actualReceive)!==units(p.terms.to.amount))result.amountMismatch=true;
    if(r.refundAmount!==null&&r.refundAmount!==undefined)result.refundAmount=changeNowAmount(r.refundAmount);
    if(r.updatedAt)result.updatedAt=utc(r.updatedAt);
    if(!creating)assert(result.updatedAt&&result.updatedAt<=this.clock()+30000,'valid provider update time required');
    if(prior?.updatedAt&&result.updatedAt&&result.updatedAt<prior.updatedAt)return {...prior,canDeposit:false};
    const rank={new:0,waiting:0,confirming:1,exchanging:2,sending:3,finished:4};
    if(prior&&rank[status]!==undefined&&rank[prior.providerStatus]>rank[status])return {...prior,canDeposit:false};
    if(prior?.payinHash){result.canDeposit=false;result.payinHash??=prior.payinHash;}
    // Verification or a detected deposit must never turn into a request to pay again.
    if(prior&&prior.depositSeen)result.canDeposit=false;
    result.depositSeen=!!(prior?.depositSeen||r.payinHash||r.depositReceivedAt||(r.amountFrom!=null&&units(changeNowAmount(r.amountFrom))>0n)||['confirming','exchanging','sending','finished','refunded'].includes(status));
    if(result.depositSeen)result.canDeposit=false;
    if((r.relatedExchangesInfo?.length||r.repeatedExchangesInfo?.length)||r.originalExchangeInfo){result.state='ACTION_REQUIRED';result.canDeposit=false;result.reason='related_exchange_needs_reconciliation';}
    if(state==='PROVIDER_COMPLETED')assert(result.payoutHash,'missing payout evidence');
    if(state==='REFUND_REPORTED')assert(result.refundHash,'missing refund evidence');
    return result;
  }
  async execute({kind,payload}) {
    assert.equal(kind,'swap');assert(this.clock()<payload.expiresAt,'estimate expired');
    const r=await this.transport.request('POST','/v2/exchange',payload.body);
    // Preserve a valid provider ID even when the rest of the response is malformed.
    identifier(r.id);try{return this.receipt(r,payload,null,true);}catch{return {state:'SWAP_VERIFYING',reference:r.id,canDeposit:false,reason:'create_response_needs_verification'};}
  }
  async reconcile({kind,payload,result}) {
    assert.equal(kind,'swap');
    if(!result?.reference)return {state:'ACTION_REQUIRED',reason:'creation_response_unknown',canDeposit:false};
    const r=await this.transport.request('GET','/v2/exchange/by-id?'+new URLSearchParams({id:identifier(result.reference)}));
    return this.receipt(r,payload,result);
  }
}
