// Operator-local Ed25519 signatures for one reviewed bond. No RPC client.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sign,verify} from './crypto.mjs';
import {checkBondRequest} from './bond-request.mjs';

const [role,approvedFile,requestFile,keyFile,output]=process.argv.slice(2);
assert(['validator','worker'].includes(role) && output,'Usage: bond-operator.mjs validator|worker approved-template.json request.json local-key.json output.json');
function read(file) {
 assert(fs.statSync(file).size<=16384,'File too large.');
 return JSON.parse(fs.readFileSync(file,'utf8'));
}
const {template}=read(approvedFile),request=read(requestFile);
assert.deepEqual(request.template,template,'Use the independently reviewed template for this server.');
const roles=role==='worker'?['validator']:[];
const now=()=>Math.floor(Date.now()/1000);
checkBondRequest(request,now(),roles);
const key=read(keyFile);
let secret;
if(role==='worker'){
 assert(key.publicKey===template.workerKey && key.node===template.node,'Wrong worker key.');
 secret=key.privateKey;
}else{
 assert(key.pub_key?.type==='tendermint/PubKeyEd25519' && key.priv_key?.type==='tendermint/PrivKeyEd25519','Expected local Comet Ed25519 key.');
 assert.equal(Buffer.from(key.pub_key.value,'base64').toString('base64url'),template.validator,'Wrong validator key.');
 const raw=Buffer.from(key.priv_key.value,'base64');
 assert.equal(raw.length,64);
 secret=Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),raw.subarray(0,32)]).toString('base64url');
 raw.fill(0);
}
const signature=sign(request.body,secret);
assert(verify(request.body,signature,role==='worker'?template.workerKey:template.validator),'Key mismatch.');
const result={...request,[role+'Signature']:signature};
checkBondRequest(result,now(),[...roles,role]);
// Install a complete file exactly once. Retrying a completed step is idempotent.
const temp=output+'.'+randomUUID()+'.tmp';
try{
 fs.writeFileSync(temp,JSON.stringify(result,null,2),{flag:'wx',mode:0o600,flush:true});
 try{fs.linkSync(temp,output);}catch(e){if(e.code!=='EEXIST')throw e;assert.deepEqual(read(output),result,'Output file belongs to another request.');}
}finally{fs.rmSync(temp,{force:true});}
console.log(role+' signature verified.');
