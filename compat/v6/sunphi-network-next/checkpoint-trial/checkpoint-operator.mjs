import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {CHECKPOINT,verifyBody,verifyCheckpoint,attest,checkpointPolicy} from './checkpoint.mjs';
import {recoverPath} from './recovery.mjs';
import {hash} from './crypto.mjs';
import {stateHash} from './core.mjs';
import {rpc,snapshot,exportHeaders,verifyHeaders} from './client.mjs';
import {unseal} from './vault.mjs';
import {password} from './password.mjs';
import {readApplicationAuth} from './application-auth.mjs';
import {validateManifest} from './research/indexed-snapshot.mjs';
const read=p=>JSON.parse(readFileSync(p)),write=(p,x)=>writeFileSync(p,JSON.stringify(x,null,2),{flag:'wx',mode:0o600}),binary=join(import.meta.dirname,'build/duebyte-abci'+(process.platform==='win32'?'.exe':''));
export class AttesterBook{
 constructor(file,policy,key){this.policy=policy;this.key=key;this.db=new DatabaseSync(file);this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS attestations(sequence INTEGER PRIMARY KEY,body TEXT NOT NULL,signature TEXT NOT NULL); CREATE TABLE IF NOT EXISTS lineage(sequence INTEGER PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY,pin TEXT NOT NULL);');const pin=hash({policy,key:key.publicKey}),old=this.db.prepare('SELECT pin FROM identity WHERE id=1').get();if(old)assert.equal(old.pin,pin);else this.db.prepare('INSERT INTO identity VALUES(1,?)').run(pin);}
 get previous(){const r=this.db.prepare('SELECT sequence,body FROM attestations ORDER BY sequence DESC LIMIT 1').get();return r?{body:JSON.parse(r.body),renewals:JSON.parse(this.db.prepare('SELECT body FROM lineage WHERE sequence=?').get(r.sequence)?.body??'[]')}:null;}
 record(body,{renewals=[],linked=false}={}){this.db.exec('BEGIN IMMEDIATE');try{const previous=this.previous,policy=checkpointPolicy({renewals},this.policy);assert(policy.members.some(m=>m.key===this.key.publicKey),'retired or unauthorized attester');const oldChain=previous?.renewals??[];assert.equal(hash(renewals.slice(0,oldChain.length)),hash(oldChain),'attester policy conflict');verifyBody(body,policy,{previous,allowGap:linked});const old=this.db.prepare('SELECT * FROM attestations WHERE sequence=?').get(body.sequence);if(old){assert.equal(hash(JSON.parse(old.body)),hash(body),'attester equivocation');this.db.exec('COMMIT');return JSON.parse(old.signature);}const signature=attest(body,this.key);this.db.prepare('INSERT INTO attestations VALUES(?,?,?)').run(body.sequence,JSON.stringify(body),JSON.stringify(signature));this.db.prepare('INSERT INTO lineage VALUES(?,?)').run(body.sequence,JSON.stringify(renewals));this.db.exec('COMMIT');return signature;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 close(){this.db.close();}
}
function profile(dir){const policy=read(join(dir,'trust-policy.json')),genesis=read(join(dir,'genesis.json')),config=read(join(dir,'app-config.json'));assert.equal(hash(genesis),policy.genesisHash);return {policy,genesis,config};}
async function path(dir,url,anchor,height,file){return (await recoverPath({binary,genesisFile:join(dir,'genesis.json'),url,anchor,target:height,file})).verified;}
async function initialAnchor(dir,url,root){
 const file=join(dir,'checkpoint.json');
 if(existsSync(file)){const cp=read(file);verifyCheckpoint(cp,root);return cp.body;}
 // For an attester's first observation, an arbitrary candidate hash is NOT a root.
 // Header 1 must carry the genesis validator set and its authentic consensus quorum.
 const first=(await rpc(url,'commit',{height:'1'})).signed_header;
 assert.equal(Number(first.header.height),1);return {height:1,blockHash:first.commit.block_id.hash.toLowerCase()};
}
function lineage(state){return state.authority?.renewals??[];}
export async function indexedRequest(dir,method,fields={}){
 const settings=read(join(dir,'indexed-checkpoint-operator.json')),u=new URL(settings.applicationUrl);assert(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash,'local indexed application required');
 const token=method==='prepareIndexedSnapshot'?readApplicationAuth(settings.applicationHome):null;
 const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json',...(token?{'x-duebyte-app-auth':token}:{})},body:JSON.stringify({method,...fields}),signal:AbortSignal.timeout(60000)});let size=0;const parts=[];for await(const b of r.body){size+=b.length;assert(size<=1048576);parts.push(b);}const result=JSON.parse(Buffer.concat(parts));assert(r.ok,result.error??'indexed application request failed');return result;
}
// Adoption uses the same independently verified history and local indexed
// observation as signing. A remote checkpoint alone cannot replace the anchor.
export async function adoptIndexedCheckpoint(dir,url,document,previous){
 const {policy,config}=profile(dir);verifyCheckpoint(document,policy,{previous,allowGap:true,configHash:hash(config)});
 const {record}=await indexedRequest(dir,'indexedCheckpoint');
 assert(record&&hash(record.document.body)===hash(document.body),'local indexed checkpoint delivery required');
 const v=await path(dir,url,previous?.body??await initialAnchor(dir,url,policy),document.body.height,join(dir,'publisher-adoption-headers.json'));
 assert.equal(v.blockHash,document.body.blockHash);assert.equal(v.appHash,document.body.appHash);
 const own=await indexedRequest(dir,'inspectIndexedCheckpoint',{body:document.body,manifest:record.manifest});
 assert.equal(hash(own.renewals),hash(document.renewals??[]),'independent policy observation');
 const temp=join(dir,'checkpoint.adoption-'+process.pid+'.json');write(temp,document);renameSync(temp,join(dir,'checkpoint.json'));
}
export async function prepare(dir,url,out,{sequence}={}){
 assert(!existsSync(out));mkdirSync(out,{recursive:true});const {policy:root,config}=profile(dir),previous=existsSync(join(dir,'checkpoint.json'))?read(join(dir,'checkpoint.json')):null;
 if(existsSync(join(dir,'indexed-checkpoint-operator.json'))){
  const {manifest}=await indexedRequest(dir,'prepareIndexedSnapshot');validateManifest(manifest);assert.equal(manifest.configHash,hash(config));const height=manifest.height+1;
  const deadline=Date.now()+15000;for(;;){const head=await rpc(url,'commit');if(Number(head.signed_header.header.height)>=height)break;assert(Date.now()<deadline,'next committed header not ready');await new Promise(r=>setTimeout(r,250));}
  const v=await path(dir,url,previous?.body??await initialAnchor(dir,url,root),height,join(out,'headers.json'));assert.equal(v.appHash,manifest.root);
  const {renewals}=await indexedRequest(dir,'indexedPolicy'),policy=checkpointPolicy({renewals},root,hash(config)),now=Math.floor(Date.now()/1000);
  const body={domain:CHECKPOINT,policyHash:hash(policy),network:policy.network,genesisHash:policy.genesisHash,sequence:sequence??(previous?previous.body.sequence+1:1),height,blockHash:v.blockHash,appHeight:manifest.height,appHash:v.appHash,snapshotHash:hash(manifest),previous:previous?hash(previous.body):null,issuedAt:now,expiresAt:Math.min(now+policy.maxAge,policy.notAfter)};
  verifyBody(body,policy,{previous,allowGap:true});const own=await indexedRequest(dir,'inspectIndexedCheckpoint',{body,manifest});assert.equal(hash(own.renewals),hash(renewals));write(join(out,'body.json'),body);write(join(out,'manifest.json'),manifest);write(join(out,'renewals.json'),renewals);write(join(out,'source.json'),{url,indexed:true});return body;
 }
 const head=(await rpc(url,'commit')).signed_header,height=Number(head.header.height);assert(height>=2);const blockHash=head.commit.block_id.hash.toLowerCase();
 const v=await path(dir,url,previous?.body??await initialAnchor(dir,url,root),height,join(out,'headers.json')),state=await snapshot(url,height-1);assert.equal(stateHash(state,config),v.appHash);
 const renewals=lineage(state),policy=checkpointPolicy({renewals},root,hash(config)),now=Math.floor(Date.now()/1000);
 const body={domain:CHECKPOINT,policyHash:hash(policy),network:policy.network,genesisHash:policy.genesisHash,sequence:sequence??(previous?previous.body.sequence+1:1),height,blockHash,appHeight:height-1,appHash:v.appHash,snapshotHash:hash(state),previous:previous?hash(previous.body):null,issuedAt:now,expiresAt:Math.min(now+policy.maxAge,policy.notAfter)};
 verifyBody(body,policy,{previous,allowGap:true});write(join(out,'body.json'),body);write(join(out,'snapshot.json'),state);write(join(out,'renewals.json'),renewals);write(join(out,'source.json'),{url});return body;
}
export async function signCandidate(dir,candidate,url,key,stateFile){
 const {policy:root,config}=profile(dir),body=read(join(candidate,'body.json')),renewals=existsSync(join(candidate,'renewals.json'))?read(join(candidate,'renewals.json')):[],policy=checkpointPolicy({renewals},root,hash(config)),book=new AttesterBook(stateFile,root,key);
 try{verifyBody(body,policy,{previous:book.previous,allowGap:true});const anchor=book.previous?.body??await initialAnchor(dir,url,root),v=await path(dir,url,anchor,body.height,stateFile+'.candidate-headers.json');assert.equal(v.blockHash,body.blockHash);assert.equal(v.appHash,body.appHash);
  if(existsSync(join(candidate,'manifest.json'))){assert(existsSync(join(dir,'indexed-checkpoint-operator.json')),'indexed attester is not configured');const manifest=read(join(candidate,'manifest.json'));validateManifest(manifest);const own=await indexedRequest(dir,'inspectIndexedCheckpoint',{body,manifest});assert.equal(hash(own.renewals),hash(renewals),'independent policy observation');}
  else{const own=await snapshot(url,body.appHeight);assert.equal(stateHash(own,config),body.appHash);assert.equal(hash(own),body.snapshotHash);assert.equal(hash(lineage(own)),hash(renewals),'independent policy observation');}return book.record(body,{renewals,linked:true});}finally{book.close();}
}
export async function publish(dir,candidate,signatureFiles){
 const {policy,config}=profile(dir),body=read(join(candidate,'body.json')),indexed=existsSync(join(candidate,'manifest.json')),state=indexed?null:read(join(candidate,'snapshot.json')),renewals=read(join(candidate,'renewals.json')),previous=existsSync(join(dir,'checkpoint.json'))?read(join(dir,'checkpoint.json')):null,doc={body,signatures:signatureFiles.map(read),...(renewals.length?{renewals}:{})};
 verifyCheckpoint(doc,policy,{previous,allowGap:true,configHash:hash(config)});const source=read(join(candidate,'source.json')).url,v=await path(dir,source,previous?.body??await initialAnchor(dir,source,policy),body.height,join(candidate,'headers.json'));assert.equal(v.blockHash,body.blockHash);assert.equal(v.appHash,body.appHash);if(indexed){const manifest=read(join(candidate,'manifest.json'));const own=await indexedRequest(dir,'inspectIndexedCheckpoint',{body,manifest});assert.equal(hash(own.renewals),hash(renewals));}else{assert.equal(stateHash(state,config),body.appHash);assert.equal(hash(state),body.snapshotHash);assert.equal(hash(lineage(state)),hash(renewals));}
 const archive=join(dir,'checkpoint-archive');mkdirSync(archive,{recursive:true});write(join(archive,String(body.sequence)+'.json'),doc);const temp=join(dir,'checkpoint.next-'+process.pid+'.json');write(temp,doc);renameSync(temp,join(dir,'checkpoint.json'));return {height:body.height,sequence:body.sequence,id:hash(body)};
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){const [cmd,...a]=process.argv.slice(2);if(cmd==='prepare')console.log(JSON.stringify(await prepare(a[0],a[1],a[2])));else if(cmd==='sign'){const key=unseal(read(a[3]),await password('Checkpoint key password: '));const signature=await signCandidate(a[0],a[1],a[2],key,a[4]);write(a[5],signature);console.log('Independent observation verified; signature saved.');}else if(cmd==='publish')console.log(JSON.stringify(await publish(a[0],a[1],a.slice(2))));else throw Error('prepare PROFILE LOOPBACK_RPC NEW_CANDIDATE | sign PROFILE CANDIDATE OWN_RPC KEY_VAULT SIGNER_STATE OUT_SIGNATURE | publish PROFILE CANDIDATE SIGNATURE_FILES...');}
