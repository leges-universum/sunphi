// Real network headers, isolated verification database; never opens a wallet.
import fs from 'node:fs';import assert from 'node:assert/strict';import {DatabaseSync,backup} from 'node:sqlite';import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
const packageRoot=process.argv.find(x=>x.startsWith('--package='))?.slice(10),source=packageRoot?packageRoot+'/sunphi-network-next/checkpoint-trial':new URL('..',import.meta.url).pathname;
const moduleURL=packageRoot?pathToFileURL(source+'/client.mjs'):new URL('../client.mjs',import.meta.url),{VerifiedClient}=await import(moduleURL);
const out=process.argv[2];assert(out?.startsWith('F:/DueByteWork/recovery85/')&&!fs.existsSync(out));fs.mkdirSync(out,{recursive:true});
const base=process.env.APPDATA+'/Duebyte/checkpoint-node/duebyte-trial-fresh-20261109-v45',read=f=>JSON.parse(fs.readFileSync(base+'/wallet/'+f));
const db=new DatabaseSync('F:/DueByteWork/payment84/recovery-diagnostic-1794823275996/trust.sqlite',{readOnly:true}),initial=db.prepare('SELECT height FROM head').get().height;await backup(db,out+'/trust.sqlite');db.close();
const binary=packageRoot?source+'/build/duebyte-abci.exe':base+'/updates/releases/DueByte-Home-0.3.84-Windows-x64/resources/app/sunphi-network-next/checkpoint-trial/build/duebyte-abci.exe';
const args={home:out,config:read('app-config.json'),policy:read('trust-policy.json'),genesisFile:base+'/wallet/genesis.json',binary,historyUrl:'http://127.0.0.1:28111',bounded:read('indexed-wallet.json').bounded};let client=new VerifiedClient(args);
const started=Date.now(),events=[],observe=p=>{events.push({...p,elapsedMs:Date.now()-started});console.log(JSON.stringify({phase:p.phase,height:p.height,target:p.target,elapsedMs:Date.now()-started}));};client.onProgress=observe;let interruptedCursor=null;
try{
 if(process.argv.includes('--interrupt')){
  await assert.rejects(client.sync(read('checkpoint.json'),read('connections.json').rpc,{service:true,onWindow:()=>{throw Error('Injected connection loss after durable verified window');}}),/Injected connection loss/);
  interruptedCursor=JSON.parse(client.book.db.prepare('SELECT body FROM recovery').get().body);assert(interruptedCursor.cursor.height>initial);assert.equal(client.book.db.prepare('SELECT height FROM head').get().height,initial);client.book.db.close();
  client=new VerifiedClient(args);client.onProgress=observe;
 }
 const view=await client.sync(read('checkpoint.json'),read('connections.json').rpc,{service:true});
 if(interruptedCursor){const after=events.slice(events.findIndex(e=>e.phase==='retry')+1).find(e=>e.phase==='headers');assert.equal(after.height,interruptedCursor.cursor.height,'Restart must resume the durable verified cursor');}
 assert(view.certificate.height>initial);assert.equal(client.book.db.prepare('SELECT count(*) AS n FROM recovery').get().n,0);
 const proof=JSON.parse(fs.readFileSync(out+'/candidate-headers.json')),first=proof.headers[0],anchor=first.commit.block_id.hash.toLowerCase(),height=Number(first.header.height);
 let tampered=structuredClone(proof);const signature=tampered.headers.at(-1).commit.signatures.find(s=>s.signature);signature.signature=Buffer.alloc(64).toString('base64');fs.writeFileSync(out+'/tampered.json',JSON.stringify(tampered));
 let rejected=false;try{execFileSync(binary,['-verify-file',out+'/tampered.json','-genesis',base+'/wallet/genesis.json','-anchor-height',String(height),'-anchor-hash',anchor,'-historical'],{stdio:'pipe',windowsHide:true,timeout:30000});}catch{rejected=true;}
 // A single bad signature may be outside Comet's sufficient quorum. Corrupt
 // all signatures for an unambiguous below-quorum adversarial fixture.
 tampered=structuredClone(proof);for(const s of tampered.headers.at(-1).commit.signatures)if(s.signature)s.signature=Buffer.alloc(64).toString('base64');fs.writeFileSync(out+'/tampered.json',JSON.stringify(tampered));
 assert.throws(()=>execFileSync(binary,['-verify-file',out+'/tampered.json','-genesis',base+'/wallet/genesis.json','-anchor-height',String(height),'-anchor-hash',anchor,'-historical'],{stdio:'pipe',windowsHide:true,timeout:30000}));
 fs.writeFileSync(out+'/report.json',JSON.stringify({passed:true,at:new Date().toISOString(),packageRoot:packageRoot??null,clientSha256:createHash('sha256').update(fs.readFileSync(moduleURL)).digest('hex'),initial,height:view.certificate.height,elapsedMs:Date.now()-started,events,interruptedCursor,invalidQuorumRejected:true,singleTamperedSignatureRejected:rejected,personalStateChanged:false,productionTransfers:0},null,2));
}finally{client.book.db.close();}
