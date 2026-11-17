// Authenticated exchange boundary. Run behind TLS, outside consensus and Home.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {exact,hash,sign,verify,publicKey,canonical} from './crypto.mjs';
import {providerPendingStates} from './exchange-provider.mjs';
export const BROKER_API='DUEBYTE_BROKER_API_V1';
const actions=['availability','review','accept','status','operation'];
export class ExchangeBrokerAPI {
  constructor({db,scope,signer,providers,clock=Date.now}) {
    assert(providers.length>=1&&providers.length<=4);this.db=db;this.scope=scope;this.signer=signer;this.clock=clock;
    this.providers=new Map(providers.map(p=>[p.id,p]));assert.equal(this.providers.size,providers.length);
    db.exec(`PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS broker_requests (id TEXT PRIMARY KEY, at INTEGER NOT NULL, reply TEXT);
      CREATE INDEX IF NOT EXISTS broker_requests_age ON broker_requests(at);
      CREATE TABLE IF NOT EXISTS broker_identity (id INTEGER PRIMARY KEY, value TEXT NOT NULL);`);
    const pin=hash({scope,key:signer.publicKey,providers:providers.map(p=>({id:p.id,identity:p.engine.adapter.identity,scope:p.engine.scope}))});
    db.prepare('INSERT OR IGNORE INTO broker_identity VALUES(1,?)').run(pin);
    assert.equal(db.prepare('SELECT value FROM broker_identity WHERE id=1').get().value,pin,'broker journal mismatch');
    this.inflight=0;this.accepting=new Set();
  }
  async call(message) {
    exact(message,['body','signature']);const b=message.body;
    exact(b,['domain','scope','owner','at','nonce','action','payload']);publicKey(b.owner);
    assert.equal(b.domain,BROKER_API);assert.equal(b.scope,this.scope);
    assert(Number.isSafeInteger(b.at)&&Math.abs(this.clock()-b.at)<=30000,'request expired');
    assert(/^[a-f0-9]{64}$/.test(b.nonce));assert(actions.includes(b.action));assert(verify(b,message.signature,b.owner),'wallet authentication failed');
    const id=hash(b),prior=this.db.prepare('SELECT reply FROM broker_requests WHERE id=?').get(id);
    if(prior) {assert(prior.reply,'Request is being reconciled. Refresh saved operations.');return JSON.parse(prior.reply);}
    assert(this.inflight<8,'broker busy');
    // This replay cache is not the financial journal. Expired request signatures cannot be reused.
    this.db.prepare('DELETE FROM broker_requests WHERE at<?').run(this.clock()-120000);
    assert(this.db.prepare('SELECT count(*) n FROM broker_requests WHERE at>?').get(this.clock()-30000).n<300,'request budget exceeded');
    this.db.prepare('INSERT INTO broker_requests VALUES(?,?,NULL)').run(id,b.at);this.inflight++;
    try {
      let result;
      if(b.action==='availability') {
        exact(b.payload,[]);const available=[];
        for(const p of this.providers.values()) {const binding=await p.binding(b.owner),admitted=!!binding&&binding.expiresAt>this.clock();available.push({id:p.id,label:p.label,environment:p.environment,capability:p.engine.adapter.capability??'account_trade',admitted,account:admitted?binding.account:null,routes:admitted?binding.routes:[],destinations:admitted?binding.destinations:[]});}
        result={providers:available};
      } else {
        const p=this.providers.get(b.payload.provider);assert(p,'unknown provider');
        if(b.action==='operation') {
          exact(b.payload,['provider','id']);result=p.engine.view(b.payload.id,b.owner);
        } else if(b.action==='status') {
          exact(b.payload,['provider','offset']);assert(Number.isSafeInteger(b.payload.offset)&&b.payload.offset>=0&&b.payload.offset<=1000000);
          const rows=p.engine.db.prepare('SELECT id FROM provider_exchange_commands WHERE owner=? ORDER BY rowid DESC LIMIT 21 OFFSET ?').all(b.owner,b.payload.offset);
          result={provider:p.id,orders:rows.slice(0,20).map(r=>p.engine.view(r.id,b.owner)),hasMore:rows.length>20,offset:b.payload.offset};
        } else if(b.action==='review') {
          exact(b.payload,['provider','request','parent']);
          const binding=await p.binding(b.owner);assert(binding&&binding.expiresAt>this.clock(),'account admission required');
          result=await p.engine.review({owner:b.owner,account:binding.account,request:b.payload.request,parent:b.payload.parent});
        } else {
          exact(b.payload,['provider','id','consent']);
          assert(!this.accepting.has(b.owner),'Confirmation already in progress');this.accepting.add(b.owner);
          try{
            const current=p.engine.row(b.payload.id,b.owner);
            if(current.state==='REVIEW')for(const other of this.providers.values()){
              const blocked=other.engine.db.prepare(`SELECT id FROM provider_exchange_commands WHERE owner=? AND consent IS NOT NULL AND state IN (${[...providerPendingStates,'ACTION_REQUIRED'].map(s=>"'"+s+"'").join(',')}) LIMIT 1`).get(b.owner);
              assert(!blocked,'Resolve the saved exchange before confirming another provider.');
            }
            result=await p.engine.accept(b.payload.id,b.owner,b.payload.consent);
          }finally{this.accepting.delete(b.owner);}
        }
      }
      const body={domain:BROKER_API+'/REPLY',requestHash:id,result};
      const reply={body,signature:sign(body,this.signer.privateKey)};
      assert(Buffer.byteLength(canonical(reply))<=262144);
      this.db.prepare('UPDATE broker_requests SET reply=? WHERE id=?').run(canonical(reply),id);
      return reply;
    } finally {this.inflight--;}
  }
  async recover() {for(const p of this.providers.values())await p.engine.recover({limit:5});}
}
export function exchangeBrokerServer(api) {
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
    if(req.method!=='POST'||req.url!=='/exchange/v1'||req.headers['content-encoding']){res.writeHead(404);res.end('{}');return;}
    try {let size=0;const chunks=[];for await(const b of req){size+=b.length;assert(size<=16384);chunks.push(b);}const result=await api.call(JSON.parse(Buffer.concat(chunks)));res.end(JSON.stringify(result));}
    catch {res.writeHead(409);res.end(JSON.stringify({error:'Exchange request unavailable or rejected. Refresh saved operations before retrying.'}));}
  });
  server.headersTimeout=5000;server.requestTimeout=10000;server.setTimeout(30000,s=>s.destroy());server.maxConnections=32;
  let recovery=null;const timer=setInterval(()=>{if(recovery)return;recovery=api.recover().catch(()=>{}).finally(()=>{recovery=null;});},5000);timer.unref();server.on('close',()=>clearInterval(timer));
  server.drainExchangeRecovery=async()=>{clearInterval(timer);await recovery;};
  return server;
}
