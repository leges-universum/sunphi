import fs from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
// Disposable lab certificate. Never reuse as a production trust anchor.
export function purchaseTlsFixture(dir){
 fs.mkdirSync(dir,{recursive:true});
 const keyFile=join(dir,'tls-test.key'),certFile=join(dir,'tls-test.pem');
 const exe=process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl';
 execFileSync(exe,['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-keyout',keyFile,'-out',certFile],{stdio:'ignore',windowsHide:true});
 return {key:fs.readFileSync(keyFile),cert:fs.readFileSync(certFile),hostname:'localhost',caPem:fs.readFileSync(certFile,'utf8')};
}
