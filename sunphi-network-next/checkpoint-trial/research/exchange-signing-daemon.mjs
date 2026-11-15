// Supervisor launches a dedicated Linux UID. Backend code belongs to root.
// Credentials arrive on FD3; no secret in argv, environment, profile or journal.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {ExchangeSigningAuthority} from './exchange-signing-authority.mjs';
import {signingService} from './exchange-signing-service.mjs';
import {exact,digest} from '../crypto.mjs';
import {openSigningVault} from './exchange-signing-vault.mjs';
import {connectSigningCoordinator} from './exchange-signing-coordination.mjs';

function protectedFile(file,owner,mode,max){
 assert(path.isAbsolute(file)&&path.normalize(file)===file);
 for(let dir=path.dirname(file);;dir=path.dirname(dir)){
  const s=fs.lstatSync(dir);assert(s.isDirectory()&&!s.isSymbolicLink());assert(s.uid===0||(owner!==0&&s.uid===process.getuid()));
  assert((s.mode&0o022)===0||(s.uid===0&&(s.mode&0o1000)!==0));if(dir==='/')break;
 }
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const st=fs.fstatSync(fd);assert(st.isFile()&&st.uid===owner&&(st.mode&0o777)===mode&&st.size<=max);return fs.readFileSync(fd);}finally{fs.closeSync(fd);}
}
let authority,server,backend;
try{
 assert(process.platform==='linux'&&process.getuid()>0,'dedicated Linux UID required');process.umask(0o077);assert.equal(process.argv.length,3);
 const p=JSON.parse(protectedFile(process.argv[2],0,0o644,2097152));
 exact(p,['config','inventory','backend','backendConfig','clients','port',...(p.vault?['vault']:[])]);assert(Number.isInteger(p.port)&&p.port>=1024&&p.port<=65535);
 let vault;
 if(p.vault){exact(p.vault,['file','sha256']);const bytes=protectedFile(p.vault.file,process.getuid(),0o600,100000);assert.equal(digest(bytes),p.vault.sha256);vault=JSON.parse(bytes);}
 protectedFile(p.inventory,process.getuid(),0o600,67108864);protectedFile(p.backend,0,0o644,1048576);
 // The entire imported backend installation must be root-owned/read-only.
 // Operators install a reviewed backend; clients cannot choose code or keys.
 const input=Buffer.alloc(65537);let n=0,secrets;
 try{
  const st=fs.fstatSync(3);assert(st.isFIFO()||st.isSocket());
  while(n<input.length){const k=fs.readSync(3,input,n,input.length-n,null);if(!k)break;n+=k;}
  assert(n>0&&n<input.length);secrets=vault?openSigningVault(vault,p,input.subarray(0,n)):JSON.parse(input.subarray(0,n));
  exact(secrets,['inventoryKey','tlsKey','tlsCert','tlsCA','backendSecrets']);assert(/^[a-f0-9]{64}$/.test(secrets.inventoryKey));
  const coordinator=await connectSigningCoordinator(p,secrets);
  const {createBackend}=await import(pathToFileURL(p.backend));backend=await createBackend(p.backendConfig,secrets.backendSecrets);
  const key=Buffer.from(secrets.inventoryKey,'hex');
  try{authority=new ExchangeSigningAuthority(p.inventory,{config:p.config,key,backend,coordinator});}finally{key.fill(0);}
  server=signingService({authority,key:secrets.tlsKey,cert:secrets.tlsCert,ca:secrets.tlsCA,clients:p.clients});
 }finally{input.fill(0);secrets=undefined;fs.closeSync(3);}
 // Only a local authenticated tunnel may reach this service. No public listener.
 server.listen(p.port,'127.0.0.1',()=>process.stdout.write('READY\n'));
 server.on('error',()=>process.exit(1));
 const stop=()=>{server.close(async()=>{try{authority.close();await backend.close?.();process.exit(0);}catch{process.exit(1);}});setTimeout(()=>process.exit(1),5000).unref();};
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
}catch{process.stderr.write('Protected signing service refused startup.\n');process.exit(1);}
