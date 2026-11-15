// Bounded Unix-socket client. The coordinator never receives an unlock password.
import assert from 'node:assert/strict';
import {createConnection} from 'node:net';
export function connectProtectedSeller(socketPath){
 const call=(action,payload)=>new Promise((resolve,reject)=>{
  const socket=createConnection(socketPath);let parts=[],bytes=0,done=false;
  const finish=(error,result)=>{if(done)return;done=true;socket.destroy();error?reject(error):resolve(result);};
  socket.setTimeout(15000,()=>finish(Error('Seller signer timeout.')));
  socket.on('error',()=>finish(Error('Seller signer unavailable.')));
  socket.on('connect',()=>{const data=JSON.stringify({action,payload})+'\n';if(Buffer.byteLength(data)>16384)return finish(Error('Signing request too large.'));socket.write(data);});
  socket.on('data',data=>{bytes+=data.length;if(bytes>262144)return finish(Error('Signing reply too large.'));parts.push(data);
   if(data.includes(10)){try{const r=JSON.parse(Buffer.concat(parts));assert(!r.error&&r.result);finish(null,r.result);}catch{finish(Error('Seller signing request rejected.'));}}
  });
  socket.on('close',()=>{if(!done)finish(Error('Seller signer disconnected.'));});
 });
 return {quote:p=>call('quote',p),prepare:p=>call('prepare',p),close:async()=>{}};
}
