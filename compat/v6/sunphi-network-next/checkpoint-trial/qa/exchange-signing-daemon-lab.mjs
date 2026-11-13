// Real Linux privilege boundary, synthetic identities only. No chain RPC/write.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {spawn,spawnSync} from 'node:child_process';import {createServer} from 'node:net';import {X509Certificate,randomBytes} from 'node:crypto';
import {keys,hash,digest} from '../crypto.mjs';import {resolutionFixture} from '../test/helpers/exchange-resolution-fixture.mjs';import {createBackend} from '../test/helpers/exchange-service-backend.mjs';import {ExchangeSigningAuthority} from '../research/exchange-signing-authority.mjs';import {remotePreparation} from '../research/exchange-signing-service.mjs';
import {sealSigningVault} from '../research/exchange-signing-vault.mjs';
import {coordinatorSession} from './helpers/exchange-coordinator-session.mjs';
assert(process.platform==='linux'&&process.getuid()===0);process.umask(0o077);
const root=path.resolve(import.meta.dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'duebyte-daemon54-'));fs.chmodSync(dir,0o755);
const command=(exe,args)=>{const r=spawnSync(exe,args,{cwd:dir,encoding:'utf8'});assert.equal(r.status,0,'Isolated setup command failed');return r.stdout.trim();};
const uid=Number(command('id',['-u','nobody'])),gid=Number(command('id',['-g','nobody']));assert(uid>0&&gid>0);
command('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','1','-subj','/CN=Isolated daemon CA']);
for(const name of ['server','client']){command('openssl',['req','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN='+name]);fs.writeFileSync(dir+'/'+name+'.ext',name==='server'?'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth':'extendedKeyUsage=clientAuth');command('openssl',['x509','-req','-in',name+'.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out',name+'.pem','-days','1','-extfile',name+'.ext']);}
const read=f=>fs.readFileSync(dir+'/'+f,'utf8'),fp=n=>new X509Certificate(read(n+'.pem')).fingerprint256;
const f=resolutionFixture(),o=f.order(),packet={quote:o.q,providerSignature:o.lock.providerSignature,userSignature:o.lock.userSignature,arm:o.arm,recoveryKind:'REFUND'},identity=keys(),inventoryKey=randomBytes(32).toString('hex');
const coordinator=await coordinatorSession(dir,f.c);
try{
const {key:clientKey,cert,ca,...publicOptions}=coordinator.options;
const other=f.order('SELL_DUBYT'),otherPacket={quote:other.q,providerSignature:other.lock.providerSignature,userSignature:other.lock.userSignature,arm:other.arm,recoveryKind:'REFUND'};
// Separate order with the same synthetic backend resource must be refused.
const state=dir+'/state';fs.mkdirSync(state,0o700);fs.chownSync(state,uid,gid);
const backendConfig={allowed:[hash(packet),hash(otherPacket)],publicKey:identity.publicKey,signCounterFile:state+'/sign-count',coordinator:publicOptions},backendSecrets={privateKey:identity.privateKey,coordinator:{key:clientKey,cert,ca}};
const inventory=state+'/inventory.sqlite';const a=new ExchangeSigningAuthority(inventory,{config:f.c,key:Buffer.from(inventoryKey,'hex'),backend:await createBackend(backendConfig,backendSecrets),create:true});a.close();fs.chownSync(inventory,uid,gid);fs.chmodSync(inventory,0o600);
const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const profile=dir+'/profile.json';fs.writeFileSync(profile,JSON.stringify({config:f.c,inventory,backend:root+'/test/helpers/exchange-service-backend.mjs',backendConfig,clients:[fp('client')],port}),{mode:0o644});fs.chmodSync(profile,0o644);
const secret={inventoryKey,tlsKey:read('server.key'),tlsCert:read('server.pem'),tlsCA:read('ca.pem'),backendSecrets};
async function launch(nonroot=true,profileFile=profile,input=JSON.stringify(secret)){
 const args=[process.execPath,root+'/research/exchange-signing-daemon.mjs',profileFile],p=spawn(nonroot?'setpriv':process.execPath,nonroot?['--reuid',String(uid),'--regid',String(gid),'--clear-groups',...args]:args.slice(1),{stdio:['ignore','pipe','ignore','pipe']});
 p.stdio[3].on('error',()=>{});p.stdio[3].end(input);
 await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>{p.kill();reject(Error('Daemon readiness timeout'));},10000);p.once('exit',()=>{clearTimeout(timer);reject(Error('Daemon startup refused'));});p.stdout.on('data',b=>{output+=b;if(output.includes('READY')){clearTimeout(timer);resolve();}});});return p;
}
async function stop(p){const done=new Promise(r=>p.once('exit',r));p.kill('SIGTERM');await done;}
const prepare=remotePreparation({url:'https://127.0.0.1:'+port+'/prepare',key:read('client.key'),cert:read('client.pem'),ca:read('ca.pem'),serverFingerprint:fp('server')});
await assert.rejects(launch(false));let p=await launch(),signed;
try{const status=fs.readFileSync('/proc/'+p.pid+'/status','utf8');assert(status.includes('Uid:\t'+uid));signed=await prepare(packet);assert.deepEqual(await prepare(packet),signed);}finally{await stop(p);}
p=await launch();try{assert.deepEqual(await prepare(packet),signed);}finally{await stop(p);}
const clone=state+'/clone.sqlite';fs.copyFileSync(inventory,clone);fs.chownSync(clone,uid,gid);fs.chmodSync(clone,0o600);
const cloneProfile=dir+'/clone-profile.json';const cloneConfig={...JSON.parse(read('profile.json')),inventory:clone};fs.writeFileSync(cloneProfile,JSON.stringify(cloneConfig));fs.chmodSync(cloneProfile,0o644);
p=await launch(true,cloneProfile);try{assert.deepEqual(await prepare(packet),signed);await assert.rejects(prepare(otherPacket));await coordinator.stop();await assert.rejects(prepare(packet));await coordinator.start();assert.deepEqual(await prepare(packet),signed);}finally{await stop(p);}
assert.equal(fs.readFileSync(state+'/sign-count','utf8'),'1\n');
await coordinator.stop();await assert.rejects(launch());await coordinator.start();
const missing=JSON.parse(read('profile.json'));delete missing.backendConfig.coordinator;const missingFile=dir+'/missing-coordinator.json';fs.writeFileSync(missingFile,JSON.stringify(missing));fs.chmodSync(missingFile,0o644);await assert.rejects(launch(true,missingFile));
const override=structuredClone(secret);override.backendSecrets.coordinator.url=publicOptions.url;await assert.rejects(launch(true,profile,JSON.stringify(override)));
fs.chmodSync(profile,0o666);await assert.rejects(launch());fs.chmodSync(profile,0o644);
fs.chmodSync(inventory,0o644);await assert.rejects(launch());fs.chmodSync(inventory,0o600);
fs.renameSync(inventory,inventory+'.retained');await assert.rejects(launch());fs.renameSync(inventory+'.retained',inventory);
const unsafeProfile=state+'/profile.json';fs.writeFileSync(unsafeProfile,fs.readFileSync(profile),{mode:0o644});await assert.rejects(launch(true,unsafeProfile));
const password=randomBytes(32),publicProfile=JSON.parse(read('profile.json')),vaultFile=state+'/keys.enc.json',vaultBytes=Buffer.from(JSON.stringify(sealSigningVault(secret,publicProfile,password)));
fs.writeFileSync(vaultFile,vaultBytes,{mode:0o600});fs.chownSync(vaultFile,uid,gid);
publicProfile.vault={file:vaultFile,sha256:digest(vaultBytes)};const vaultProfile=dir+'/vault-profile.json';fs.writeFileSync(vaultProfile,JSON.stringify(publicProfile),{mode:0o644});fs.chmodSync(vaultProfile,0o644);
p=await launch(true,vaultProfile,password);try{assert.deepEqual(await prepare(packet),signed);}finally{await stop(p);}
await assert.rejects(launch(true,vaultProfile,randomBytes(32)));
fs.chmodSync(vaultFile,0o644);await assert.rejects(launch(true,vaultProfile,password));fs.chmodSync(vaultFile,0o600);
fs.writeFileSync(vaultFile,Buffer.from('{}'));await assert.rejects(launch(true,vaultProfile,password));password.fill(0);
assert.equal(fs.readFileSync(state+'/sign-count','utf8'),'1\n');assert.equal((await coordinator.status()).length,1);
console.log(JSON.stringify({passed:true,checks:17,dedicatedNonrootUid:true,credentialPipe:true,mtls:true,restartReplay:true,unsafePermissionsRefused:true,mutableConfigParentRefused:true,missingInventoryRefused:true,encryptedVault:true,wrongPasswordRefused:true,vaultTamperRefused:true,sharedInventory:true,cloneReplayWithoutSigning:true,outageRefused:true,missingCoordinatorRefused:true,credentialPolicyOverrideRefused:true,syntheticSigningOnly:true,productionKeys:false,issuance:false}));
}finally{await coordinator.close();}
