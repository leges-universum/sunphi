// Linux custody service: separate UID, protected files, supervisor-only FD 3.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createServer} from 'node:net';
import {exact} from '../crypto.mjs';
import {ProtectedSellerSigner} from './purchase-seller-protected.mjs';

function protectedPath(file,{owner=process.getuid(),mode=0o600,directory=false}={}){
 assert(path.isAbsolute(file)&&path.normalize(file)===file);const st=fs.lstatSync(file);
 assert(!st.isSymbolicLink()&&(directory?st.isDirectory():st.isFile()));assert.equal(st.uid,owner);assert.equal(st.mode&0o777,mode);
 // A sticky shared /tmp ancestor is permitted; no writable intermediate path.
 for(let parent=path.dirname(file);;parent=path.dirname(parent)){
  const s=fs.lstatSync(parent);assert(s.isDirectory()&&!s.isSymbolicLink());assert(s.uid===0||s.uid===process.getuid());
  assert((s.mode&0o022)===0||(s.uid===0&&(s.mode&0o1000)!==0),'untrusted writable parent');if(parent==='/')break;
 }
}
function readProtectedJSON(file,options,max){
 protectedPath(file,options);const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{assert(fs.fstatSync(fd).size<=max);return JSON.parse(fs.readFileSync(fd));}finally{fs.closeSync(fd);}
}
let signer,server;
try{
 assert.equal(process.platform,'linux');assert(process.getuid()>0,'dedicated non-root signer required');process.umask(0o077);
 const [profileFile,vaultFile,journal,socketPath]=process.argv.slice(2);assert.equal(process.argv.length,6);
 const profile=readProtectedJSON(profileFile,{owner:0,mode:0o644},2*1024*1024),bundle=readProtectedJSON(vaultFile,{},34*1024*1024);
 protectedPath(journal);protectedPath(path.dirname(socketPath),{mode:0o750,directory:true});assert(!fs.existsSync(socketPath),'socket already exists');
 const secret=Buffer.alloc(4097);let size=0,password;
 try{assert(fs.fstatSync(3).isFIFO()||fs.fstatSync(3).isSocket(),'supervisor password pipe required');
  while(size<secret.length){const n=fs.readSync(3,secret,size,secret.length-size,null);if(!n)break;size+=n;}
  assert(size>0&&size<secret.length);password=secret.subarray(0,size).toString('utf8');
  signer=new ProtectedSellerSigner({profile,bundle,password,journal});
 }finally{secret.fill(0);password=undefined;fs.closeSync(3);}
 server=createServer(socket=>{
  let data=[],size=0,handled=false;socket.setTimeout(5000,()=>socket.destroy());socket.on('error',()=>{});
  socket.on('data',chunk=>{
   if(handled)return;size+=chunk.length;if(size>16384){handled=true;socket.destroy();return;}data.push(chunk);if(!chunk.includes(10))return;handled=true;
   try{const m=JSON.parse(Buffer.concat(data));exact(m,['action','payload']);assert(['quote','prepare'].includes(m.action));
    socket.end(JSON.stringify({result:signer[m.action](m.payload)})+'\n');
   }catch{socket.end(JSON.stringify({error:'Seller signing request rejected.'})+'\n');}
  });
 });
 server.maxConnections=8;server.on('error',()=>{signer?.close();process.stderr.write('Protected seller unavailable.\n');process.exit(1);});
 server.listen(socketPath,()=>{fs.chmodSync(socketPath,0o660);process.stdout.write('READY\n');});
 const stop=()=>{server.close(()=>{signer.close();process.exit(0);});setTimeout(()=>process.exit(1),2000).unref();};
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
}catch{signer?.close();process.stderr.write('Protected seller unavailable.\n');process.exit(1);}
