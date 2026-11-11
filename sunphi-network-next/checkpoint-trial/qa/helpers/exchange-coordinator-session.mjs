import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {spawn,spawnSync} from 'node:child_process';import {createServer} from 'node:net';import {randomBytes,X509Certificate} from 'node:crypto';
import {remoteCoordinator} from '../../research/exchange-coordinator-service.mjs';import {SigningCoordinator} from '../../research/exchange-signing-coordinator.mjs';
export async function coordinatorSession(out,config){
 const dir=path.join(out,'independent-coordinator');fs.mkdirSync(dir);const openssl=process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl';const ssl=args=>assert.equal(spawnSync(openssl,args,{cwd:dir,windowsHide:true,stdio:'ignore'}).status,0);
 ssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','1','-subj','/CN=Isolated coordinator CA']);
 for(const n of ['server','client']){ssl(['req','-newkey','rsa:2048','-nodes','-keyout',n+'.key','-out',n+'.csr','-subj','/CN='+n]);fs.writeFileSync(path.join(dir,n+'.ext'),n==='server'?'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth':'extendedKeyUsage=clientAuth');ssl(['x509','-req','-in',n+'.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out',n+'.pem','-days','1','-extfile',n+'.ext']);}
 const read=n=>fs.readFileSync(path.join(dir,n),'utf8'),fp=n=>new X509Certificate(read(n+'.pem')).fingerprint256;
 const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const key=randomBytes(32),file=path.join(dir,'ledger.sqlite'),profile=path.join(dir,'profile.json');fs.writeFileSync(profile,JSON.stringify({file,config,port,clients:[fp('client')]}));let child;
 const credentials={key:key.toString('hex'),tlsKey:read('server.key'),tlsCert:read('server.pem'),tlsCA:read('ca.pem')};
 const start=async()=>{child=spawn(process.execPath,[path.join(import.meta.dirname,'exchange-coordinator-child.mjs'),profile],{windowsHide:true,stdio:['ignore','pipe','pipe','pipe']});child.stdio[3].on('error',()=>{});child.stdio[3].end(JSON.stringify(credentials));await new Promise((resolve,reject)=>{const t=setTimeout(()=>{child.kill();reject(Error('Coordinator startup timeout'));},15000);child.once('exit',()=>{clearTimeout(t);reject(Error('Coordinator startup failed'));});child.stdout.on('data',b=>{if(b.toString().includes('READY')){clearTimeout(t);resolve();}});});};
 const stop=async()=>{if(!child||child.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill();await done;};
 try{await start();}catch(e){await stop();key.fill(0);throw e;}
 const options={url:'https://127.0.0.1:'+port+'/coordinate',key:read('client.key'),cert:read('client.pem'),ca:read('ca.pem'),serverFingerprint:fp('server'),timeoutMs:3000};
 return {options,channel:remoteCoordinator(options),stop,start,restart:async()=>{await stop();await start();},status:async()=>{await stop();const c=new SigningCoordinator(file,{config,key});try{return c.status();}finally{c.close();await start();}},close:async()=>{await stop();key.fill(0);credentials.key='';}};
}
