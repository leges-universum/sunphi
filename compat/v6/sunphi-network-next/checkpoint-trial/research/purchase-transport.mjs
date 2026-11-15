// HTTPS is an explicit pinned profile, never an automatic HTTP upgrade/fallback.
import assert from 'node:assert/strict';
import {createServer,request as httpsRequest} from 'node:https';
import {checkServerIdentity} from 'node:tls';
import {X509Certificate} from 'node:crypto';
import {exact,hex,digest} from '../crypto.mjs';
export const spkiPin=cert=>digest(new X509Certificate(cert).publicKey.export({type:'spki',format:'der'}));
export function purchaseTransport(profile){
 exact(profile,['kind','url','spkiSha256','caPem']);assert.equal(profile.kind,'pinned-https-v1');hex(profile.spkiSha256);
 const u=new URL(profile.url);assert(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/purchase/v1'&&u.href===profile.url,'canonical HTTPS purchase endpoint required');
 assert(profile.caPem===null||(typeof profile.caPem==='string'&&profile.caPem.length<32768&&profile.caPem.includes('-----BEGIN CERTIFICATE-----')));return u;
}
export async function securePurchaseRequest(profile,body,{signal,timeoutMs=60000}={}){
 const u=purchaseTransport(profile),data=JSON.stringify(body);assert(Buffer.byteLength(data)<=16384,'purchase request too large');
 return new Promise((resolve,reject)=>{
  let done=false,req;const timer=setTimeout(()=>finish(Error('Purchase endpoint timed out.')),timeoutMs);
  const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);req?.destroy();error?reject(error):resolve(result);};
  try{req=httpsRequest(u,{method:'POST',signal,agent:false,minVersion:'TLSv1.3',rejectUnauthorized:true,...(profile.caPem?{ca:profile.caPem}:{}),headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)},
   checkServerIdentity(host,cert){const error=checkServerIdentity(host,cert);if(error)return error;try{assert.equal(spkiPin(cert.raw),profile.spkiSha256);return undefined;}catch{return Error('Purchase endpoint identity mismatch.');}}
  },res=>{
   if(res.statusCode!==200||!String(res.headers['content-type']).startsWith('application/json'))return finish(Error('Purchase endpoint rejected the request.'));
   let size=0;const chunks=[];res.on('data',chunk=>{size+=chunk.length;if(size>4*1024*1024)return finish(Error('Purchase response too large.'));chunks.push(chunk);});
   res.on('error',()=>finish(Error('Purchase reply interrupted.')));res.on('aborted',()=>finish(Error('Purchase reply interrupted.')));
   res.on('end',()=>{try{const result=JSON.parse(Buffer.concat(chunks));assert(!result.error);finish(null,result);}catch{finish(Error('Purchase reply invalid.'));}});
  });
  req.on('error',()=>finish(Error('Purchase endpoint could not be authenticated or reached.')));req.end(data);
  }catch{finish(Error('Purchase endpoint configuration rejected.'));}
 });
}
// Exposes only the existing signed buyer API. No custody, generic RPC or admin API.
export async function serveSecurePurchaseBroker(broker,{key,cert,hostname,bind='127.0.0.1',port=0,maxPerMinute=60,maxActive=8}={}){
 assert(broker.policy?.isolated===true,'isolated purchase broker required');
 assert(typeof hostname==='string'&&/^[a-z0-9.-]+$/.test(hostname));assert(Number.isInteger(maxPerMinute)&&maxPerMinute>0&&maxPerMinute<=600);assert(Number.isInteger(maxActive)&&maxActive>0&&maxActive<=64);
 const peers=new Map();let active=0,minute=-1;
 const server=createServer({key,cert,minVersion:'TLSv1.3',maxHeaderSize:8192,handshakeTimeout:5000},async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');res.setHeader('X-Content-Type-Options','nosniff');let admitted=false;
  const fail=code=>{res.statusCode=code;res.setHeader('Connection','close');res.end(JSON.stringify({error:'Purchase request unavailable. Retry the existing order; do not pay again.'}));};
  try{
   const m=Math.floor(Date.now()/60000);if(m!==minute){peers.clear();minute=m;}
   const peer=req.socket.remoteAddress,count=peers.get(peer)??0;if((!peers.has(peer)&&peers.size>=4096)||count>=maxPerMinute)return fail(429);peers.set(peer,count+1);
   const authority=hostname+(server.address().port===443?'':':'+server.address().port);
   if(req.method!=='POST'||req.url!=='/purchase/v1'||req.headers.host!==authority||req.headers.origin||req.headers['content-encoding']||req.headers['content-type']!=='application/json')return fail(400);
   if(active>=maxActive)return fail(503);active++;admitted=true;
   if(req.headers['content-length']&&(!/^[0-9]+$/.test(req.headers['content-length'])||Number(req.headers['content-length'])>16384))return fail(413);
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>16384){fail(413);return;}chunks.push(chunk);}
   // Body arrival stays bounded at 15 seconds. A valid reservation may then
   // wait for multiple 10-second blocks; it must outlive the client deadline.
   req.socket.setTimeout(65000);
   const result=await broker.handle(JSON.parse(Buffer.concat(chunks)));const response=JSON.stringify(result);assert(Buffer.byteLength(response)<=4*1024*1024);res.end(response);
  }catch{if(!res.headersSent)fail(400);else res.destroy();}finally{if(admitted)active--;}
 });
 server.maxConnections=64;server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=1000;server.setTimeout(15000,socket=>socket.destroy());
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,bind,resolve);});
 const url='https://'+hostname+(server.address().port===443?'':':'+server.address().port)+'/purchase/v1';
 return {url,spkiSha256:spkiPin(cert),close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
