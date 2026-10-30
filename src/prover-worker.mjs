import { Cache,PrivateKey } from 'o1js';
import { compileCircuit,Statement,Note,proveMint,proveTransfer } from './circuit.mjs';
import { VK_SHA256,digest,exact } from './protocol.mjs';
if(!process.send||!process.argv[2])throw new Error('private IPC process required');
const send=m=>process.send(m);
const {verificationKey}=await compileCircuit(Cache.FileSystem(process.argv[2]));
if(digest(verificationKey.data)!==VK_SHA256)throw new Error('circuit identity mismatch');
let chain=Promise.resolve();
process.on('message',m=>{
  chain=chain.then(async()=>{
    try{
      const p=m.payload;exact(p,['kind','statement','notes','keys']);
      if(!Array.isArray(p.notes)||!Array.isArray(p.keys))throw new Error('private input shape');
      send({type:'progress',id:m.id,phase:'proving'});
      const s=Statement.fromJSON(p.statement),n=p.notes.map(x=>Note.fromJSON(x));let proof;
      if(p.kind==='mint'&&n.length===2&&p.keys.length===0)proof=await proveMint(s,...n);
      else if(p.kind==='transfer'&&n.length===4&&p.keys.length===2){const keys=p.keys.map(k=>PrivateKey.fromBase58(k));proof=await proveTransfer(s,n[0],n[1],keys[0],keys[1],n[2],n[3]);}
      else throw new Error('private input count');
      send({id:m.id,proof});
    }catch{send({id:m.id,error:'proof generation failed; private witness was not logged'});}
    finally{m.payload=null;}
  });
});
send({type:'ready'});
process.on('disconnect',()=>process.exit(0));
