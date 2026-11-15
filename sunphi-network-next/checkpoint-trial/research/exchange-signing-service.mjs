// Private mTLS recovery endpoint. No activation, arbitrary signing or broadcast API.
import assert from 'node:assert/strict';
import https from 'node:https';
import tls from 'node:tls';
import {exact,integer} from '../crypto.mjs';

const MAX=262144;
const fingerprint=s=>{assert(typeof s==='string'&&/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(s));return s;};
export function signingService({authority,key,cert,ca,clients}){
 assert(Array.isArray(clients)&&clients.length>0&&clients.length<=16);
 const allowed=new Set(clients.map(fingerprint)),session=authority.activate();
 const server=https.createServer({key,cert,ca,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3',maxVersion:'TLSv1.3'},async(req,res)=>{
  const reject=code=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store','connection':'close'});res.end('{"error":"Signing request unavailable or rejected."}');};
  if(!req.socket.authorized||!allowed.has(req.socket.getPeerCertificate().fingerprint256))return reject(403);
  if(req.method!=='POST'||req.url!=='/prepare'||req.headers['content-type']!=='application/json')return reject(404);
  if(req.headers['content-encoding']||req.headers['expect'])return reject(400);
  let size=0;const chunks=[],bodyTimer=setTimeout(()=>req.destroy(),5000);
  try{
   for await(const chunk of req){size+=chunk.length;if(size>MAX){req.destroy();return;}chunks.push(chunk);}
   clearTimeout(bodyTimer);
   const body=JSON.parse(Buffer.concat(chunks));exact(body,['packet','attempt']);integer(body.attempt);assert(body.attempt<=3);
   const result=await authority.prepare(session,body.packet,{attempt:body.attempt});
   const reply=JSON.stringify({result});assert(Buffer.byteLength(reply)<=MAX);
   if(!res.destroyed){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(reply);}
  }catch{if(!res.destroyed)reject(409);}finally{clearTimeout(bodyTimer);}
 });
 server.maxConnections=8;server.maxRequestsPerSocket=1;server.headersTimeout=5000;server.requestTimeout=10000;
 server.setTimeout(30000,socket=>socket.destroy());server.on('tlsClientError',()=>{});
 server.on('checkContinue',(_req,res)=>{res.writeHead(400);res.end();});
 server.on('clientError',(_err,socket)=>socket.destroy());
 return server;
}

// Credentials are supplied by the supervisor, never by the copied worker journal.
export function remotePreparation({url,key,cert,ca,serverFingerprint,timeoutMs=15000}){
 const endpoint=new URL(url);assert(endpoint.protocol==='https:'&&!endpoint.username&&!endpoint.password&&!endpoint.hash&&!endpoint.search&&endpoint.pathname==='/prepare');
 fingerprint(serverFingerprint);integer(timeoutMs,10);assert(timeoutMs<=30000);
 return (packet,{attempt=0}={})=>new Promise((resolve,reject)=>{
  let body;try{integer(attempt);assert(attempt<=3);body=JSON.stringify({packet,attempt});assert(Buffer.byteLength(body)<=MAX);}catch{return reject(Error('Signing request rejected.'));}
  let timer,finished=false;
  const finish=(error,result)=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(Error('Protected signing service unavailable or request rejected.')):resolve(result);};
  const req=https.request(endpoint,{method:'POST',key,cert,ca,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',agent:false,
   checkServerIdentity:(host,c)=>tls.checkServerIdentity(host,c)||(c.fingerprint256===serverFingerprint?undefined:Error('Server identity mismatch')),
   headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
    let size=0;const chunks=[];res.on('data',b=>{size+=b.length;if(size>MAX){finish(true);req.destroy();}else chunks.push(b);});
    res.on('error',()=>finish(true));res.on('aborted',()=>finish(true));res.on('end',()=>{try{assert.equal(res.statusCode,200);const v=JSON.parse(Buffer.concat(chunks));exact(v,['result']);exact(v.result,['raw','transaction']);assert(/^(?:[a-f0-9]{2})+$/.test(v.result.raw)&&v.result.raw.length<=200000&&/^[a-f0-9]{64}$/.test(v.result.transaction));finish(false,v.result);}catch{finish(true);}});
   });
  req.on('error',()=>finish(true));timer=setTimeout(()=>{finish(true);req.destroy();},timeoutMs);req.end(body);
 });
}
