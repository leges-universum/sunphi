// Provider-neutral command journal. Runs in the exchange service, never in consensus.
import assert from 'node:assert/strict';
import {randomUUID, randomBytes, createCipheriv, createDecipheriv} from 'node:crypto';
import {canonical, hash, sign, verify, publicKey} from './crypto.mjs';

export const PROVIDER_REVIEW_DOMAIN = 'DUEBYTE_PROVIDER_REVIEW_V1';
export const providerConsent = review => ({domain:'DUEBYTE_PROVIDER_CONSENT_V1',reviewHash:hash(review)});
export const providerPendingStates = ['UNKNOWN','EXECUTING','WITHDRAWAL_PENDING','SWAP_WAITING','SWAP_CONFIRMING','SWAP_EXCHANGING','SWAP_SENDING','SWAP_VERIFYING'];
const pending=providerPendingStates,pendingSQL="'"+pending.join("','")+"'";
const states = new Set([...pending,'TRADED','EXPIRED','FAILED','PROVIDER_COMPLETED','REFUND_REPORTED','ACTION_REQUIRED']);
export function decimal(value) {
  assert(typeof value === 'string' && /^(0|[1-9][0-9]{0,39})(\.[0-9]{1,18})?$/.test(value),'decimal string required');
  return value;
}
export function units(value) { decimal(value); const [a,b='']=value.split('.'); return BigInt(a)*10n**18n+BigInt(b.padEnd(18,'0')); }
export function verifyProviderReview(review, signature, key) { return review?.domain===PROVIDER_REVIEW_DOMAIN && verify(review,signature,key); }

export class ProviderExchange {
  constructor(db,{adapter,scope,storageKey,signingKey,clock=Date.now}) {
    assert(Buffer.isBuffer(storageKey)&&storageKey.length===32,'journal encryption key required');
    assert(typeof scope==='string'&&scope.length>0&&scope.length<200);
    this.db=db; this.adapter=adapter; this.scope=scope; this.key=Buffer.from(storageKey); this.signingKey=signingKey; this.clock=clock;
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS provider_exchange_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_exchange_commands (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, account TEXT NOT NULL, kind TEXT NOT NULL,
        provider_ref TEXT NOT NULL, parent TEXT, review TEXT NOT NULL, signature TEXT NOT NULL,
        sealed TEXT NOT NULL, state TEXT NOT NULL, consent TEXT, result TEXT,
        next_poll INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
        checked_at INTEGER NOT NULL DEFAULT 0, error_code TEXT,
        UNIQUE(account,kind,provider_ref));
      CREATE INDEX IF NOT EXISTS provider_exchange_due ON provider_exchange_commands(state,next_poll);
      CREATE INDEX IF NOT EXISTS provider_exchange_owner ON provider_exchange_commands(owner);
      CREATE UNIQUE INDEX IF NOT EXISTS provider_exchange_withdraw_once ON provider_exchange_commands(parent) WHERE consent IS NOT NULL;`);
    // Wrong environment, account realm, signer or lost encryption key must fail before any outbound call.
    const fingerprint=hash({scope,provider:adapter.identity,key:storageKey.toString('base64'),signer:signingKey.publicKey});
    db.prepare('INSERT OR IGNORE INTO provider_exchange_identity VALUES(1,?)').run(fingerprint);
    assert.equal(db.prepare('SELECT fingerprint FROM provider_exchange_identity WHERE singleton=1').get().fingerprint,fingerprint,'exchange journal scope/key mismatch');
  }
  seal(id,value) {
    const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv);
    c.setAAD(Buffer.from(this.scope+':'+id));
    return [iv,Buffer.concat([c.update(canonical(value)),c.final()]),c.getAuthTag()].map(b=>b.toString('base64')).join('.');
  }
  unseal(row) {
    const [iv,body,tag]=row.sealed.split('.').map(s=>Buffer.from(s,'base64')),d=createDecipheriv('aes-256-gcm',this.key,iv);
    d.setAAD(Buffer.from(this.scope+':'+row.id)); d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(body),d.final()]).toString());
  }
  row(id,owner) {
    const row=this.db.prepare('SELECT * FROM provider_exchange_commands WHERE id=? AND owner=?').get(id,owner);
    assert(row,'exchange operation not found'); return row;
  }
  view(id,owner) {
    const r=this.row(id,owner);
    if(r.state==='REVIEW'&&JSON.parse(r.review).expiresAt<=this.clock())r.state='EXPIRED';
    return {review:JSON.parse(r.review),signature:r.signature,state:r.state,result:r.result?JSON.parse(r.result):null,
      progress:providerProgress(r.state),checkedAt:r.checked_at||null,nextCheckAt:pending.includes(r.state)?r.next_poll:null,errorCode:r.error_code};
  }
  async review({owner,account,request,parent=null}) {
    publicKey(owner);
    assert(typeof account==='string'&&account.length<=128);
    let source=null;
    if(request.kind==='withdraw') {
      assert(parent,'trade required before withdrawal'); source=this.row(parent,owner);
      assert(source.state==='TRADED'&&source.account===account&&source.kind==='trade','completed trade required');
      const quote=JSON.parse(source.review).terms;
      assert.equal(request.symbol,quote.to.symbol); assert.equal(units(request.amount),units(quote.to.amount),'withdraw exactly the reviewed trade proceeds');
    } else assert((request.kind==='trade'||request.kind==='swap'&&this.adapter.capability==='deposit_swap')&&parent===null,'unsupported operation');
    const prepared=await this.adapter.review({owner,account,request});
    const now=this.clock(); assert(Number.isSafeInteger(prepared.expiresAt)&&prepared.expiresAt>now,'expired review');
    const id=randomUUID(),review={domain:PROVIDER_REVIEW_DOMAIN,id,scope:this.scope,provider:this.adapter.identity,
      owner,account,kind:request.kind,parent,createdAt:now,expiresAt:prepared.expiresAt,terms:prepared.terms};
    const signature=sign(review,this.signingKey.privateKey);
    const sealed=this.seal(id,{payload:prepared.payload,request});
    this.db.prepare(`INSERT INTO provider_exchange_commands(id,owner,account,kind,provider_ref,parent,review,signature,sealed,state)
      VALUES(?,?,?,?,?,?,?,?,?,'REVIEW')`).run(id,owner,account,request.kind,request.kind==='withdraw'?id:prepared.reference,parent,canonical(review),signature,sealed);
    return this.view(id,owner);
  }
  async accept(id,owner,signature) {
    let r=this.row(id,owner); const review=JSON.parse(r.review);
    assert(verify(providerConsent(review),signature,owner),'matching wallet consent required');
    if(r.state!=='REVIEW') return this.view(id,owner); // replay never dispatches twice
    assert(this.clock()<review.expiresAt,'quote expired; review a new quote');
    const data=this.unseal(r);
    await this.adapter.authorize({owner,account:r.account,request:data.request});
    assert(this.clock()<review.expiresAt,'quote expired during authorization');
    // Committed UNKNOWN is the dispatch fence. Even a process killed before POST is never blindly replayed.
    const claimed=this.db.prepare(`UPDATE provider_exchange_commands SET state='UNKNOWN',consent=?,next_poll=?
      WHERE id=? AND state='REVIEW'`).run(signature,this.clock()+30000,id);
    if(!claimed.changes) return this.view(id,owner);
    try {
      const result=await this.adapter.execute({account:r.account,kind:r.kind,payload:data.payload,idempotencyKey:id});
      this.save(id,result);
    } catch(e) { this.defer(id,e); /* no raw provider error/secret logging */ }
    return this.view(id,owner);
  }
  save(id,result) {
    assert(states.has(result.state),'invalid provider state');
    // A delayed POST response cannot overwrite a terminal result from another reconciler.
    this.db.prepare(`UPDATE provider_exchange_commands SET state=?,result=?,next_poll=?,checked_at=?,error_code=NULL
      WHERE id=? AND state IN (${pendingSQL})`)
      .run(result.state,canonical(result),this.clock()+5000,this.clock(),id);
  }
  defer(id,error) {
    const code=error?.status===429?'RATE_LIMITED':error?.name==='AssertionError'?'RESPONSE_MISMATCH':'PROVIDER_UNAVAILABLE';
    this.db.prepare(`UPDATE provider_exchange_commands SET error_code=? WHERE id=? AND state IN (${pendingSQL})`).run(code,id);
    if(Number.isSafeInteger(error?.retryAfterMs)&&error.retryAfterMs>0) {
      this.db.prepare('UPDATE provider_exchange_commands SET next_poll=max(next_poll,?) WHERE id=?')
        .run(this.clock()+Math.min(86400000,error.retryAfterMs),id);
    }
  }
  async recover({limit=20}={}) {
    assert(Number.isInteger(limit)&&limit>=1&&limit<=50);
    const rows=this.db.prepare(`SELECT id,owner FROM provider_exchange_commands
      WHERE state IN (${pendingSQL}) AND next_poll<=? ORDER BY next_poll,id LIMIT ?`).all(this.clock(),limit);
    let checked=0;
    for(const {id,owner} of rows) {
      const r=this.row(id,owner),now=this.clock();
      // Durable poll lease and capped exponential backoff; UI reads the journal, not the provider.
      const delay=Math.min(300000,5000*2**Math.min(r.attempts,6));
      if(!this.db.prepare(`UPDATE provider_exchange_commands SET next_poll=?,attempts=attempts+1
        WHERE id=? AND next_poll=? AND next_poll<=? AND state IN (${pendingSQL})`)
        .run(now+delay,id,r.next_poll,now).changes) continue;
      checked++;
      try {
        const data=this.unseal(r);
        const result=await this.adapter.reconcile({account:r.account,kind:r.kind,payload:data.payload,result:r.result?JSON.parse(r.result):null});
        // Successful swaps use bounded 30s service polling; failures back off. UI never polls the venue.
        assert(states.has(result.state));
        const swap=r.kind==='swap';
        this.db.prepare(`UPDATE provider_exchange_commands SET state=?,result=?,checked_at=?,error_code=NULL,
          next_poll=?,attempts=? WHERE id=? AND next_poll=? AND attempts=? AND state IN (${pendingSQL})`)
          .run(result.state,canonical(result),this.clock(),swap?this.clock()+30000:now+delay,swap?0:r.attempts+1,id,now+delay,r.attempts+1);
      } catch(e) {this.defer(id,e); /* failure leaves the original financial state intact */ }
    }
    return {checked};
  }
}

// Same stages for BTC/USDC/USDT/XMR. Provider settlement is NOT wallet delivery.
export function providerProgress(state) {
  const map={REVIEW:['Review exchange',false,1],UNKNOWN:['Checking exchange result',true,2],EXECUTING:['Exchanging',true,2],
    SWAP_WAITING:['Awaiting your deposit — pay only once',true,2],SWAP_CONFIRMING:['Deposit detected; waiting for network confirmations',true,2],
    SWAP_EXCHANGING:['Exchanging your deposit',true,3],SWAP_SENDING:['Sending the exchanged funds',true,4],
    SWAP_VERIFYING:['Provider verification required; keep this operation',false,3],REFUND_REPORTED:['Provider reports a refund; verify receipt in your wallet',false,4],
    TRADED:['Exchange completed; withdrawal required',false,3],WITHDRAWAL_PENDING:['Sending to your wallet',true,4],
    PROVIDER_COMPLETED:['Provider reports sent; verify receipt in your wallet',false,4],
    ACTION_REQUIRED:['Result needs reconciliation; do not send again',false,2],EXPIRED:['Quote expired; request a new quote',false,1],FAILED:['Provider reports failure',false,2]};
  assert(map[state]); const [label,busy,step]=map[state]; return {label,busy,step,totalSteps:4,delivered:false};
}
