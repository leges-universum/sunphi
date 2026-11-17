// Dedicated loopback gateway, reached through the installation's pinned SSH route.
// Stores public proofs and signed offers only. No validator, founder or Home keys.
import assert from 'node:assert/strict';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {chmodSync} from 'node:fs';
import {exact,hash,hex,integer} from './crypto.mjs';
import {homePeer} from './research/bounded-home-registration.mjs';
import {assertBoundedServiceView,usesIndexedHomeAdmission} from './research/bounded-wallet-view.mjs';
import {HOME_DELIVERY,validateHomeRequest,validateHomeOffer,homeAdmissionProposal} from './home-admission-protocol.mjs';
const MAX_BYTES=65536;
const endpoint=url=>{const u=new URL(url);assert.equal(u.protocol,'http:');assert.equal(u.hostname,'127.0.0.1');assert(u.port&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/','pinned loopback Home admission route');return u.origin;};
export class HomeAdmissionQueue{
 constructor({file,config,capacity=4096}){
  integer(capacity,1);assert(capacity<=100000);this.config=config;this.capacity=capacity;
  this.db=new DatabaseSync(file);chmodSync(file,0o600);
  this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL); CREATE TABLE IF NOT EXISTS requests (node TEXT PRIMARY KEY, peer TEXT UNIQUE NOT NULL, expires INTEGER NOT NULL, request TEXT NOT NULL, offer TEXT); CREATE INDEX IF NOT EXISTS request_expiry ON requests(expires,node);');
  this.db.prepare('INSERT OR IGNORE INTO binding VALUES(1,?)').run(hash({domain:HOME_DELIVERY,config}));
  try{assert.equal(this.db.prepare('SELECT fingerprint FROM binding WHERE id=1').get().fingerprint,hash({domain:HOME_DELIVERY,config}),'Home queue network binding');}catch(e){this.db.close();throw e;}
 }
 accept(request,state){
  const h=validateHomeRequest(request,this.config,state.money.time),db=this.db;
  db.exec('BEGIN IMMEDIATE');try{
   // Expiration is indexed and bounded; queue pressure delays admission, not consensus.
   db.prepare('DELETE FROM requests WHERE node IN (SELECT node FROM requests WHERE expires<=? ORDER BY expires,node LIMIT 64)').run(state.money.time);
   const old=db.prepare('SELECT request,offer FROM requests WHERE node=?').get(h.node);
   if(old)assert.deepEqual(JSON.parse(old.request).body.home,h,'Home request key replacement');
   else assert(db.prepare('SELECT count(*) AS n FROM requests').get().n<this.capacity,'Home queue busy');
   db.prepare('INSERT INTO requests(node,peer,expires,request) VALUES(?,?,?,?) ON CONFLICT(node) DO UPDATE SET request=CASE WHEN excluded.expires>=expires THEN excluded.request ELSE request END,expires=MAX(expires,excluded.expires)').run(h.node,homePeer(h.identity),request.body.expires,JSON.stringify(request));
   let offer=null;if(old?.offer){try{const candidate=JSON.parse(old.offer);validateHomeOffer(candidate,state,this.config,h);offer=candidate;}catch{db.prepare('UPDATE requests SET offer=NULL WHERE node=?').run(h.node);}}
   db.exec('COMMIT');return {version:HOME_DELIVERY,status:offer?'authorized':'pending',offer};
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 publish(offer,state){
  const node=offer?.certificate?.body?.homes?.[0]?.node;hex(node);const row=this.db.prepare('SELECT request FROM requests WHERE node=?').get(node);assert(row,'Home request missing');
  const h=validateHomeRequest(JSON.parse(row.request),this.config,state.money.time);validateHomeOffer(offer,state,this.config,h);
  this.db.prepare('UPDATE requests SET offer=? WHERE node=?').run(JSON.stringify(offer),node);return {version:HOME_DELIVERY,status:'stored'};
 }
 pending({after='',limit=32}={}){
  assert(after===''||hex(after));integer(limit,1);assert(limit<=32);
  return this.db.prepare('SELECT node,request FROM requests WHERE node>? ORDER BY node LIMIT ?').all(after,limit).map(r=>({node:r.node,request:JSON.parse(r.request)}));
 }
 proposal(node,state){hex(node);const row=this.db.prepare('SELECT request FROM requests WHERE node=?').get(node);assert(row);return homeAdmissionProposal(JSON.parse(row.request),state,this.config);}
 close(){this.db.close();}
}
export async function startHomeAdmissionHTTP({queue,view,port,now=()=>Math.floor(Date.now()/1000)}){
 let busy=false,window=0,requests=0;
 const server=http.createServer(async(req,res)=>{
  const reply=(code,body)=>{if(!res.destroyed){res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));}};
  if(req.method!=='POST'||!['/home-admission/request','/home-admission/offer'].includes(req.url)||req.headers.origin||req.headers['content-type']!=='application/json'||!/^127\.0\.0\.1:\d+$/.test(req.headers.host??'')){req.resume();return reply(400,{error:'Invalid Home enrollment request.'});}
  const second=now();if(second!==window){window=second;requests=0;}if(busy||++requests>30){req.resume();return reply(503,{error:'Home enrollment will retry.'});}busy=true;
  try{
   let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>MAX_BYTES){reply(413,{error:'Enrollment message too large.'});req.destroy();return;}chunks.push(chunk);}
   const value=JSON.parse(Buffer.concat(chunks)),v=await view();assertBoundedServiceView(v.state,v.certificate,queue.config);assert(usesIndexedHomeAdmission(v.state),'indexed Home admission unavailable');assert(Math.abs(now()-v.state.money.time)<=120,'stale enrollment state');
   reply(200,req.url.endsWith('/request')?queue.accept(value,v.state):queue.publish(value,v.state));
  }catch{reply(422,{error:'Enrollment could not be verified. Saved data is retained.'});}finally{busy=false;}
 });
 server.requestTimeout=10000;server.headersTimeout=5000;server.maxHeadersCount=24;server.maxConnections=32;
 await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok);});
 return {port:server.address().port,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
export function homeAdmissionClient(urls){
 assert(Array.isArray(urls)&&urls.length>0&&urls.length<=4);const roots=urls.map(endpoint);assert.equal(new Set(roots).size,roots.length);
 return async request=>{
  for(const root of roots)try{
   const r=await fetch(root+'/home-admission/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),redirect:'error',signal:AbortSignal.timeout(5000)});assert(r.ok);
   let size=0;const chunks=[];for await(const chunk of r.body){size+=chunk.length;assert(size<=MAX_BYTES,'Home offer too large');chunks.push(chunk);}
   const value=JSON.parse(Buffer.concat(chunks));exact(value,['version','status','offer']);assert.equal(value.version,HOME_DELIVERY);assert(['pending','authorized'].includes(value.status));assert(value.status==='authorized'?!!value.offer:value.offer===null);return value.offer;
  }catch{ /* Next pinned delivery route; no alternate authority or remote URLs. */ }
  throw Error('Home enrollment delivery unavailable.');
 };
}
