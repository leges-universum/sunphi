// Private independent mTLS ledger. No activation, restore, delete or broadcast.
import assert from 'node:assert/strict';import https from 'node:https';import tls from 'node:tls';
import {exact} from '../crypto.mjs';
const MAX=524288;
const fp=v=>assert(typeof v==='string'&&/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(v));
export function coordinatorService({coordinator,key,cert,ca,clients}){
 assert(Array.isArray(clients)&&clients.length>0&&clients.length<=16);clients.forEach(fp);const allowed=new Set(clients),session=coordinator.activate();
 const server=https.createServer({key,cert,ca,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3',maxVersion:'TLSv1.3'},async(req,res)=>{
  const reject=()=>{if(!res.destroyed){res.writeHead(409,{'content-type':'application/json','cache-control':'no-store'});res.end('{"error":"Coordinator unavailable or rejected."}');}};
  if(!req.socket.authorized||!allowed.has(req.socket.getPeerCertificate().fingerprint256)||req.method!=='POST'||req.url!=='/coordinate'||req.headers['content-type']!=='application/json'||req.headers['content-encoding']||req.headers.expect)return reject();
  const timer=setTimeout(()=>req.destroy(),5000);let size=0;const chunks=[];
  try{
   for await(const b of req){size+=b.length;assert(size<=MAX);chunks.push(b);}clearTimeout(timer);
   const body=JSON.parse(Buffer.concat(chunks));exact(body,['method','args',...(body.continuity!==undefined?['continuity']:[])]);assert(['scope','admit','get','reserve','commit','checkpoint'].includes(body.method));assert(Array.isArray(body.args)&&body.args.length===({scope:0,admit:1,get:1,reserve:2,commit:3,checkpoint:1})[body.method]);
   const result=body.method==='scope'?coordinator.scope:coordinator[body.method](session,...body.args,body.continuity),reply=JSON.stringify({result});assert(Buffer.byteLength(reply)<=MAX);
   res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(reply);
  }catch{reject();}finally{clearTimeout(timer);}
 });
 server.maxConnections=8;server.maxRequestsPerSocket=1;server.headersTimeout=5000;server.requestTimeout=10000;server.setTimeout(15000,s=>s.destroy());server.on('tlsClientError',()=>{});server.on('clientError',(_e,s)=>s.destroy());server.on('checkContinue',(_q,r)=>{r.writeHead(400);r.end();});return server;
}
export function remoteCoordinator({url,key,cert,ca,serverFingerprint,timeoutMs=10000,continuity}){
 const endpoint=new URL(url);assert(endpoint.protocol==='https:'&&endpoint.pathname==='/coordinate'&&!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash);fp(serverFingerprint);assert(Number.isSafeInteger(timeoutMs)&&timeoutMs>=10&&timeoutMs<=30000);
 const call=(method,args)=>new Promise((resolve,reject)=>{
  const fail=()=>reject(Error('Independent signing coordinator unavailable or rejected.'));let body;try{body=JSON.stringify({method,args,...(continuity!==undefined?{continuity}:{})});assert(Buffer.byteLength(body)<=MAX);}catch{return fail();}
  let timer;const req=https.request(endpoint,{method:'POST',key,cert,ca,agent:false,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',checkServerIdentity:(host,c)=>tls.checkServerIdentity(host,c)||(c.fingerprint256===serverFingerprint?undefined:Error('Coordinator identity mismatch')),headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
   let size=0;const chunks=[];res.on('data',b=>{size+=b.length;if(size>MAX){req.destroy();fail();}else chunks.push(b);});res.on('error',fail);res.on('aborted',fail);res.on('end',()=>{clearTimeout(timer);try{assert.equal(res.statusCode,200);const v=JSON.parse(Buffer.concat(chunks));exact(v,['result']);resolve(v.result);}catch{fail();}});
  });req.on('error',()=>{clearTimeout(timer);fail();});timer=setTimeout(()=>{req.destroy();fail();},timeoutMs);req.end(body);
 });
 return Object.fromEntries(['scope','admit','get','reserve','commit','checkpoint'].map(name=>[name,(...args)=>call(name,args)]));
}
