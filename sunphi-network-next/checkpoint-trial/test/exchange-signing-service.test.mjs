import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn,spawnSync} from 'node:child_process';import {X509Certificate,randomBytes} from 'node:crypto';import https from 'node:https';
import {keys,hash} from '../crypto.mjs';import {resolutionFixture} from './helpers/exchange-resolution-fixture.mjs';import {createBackend} from './helpers/exchange-service-backend.mjs';import {ExchangeSigningAuthority} from '../research/exchange-signing-authority.mjs';import {remotePreparation} from '../research/exchange-signing-service.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'duebyte-mtls-')),openssl=process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl';
function ssl(args){const r=spawnSync(openssl,args,{cwd:dir,windowsHide:true,encoding:'utf8'});assert.equal(r.status,0,'Test certificate generation failed');}
ssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','1','-subj','/CN=Isolated DueByte QA CA']);
for(const name of ['server','client','outsider']){ssl(['req','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN='+name]);fs.writeFileSync(path.join(dir,name+'.ext'),name==='server'?'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth':'extendedKeyUsage=clientAuth');ssl(['x509','-req','-in',name+'.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out',name+'.pem','-days','1','-extfile',name+'.ext']);}
const read=f=>fs.readFileSync(path.join(dir,f),'utf8'),fp=n=>new X509Certificate(read(n+'.pem')).fingerprint256;
async function fixture(options={}){
 const f=resolutionFixture(),o=f.order(),packet={quote:o.q,providerSignature:o.lock.providerSignature,userSignature:o.lock.userSignature,arm:o.arm,recoveryKind:'REFUND'},identity=keys(),file=path.join(dir,randomBytes(8).toString('hex')+'.sqlite'),key=randomBytes(32).toString('hex');
 const backend={allowed:[hash(packet)],publicKey:identity.publicKey,...options},secrets={privateKey:identity.privateKey};const a=new ExchangeSigningAuthority(file,{config:f.c,key:Buffer.from(key,'hex'),backend:await createBackend(backend,secrets),create:true});a.close();
 const x={file,key,config:f.c,backend,secrets,tls:{key:read('server.key'),cert:read('server.pem'),ca:read('ca.pem'),clients:[fp('client')]}};
 const start=async()=>{const p=spawn(process.execPath,[path.join(import.meta.dirname,'helpers/exchange-service-child.mjs')],{windowsHide:true,stdio:['ignore','pipe','ignore','pipe']});p.stdio[3].end(JSON.stringify(x));
  const port=await new Promise((resolve,reject)=>{let text='';const timeout=setTimeout(()=>{p.kill();reject(Error('Child readiness timeout'));},10000);p.stdout.on('data',b=>{text+=b;if(text.includes('\n')){clearTimeout(timeout);resolve(JSON.parse(text).port);}});p.once('exit',()=>{clearTimeout(timeout);reject(Error('Child startup failed'));});});
  const credentials={url:'https://127.0.0.1:'+port+'/prepare',key:read('client.key'),cert:read('client.pem'),ca:read('ca.pem'),serverFingerprint:fp('server')};
  return {p,credentials,prepare:remotePreparation(credentials),stop:async()=>{if(p.exitCode!==null)return;const done=new Promise(r=>p.once('exit',r));p.kill();await done;}};
 };return {packet,x,start};
}
test('separate process returns identical persisted bytes to copied workers after restart',async()=>{const f=await fixture();let s=await f.start(),first;try{first=await s.prepare(f.packet);assert.deepEqual(await s.prepare(structuredClone(f.packet)),first);assert(!fs.readFileSync(f.x.file).includes(Buffer.from(first.raw)));}finally{await s.stop();}s=await f.start();try{assert.deepEqual(await s.prepare(f.packet),first);}finally{await s.stop();}});
test('same CA is insufficient: unlisted client and mismatched server pin are rejected',async()=>{const f=await fixture(),s=await f.start();try{await assert.rejects(remotePreparation({...s.credentials,key:read('outsider.key'),cert:read('outsider.pem')})(f.packet));await assert.rejects(remotePreparation({...s.credentials,serverFingerprint:fp('outsider')})(f.packet));assert(await s.prepare(f.packet));}finally{await s.stop();}});
test('no client certificate, remote activation and arbitrary signing methods are rejected',async()=>{const f=await fixture(),s=await f.start();try{await assert.rejects(remotePreparation({...s.credentials,key:undefined,cert:undefined})(f.packet));for(const route of ['/activate','/sign','/status']){const status=await new Promise((resolve,reject)=>{const q=https.request(s.credentials.url.replace('/prepare',route),{method:'POST',key:s.credentials.key,cert:s.credentials.cert,ca:s.credentials.ca,agent:false},r=>{r.resume();resolve(r.statusCode);});q.on('error',reject);q.end('{}');});assert.equal(status,404);}await assert.rejects(s.prepare({...f.packet,recoveryKind:'PAYOUT'}));}finally{await s.stop();}});
test('lost transport reply does not permit another signature: retry reads durable bytes',async()=>{
 const signCounterFile=path.join(dir,randomBytes(8).toString('hex')+'.count'),signReleaseFile=signCounterFile+'.release';
 const f=await fixture({signCounterFile,signReleaseFile}),s=await f.start();let request;
 try{
  const body=JSON.stringify({packet:f.packet,attempt:0});
  const lost=new Promise((resolve,reject)=>{
   request=https.request(s.credentials.url,{method:'POST',key:s.credentials.key,cert:s.credentials.cert,ca:s.credentials.ca,agent:false,headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{res.resume();resolve(res.statusCode);});
   request.on('error',reject);request.end(body);
  });
  const lostCheck=assert.rejects(lost),deadline=Date.now()+10000;
  while(!fs.existsSync(signCounterFile)){assert(Date.now()<deadline,'Signing did not start');await new Promise(r=>setTimeout(r,20));}
  request.destroy(Error('Isolated lost reply'));await lostCheck;
  fs.writeFileSync(signReleaseFile,'release');
  let signed;const recoveryDeadline=Date.now()+10000;
  while(!signed){try{signed=await s.prepare(f.packet);}catch(error){if(Date.now()>=recoveryDeadline)throw error;await new Promise(r=>setTimeout(r,25));}}
  assert.deepEqual(await s.prepare(f.packet),signed);
  assert.equal(fs.readFileSync(signCounterFile,'utf8'),'1\n');
 }finally{request?.destroy();if(!fs.existsSync(signReleaseFile))fs.writeFileSync(signReleaseFile,'release');await s.stop();}
});
test('process death during signing remains uncertain and blocked after restart',async()=>{const f=await fixture({crash:true});let s=await f.start();await assert.rejects(s.prepare(f.packet));await s.stop();f.x.backend.crash=false;s=await f.start();try{await assert.rejects(s.prepare(f.packet));}finally{await s.stop();}});
test('malformed and oversized requests fail without poisoning a valid request',async()=>{const f=await fixture(),s=await f.start();try{await assert.rejects(s.prepare(f.packet,{attempt:4}));await assert.rejects(s.prepare({extra:'x'.repeat(300000)}));await assert.rejects(s.prepare({}));assert(await s.prepare(f.packet));}finally{await s.stop();}});
