import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {keys,sign} from '../crypto.mjs';
import {ProviderExchange,providerConsent,providerProgress,verifyProviderReview,units} from '../exchange-provider.mjs';
import {PaywardAdapter,PaywardTransport,paywardSignature,PaywardError} from '../exchange-payward.mjs';

// Published Payward documentation vectors: public fake key material, NOT credentials.
const SECRET='AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+Pw==';
const START=1800000000000;
const a=(symbol,amount)=>({symbol,type:['USDT','USDC'].includes(symbol)?'stablecoin':'crypto',amount});
function fixture(t,{file=':memory:',storageKey=Buffer.alloc(32,5),signer=keys(),owner=keys()}={}) {
  let now=START,seq=0,postMode='ok',admitted=true;
  const calls=[],quotes=new Map();let withdrawalMode='ok',portfolio=[];
  const fetchImpl=async(url,init)=>{
    calls.push({url,init});const u=new URL(url),body=init.body?JSON.parse(init.body):null;
    const qid=u.pathname.split('/')[5];let data;
    if(u.pathname.endsWith('/quotes')&&init.method==='POST') {
      const quote={id:'Q-'+ ++seq,status:'offered',expires_at:new Date(now+120000).toISOString(),from:body.from,to:{...body.to,amount:'9.95'},fees:{trade:a(body.to.symbol,'0.05')}};
      quotes.set(quote.id,quote);data=quote;
    } else if(u.pathname.endsWith('/execute')) {
      const q=quotes.get(qid);q.status='executed';if(postMode==='lost')throw new Error('secret raw network error');data={id:q.id,status:'executing'};
    } else if(u.pathname.includes('/quotes/')) data=quotes.get(qid);
    else if(u.pathname.includes('/funds/addresses/')) data={address_id:'AB12345-6789A-BCDEFG',scope:{method_id:'method-btc'},address_details:{crypto:{address:'destination-1'}}};
    else if(u.pathname.endsWith('/funds/fees')) data={gross_amount:a('BTC',body.amount),net_amount:a('BTC','9.94'),fee:a('BTC','0.01'),fee_token:'opaque-sensitive-fee-fixture'};
    else if(u.pathname.endsWith('/funds/withdrawals')) {if(withdrawalMode==='lost')throw new Error('lost withdrawal response'); data={withdrawal_id:'FT-1',gross_amount:a('BTC',body.amount),net_amount:a('BTC','9.94'),fee:a('BTC','0.01')};}
    else if(u.pathname.endsWith('/portfolio/transactions')) return Response.json(typeof portfolio==='function'?portfolio(u):{data:portfolio});
    else throw new Error('unexpected fixture path');
    return Response.json({data});
  };
  const transport=new PaywardTransport({credentials:async()=>({version:2,environment:'sandbox',key:'public-fixture',secret:SECRET}),fetchImpl,clock:()=>now});
  const adapter=new PaywardAdapter({transport,admit:async c=>admitted&&c.owner===owner.publicKey&&c.account==='account-1',clock:()=>now});
  const db=new DatabaseSync(file),options={adapter,scope:'fixture:chain-1',storageKey,signingKey:signer,clock:()=>now};
  const service=new ProviderExchange(db,options);t.after(()=>{try{db.close();}catch{}});
  const quote=(to='BTC')=>service.review({owner:owner.publicKey,account:'account-1',request:{kind:'trade',from:'DUBYT',to,amount:'10'}});
  const consent=o=>sign(providerConsent(o.review),owner.privateKey);
  const accept=o=>service.accept(o.review.id,owner.publicKey,consent(o));
  const withdrawal=parent=>service.review({owner:owner.publicKey,account:'account-1',parent,request:{kind:'withdraw',symbol:'BTC',amount:'9.95',methodId:'method-btc',network:'bitcoin',addressId:'AB12345-6789A-BCDEFG',address:'destination-1',tag:'',memo:''}});
  return {service,adapter,transport,db,options,owner,signer,calls,quotes,quote,accept,consent,withdrawal,
    time:v=>now=v,advance:(ms=300001)=>now+=ms,lose:()=>postMode='lost',deny:()=>admitted=false,
    loseWithdrawal:()=>withdrawalMode='lost',portfolio:p=>portfolio=p};
}

test('Payward V2 reproduces both official independent authentication vectors',()=>{
  assert.equal(paywardSignature(SECRET,'1700000000000','GET','/v1/reports/settlement?start_date=2026-04-25T00%3A00%3A00Z&end_date=2026-04-26T00%3A00%3A00Z&report_type=swaps'),'G7vQQwhG76ulpVc7TtF5kqUhNq54RgS6vRAmeKgo8GFTmhThUwNTcOR+ERS9f8be3MCMMpBRZx5czkr80KLnxQ==');
  assert.equal(paywardSignature(SECRET,'1700000000000','POST','/v1/users','{"email":"alex.morgan@example.com","external_reference":"partner-user-12345"}'),'IKV68BHeOPFZEUajDgwOQox194xE9rU0Nh5IjDSt8d12qcm4IhcVmbTNzxLZxCOraIWxxrhOzX17HDOudviyeA==');
});
test('one review/consent contract across four assets; exact amounts, signed terms and bounded UI stages',async t=>{
  const f=fixture(t);
  for(const symbol of ['BTC','USDC','USDT','XMR']) {
    const o=await f.quote(symbol);assert(verifyProviderReview(o.review,o.signature,f.signer.publicKey));
    assert.equal(o.review.terms.to.symbol,symbol);assert.equal(o.review.terms.from.amount,'10');
    const altered=structuredClone(o.review);altered.terms.to.amount='900';assert(!verifyProviderReview(altered,o.signature,f.signer.publicKey));
    await f.accept(o);f.advance();await f.service.recover();assert.equal(f.service.view(o.review.id,f.owner.publicKey).state,'TRADED');
  }
  for(const s of ['UNKNOWN','EXECUTING','WITHDRAWAL_PENDING']) assert(providerProgress(s).busy);
  assert(!providerProgress('TRADED').delivered);assert(!providerProgress('PROVIDER_COMPLETED').delivered);
  assert.equal(units('999999999999999999.000000000001'),999999999999999999000000000001000000n);
  for(const invalid of [1,NaN,'1e8','-1','01','1.0000000000000000001']) assert.throws(()=>units(invalid));
});
test('lost execution response, double click and restart reconcile without duplicate POST',async t=>{
  const f=fixture(t),o=await f.quote();f.lose();
  await Promise.all([f.accept(o),f.accept(o)]);
  assert.equal(f.service.view(o.review.id,f.owner.publicKey).state,'UNKNOWN');
  const restarted=new ProviderExchange(f.db,f.options);f.advance();await restarted.recover();
  assert.equal(restarted.view(o.review.id,f.owner.publicKey).state,'TRADED');await f.accept(o);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/execute')).length,1);
  assert(!JSON.stringify(restarted.view(o.review.id,f.owner.publicKey)).includes('secret raw'));
});
test('owner, consent, expired quote, route admission and journal environment/key are enforced',async t=>{
  const f=fixture(t),o=await f.quote(),other=keys();
  await assert.rejects(()=>f.service.accept(o.review.id,f.owner.publicKey,sign(providerConsent(o.review),other.privateKey)),/consent/);
  assert.throws(()=>f.service.view(o.review.id,other.publicKey),/not found/);
  f.deny();await assert.rejects(()=>f.accept(o),/not admitted/);await assert.rejects(()=>f.quote(),/not admitted/);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/execute')).length,0);
  assert.throws(()=>new ProviderExchange(f.db,{...f.options,scope:'other'}),/mismatch/);
  assert.throws(()=>new ProviderExchange(f.db,{...f.options,storageKey:Buffer.alloc(32,6)}),/mismatch/);
  const g=fixture(t),expired=await g.quote();g.advance();await assert.rejects(()=>g.accept(expired),/expired/);
});
test('changed provider quote cannot silently complete; backoff survives restart',async t=>{
  const f=fixture(t),o=await f.quote();await f.accept(o);f.quotes.get(o.review.terms.quoteId).to.amount='8';f.advance();
  await f.service.recover();assert.equal(f.service.view(o.review.id,f.owner.publicKey).state,'EXECUTING');
  const calls=f.calls.length;await new ProviderExchange(f.db,f.options).recover();assert.equal(f.calls.length,calls);
  f.quotes.get(o.review.terms.quoteId).to.amount='9.95';f.advance();await f.service.recover();assert.equal(f.service.view(o.review.id,f.owner.publicKey).state,'TRADED');
});
test('withdrawal fee/destination consent, encrypted fee token, single withdrawal per trade, provider completion != delivery',async t=>{
  const f=fixture(t),o=await f.quote();await f.accept(o);f.advance();await f.service.recover();
  const w=await f.withdrawal(o.review.id),w2=await f.withdrawal(o.review.id);
  assert.equal(w.review.terms.address,'destination-1');assert.equal(w.review.terms.net.amount,'9.94');
  const row=f.db.prepare('SELECT * FROM provider_exchange_commands WHERE id=?').get(w.review.id);
  assert(!JSON.stringify(row).includes('opaque-sensitive-fee-fixture'));
  await f.accept(w);await assert.rejects(()=>f.accept(w2),/UNIQUE/);
  const post=f.calls.find(c=>c.url.endsWith('/funds/withdrawals'));
  assert.equal(post.init.headers['Idempotency-Key'],w.review.id);
  f.portfolio([{type:'withdrawal',status:'successful',reference:{kind:'funding',id:'FT-1'}}]);f.advance();await f.service.recover();
  assert.equal(f.service.view(w.review.id,f.owner.publicKey).state,'PROVIDER_COMPLETED');
  assert(!providerProgress('PROVIDER_COMPLETED').delivered);
});
test('ambiguous withdrawal is fenced, never automatically resent or marked failed/refunded',async t=>{
  const f=fixture(t),o=await f.quote();await f.accept(o);f.advance();await f.service.recover();
  const w=await f.withdrawal(o.review.id);f.loseWithdrawal();await f.accept(w);f.advance();await f.service.recover();await f.accept(w);
  assert.equal(f.service.view(w.review.id,f.owner.publicKey).state,'ACTION_REQUIRED');
  assert.equal(f.calls.filter(c=>c.url.endsWith('/funds/withdrawals')).length,1);
});
test('empty portfolio page with continuation is not terminal; unrelated reference ignored',async t=>{
  const f=fixture(t),o=await f.quote();await f.accept(o);f.advance();await f.service.recover();const w=await f.withdrawal(o.review.id);await f.accept(w);
  f.portfolio(u=>u.searchParams.get('page_token')==='next'?{data:[{type:'withdrawal',status:'successful',reference:{kind:'funding',id:'FT-1'}}]}:{data:[{type:'withdrawal',status:'successful',reference:{kind:'transfer',id:'FT-1'}}],next_page_token:'next'});
  f.advance();await f.service.recover();assert.equal(f.service.view(w.review.id,f.owner.publicKey).state,'WITHDRAWAL_PENDING');
  f.advance();await f.service.recover();assert.equal(f.service.view(w.review.id,f.owner.publicKey).state,'PROVIDER_COMPLETED');
});
test('withdrawal pagination resets expired cursor without forgetting its reference; Retry-After is durable',async t=>{
  const f=fixture(t),o=await f.quote();await f.accept(o);f.advance();await f.service.recover();const w=await f.withdrawal(o.review.id);await f.accept(w);
  f.portfolio({});
  const transport=f.adapter.transport;
  const original=transport.request.bind(transport);let phase=0;
  transport.request=async(method,path,...rest)=>{
    if(path.includes('/portfolio/')) {
      if(phase===0)return {data:[],next_page_token:'expired-cursor'};
      if(phase===1)throw new PaywardError(400);
      if(phase===2)throw new PaywardError(429,600000);
      return {data:[]};
    }
    return original(method,path,...rest);
  };
  f.advance();await f.service.recover();phase=1;f.advance();await f.service.recover();
  assert.deepEqual(f.service.view(w.review.id,f.owner.publicKey).result,{state:'WITHDRAWAL_PENDING',reference:'FT-1',cursor:null});
  phase=2;f.advance();await f.service.recover();f.advance(100000);assert.equal((await f.service.recover()).checked,0);
  phase=3;f.advance(600000);assert.equal((await f.service.recover()).checked,1);
});
test('tampered registered destination fails before withdrawal POST; expired/failed trade never permits withdrawal',async t=>{
  const f=fixture(t),o=await f.quote();await f.accept(o);f.quotes.get(o.review.terms.quoteId).status='failed';f.advance();await f.service.recover();
  await assert.rejects(()=>f.withdrawal(o.review.id),/completed trade/);
  const q=await f.quote();await f.accept(q);f.advance();await f.service.recover();const w=await f.withdrawal(q.review.id);
  const original=f.adapter.transport.request.bind(f.adapter.transport);
  f.adapter.transport.request=async(method,path,...rest)=>path.includes('/funds/addresses/')?{data:{address_id:'AB12345-6789A-BCDEFG',scope:{method_id:'method-btc'},address_details:{crypto:{address:'changed-address'}}}}:original(method,path,...rest);
  await f.accept(w);assert.equal(f.calls.filter(c=>c.url.endsWith('/funds/withdrawals')).length,0);
});
test('transport signs exact bytes, rejects credentials for another environment and sanitizes failures',async()=>{
  let requests=0;const credentials=async()=>({version:2,environment:'sandbox',key:'fixture',secret:SECRET});
  const p=new PaywardTransport({credentials,clock:()=>START,fetchImpl:async(url,init)=>{
    requests++;assert.equal(init.redirect,'error');assert.equal(init.headers['API-Sign'],paywardSignature(SECRET,init.headers['API-Timestamp'],init.method,new URL(url).pathname,init.body));
    return new Response('secret provider diagnostic',{status:429});
  }});
  await assert.rejects(()=>p.request('POST','/v1/accounts/a/quotes',{}),/^PaywardError: Payward HTTP 429$/);assert.equal(requests,1);
  await assert.rejects(()=>new PaywardTransport({environment:'production',credentials}).request('GET','/v1/assets'),/environment/);
  await assert.rejects(()=>p.request('GET','https://other.invalid/v1/assets'),/path/);
  const huge=new PaywardTransport({credentials,fetchImpl:async()=>new Response('x'.repeat(1048577))});
  await assert.rejects(()=>huge.request('GET','/v1/assets'),/unavailable/);
});
test('abrupt process exit after provider accepts: committed journal recovers and sends exactly once',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'duebyte-provider-crash-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const signer=keys(),owner=keys(),file=join(dir,'journal.sqlite'),f=fixture(t,{file,signer,owner});const o=await f.quote();
  const cfg=join(dir,'fixture.json');writeFileSync(cfg,JSON.stringify({file,signer,owner,id:o.review.id,signature:f.consent(o),count:join(dir,'dispatch.txt')}));
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('./helpers/provider-crash-child.mjs',import.meta.url)),cfg],{encoding:'utf8'});
  assert.equal(child.status,73,child.stderr);assert(existsSync(join(dir,'dispatch.txt')));
  assert.equal(f.service.view(o.review.id,owner.publicKey).state,'UNKNOWN');
  f.quotes.get(o.review.terms.quoteId).status='executed';f.advance();await f.service.recover();await f.accept(o);
  assert.equal(f.service.view(o.review.id,owner.publicKey).state,'TRADED');assert.equal(readFileSync(join(dir,'dispatch.txt'),'utf8'),'1');
  assert.equal(f.calls.filter(c=>c.url.endsWith('/execute')).length,0);
  f.db.close();
});
test('abrupt exit before dispatch cannot cause a blind resend; expired provider quote closes safely',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'duebyte-provider-before-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const signer=keys(),owner=keys(),file=join(dir,'journal.sqlite'),f=fixture(t,{file,signer,owner});const o=await f.quote();
  const cfg=join(dir,'fixture.json');writeFileSync(cfg,JSON.stringify({file,signer,owner,id:o.review.id,signature:f.consent(o),count:join(dir,'dispatch.txt'),beforeDispatch:true}));
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('./helpers/provider-crash-child.mjs',import.meta.url)),cfg],{encoding:'utf8'});
  assert.equal(child.status,74,child.stderr);assert(!existsSync(join(dir,'dispatch.txt')));
  f.advance(31000);await f.service.recover();assert.equal(f.service.view(o.review.id,owner.publicKey).state,'UNKNOWN');await f.accept(o);
  f.quotes.get(o.review.terms.quoteId).status='expired';f.advance();await f.service.recover();assert.equal(f.service.view(o.review.id,owner.publicKey).state,'EXPIRED');
  assert.equal(f.calls.filter(c=>c.url.endsWith('/execute')).length,0);f.db.close();
});
