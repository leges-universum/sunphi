import { randomBytes, createHash, createCipheriv, createDecipheriv, hkdfSync, sign, verify } from 'node:crypto';
import { open, readFile, lstat, rename, unlink } from 'node:fs/promises';
import {constants} from 'node:fs';
import { createVault, unlock, seal, validateVault } from '../wallet/vault.mjs';
import { canonical, digest, exact, identity, newKey, importSecret, publicKey, decode64 } from '../wallet/crypto.mjs';
import { DOMAIN, ACTORS, DAY, execute, initialState, balances } from '../sandbox/ledger.mjs';
import { verifyConsentProposal, signConsentProposal } from '../sandbox/consent-package.mjs';
import { inspectKeyChallenge, signKeyChallenge } from '../sandbox/key-enrollment.mjs';
import {ENVIRONMENT,checkProposal,consent,verifySnapshot} from './procedure-contract.mjs';

const FORMAT='sunphi-desktop-wallet-v2', LIMIT=4*1024*1024, SESSION=5*60*1000;
const id=()=>randomBytes(16).toString('hex');
const serialise=v=>JSON.stringify(v);
const hashBytes=bytes=>createHash('sha256').update(bytes).digest('hex');
function dataKey(key){const secret=key.export({type:'pkcs8',format:'der'});try{return Buffer.from(hkdfSync('sha256',secret,Buffer.from(FORMAT),Buffer.from('encrypted-local-workspace'),32));}finally{secret.fill(0);}}
function encrypt(data,key,header){const k=dataKey(key),iv=randomBytes(12),plain=Buffer.from(serialise(data));try{const c=createCipheriv('aes-256-gcm',k,iv);c.setAAD(Buffer.from(canonical(header)));return{iv:iv.toString('base64'),ciphertext:Buffer.concat([c.update(plain),c.final()]).toString('base64'),tag:c.getAuthTag().toString('base64')};}finally{k.fill(0);plain.fill(0);}}
function decrypt(box,key,header){exact(box,['iv','ciphertext','tag']);if(typeof box.ciphertext!=='string'||box.ciphertext.length>LIMIT)throw Error('Invalid workspace size');const k=dataKey(key);let plain;try{const d=createDecipheriv('aes-256-gcm',k,decode64(box.iv,12));d.setAAD(Buffer.from(canonical(header)));d.setAuthTag(decode64(box.tag,16));plain=Buffer.concat([d.update(Buffer.from(box.ciphertext,'base64')),d.final()]);return JSON.parse(plain.toString('utf8'));}catch{throw Error('Workspace authentication failed');}finally{k.fill(0);plain?.fill(0);}}
async function boundedRead(path){
  const st=await lstat(path);if(!st.isFile()||st.size>LIMIT)throw Error('Expected a wallet file below 4 MiB');
  const h=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{const stat=await h.stat();if(!stat.isFile()||stat.size>LIMIT||stat.ino!==st.ino)throw Error('Wallet file changed while opening');const bytes=Buffer.alloc(LIMIT+1);let size=0;while(size<bytes.length){const r=await h.read(bytes,size,bytes.length-size,null);if(!r.bytesRead)break;size+=r.bytesRead;}if(size>LIMIT)throw Error('Wallet size limit exceeded');return bytes.subarray(0,size);}finally{await h.close();}
}
async function exclusive(path,bytes){if(bytes.length>LIMIT)throw Error('Workspace size limit reached');const h=await open(path,'wx',0o600);try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}}
function reviewData(input){if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid request');return structuredClone(input);}
export function amountMinor(value){if(typeof value!=='string'||!/^\d{1,8}(?:\.\d{1,2})?$/.test(value))throw Error('Enter an amount with at most two decimal places');const [a,b='']=value.split('.');const n=Number(a)*100+Number(b.padEnd(2,'0'));if(!Number.isSafeInteger(n)||n<=0||n>10000000000)throw Error('Amount is outside the programme limit');return n;}
function newDemo(key){const keys=Object.fromEntries(ACTORS.map(actor=>[actor,actor==='buyer'?key:newKey()]));return {instanceId:id(),publicKeys:Object.fromEntries(ACTORS.map(a=>[a,identity(keys[a]).publicKey])),secrets:Object.fromEntries(ACTORS.filter(a=>a!=='buyer').map(a=>[a,keys[a].export({type:'pkcs8',format:'der'}).toString('base64')])),events:[],unknown:[]};}
function replay(data){let s=initialState();if(!data.demo)return s;const d=data.demo;if(!Array.isArray(d.events)||d.events.length>1000||!Array.isArray(d.unknown))throw Error('Invalid local journal');let previous=digest({instanceId:d.instanceId,keys:d.publicKeys});for(const e of d.events){exact(e,['payload','signature']);if(e.payload.previous!==previous||e.payload.instanceId!==d.instanceId||!ACTORS.includes(e.payload.command?.actor)||!verify(null,Buffer.from(canonical(e.payload)),publicKey(d.publicKeys[e.payload.command.actor]),decode64(e.signature,64)))throw Error('Journal signature mismatch');const next=execute(s,e.payload.command);if(next.replayed)throw Error('Duplicate journal event');s=next.state;previous=digest(e);}return s;}
function addEvent(data,key,actor,type,body,at){const d=data.demo;if(!d)throw Error('Start the separate test programme first');const state=replay(data);const c={domain:DOMAIN,id:id(),actor,type,data:body,at:at??state.clock};const result=execute(state,c);const k=actor==='buyer'?key:importSecret(Buffer.from(d.secrets[actor],'base64'));const previous=d.events.length?digest(d.events.at(-1)):digest({instanceId:d.instanceId,keys:d.publicKeys});const payload={instanceId:d.instanceId,previous,command:c};d.events.push({payload,signature:sign(null,Buffer.from(canonical(payload)),k).toString('base64')});return result;}

export class DesktopWallet {
  #path;#key;#vault;#data;#etag;#expires=0;#review;#busy=false;#epoch=0;#now;#adapter;#procedureReview;
  constructor({now=Date.now,adapter=null}={}){this.#now=now;this.#adapter=adapter;}
  get unlocked(){return !!this.#key&&this.#expires>this.#now();}
  async #single(fn){if(this.#busy)throw Error('Another wallet operation is in progress');this.#busy=true;try{return await fn();}finally{this.#busy=false;}}
  #require(){if(!this.unlocked){this.lock();throw Error('Unlock your wallet first');}this.#expires=this.#now()+SESSION;}
  lock(){this.#epoch++;this.#key=null;this.#data=null;this.#vault=null;this.#review=null;this.#procedureReview=null;this.#expires=0;return {locked:true,hasFile:!!this.#path};}
  #envelope(data,vault=this.#vault){return {format:FORMAT,vault,workspace:encrypt(data,this.#key,{format:FORMAT,publicKey:vault.header.publicKey})};}
  async #save(data,vault=this.#vault){const epoch=this.#epoch,bytes=Buffer.from(serialise(this.#envelope(data,vault))+'\n');if(hashBytes(await boundedRead(this.#path))!==this.#etag)throw Error('Wallet changed outside this session. Lock and reopen it');const tmp=this.#path+'.'+id()+'.tmp';await exclusive(tmp,bytes);try{if(hashBytes(await boundedRead(this.#path))!==this.#etag)throw Error('Wallet changed outside this session');await rename(tmp,this.#path);}catch(e){await unlink(tmp).catch(()=>{});throw e;}if(epoch!==this.#epoch)throw Error('Wallet locked while saving. Reopen the saved wallet');this.#etag=hashBytes(bytes);this.#data=data;this.#vault=vault;}
  async create(path,password,label){return this.#single(async()=>{if(this.unlocked)throw Error('Lock the current wallet first');if(typeof label!=='string'||!label.trim()||label.length>80)throw Error('Enter a wallet name');const epoch=this.#epoch,vault=await createVault(password),key=await unlock(vault,password);if(epoch!==this.#epoch)throw Error('Creation interrupted');const data={version:2,label:label.trim(),createdAt:this.#now(),demo:null,trust:null,packages:[],signed:[]};const envelope={format:FORMAT,vault,workspace:encrypt(data,key,{format:FORMAT,publicKey:vault.header.publicKey})};const bytes=Buffer.from(serialise(envelope)+'\n');await exclusive(path,bytes);if(epoch!==this.#epoch)throw Error('Wallet created but locked. Open the saved wallet');this.#path=path;this.#vault=vault;this.#key=key;this.#data=data;this.#etag=hashBytes(bytes);this.#expires=this.#now()+SESSION;return this.view();});}
  async open(path,password){return this.#single(async()=>{this.lock();const epoch=this.#epoch,bytes=await boundedRead(path),e=JSON.parse(bytes.toString('utf8'));exact(e,['format','vault','workspace']);if(e.format!==FORMAT)throw Error('Choose a SunPhi Desktop encrypted wallet or backup');validateVault(e.vault);const key=await unlock(e.vault,password),data=decrypt(e.workspace,key,{format:FORMAT,publicKey:e.vault.header.publicKey});exact(data,['version','label','createdAt','demo','trust','packages','signed',...(Object.hasOwn(data,'procedural')?['procedural']:[])]);if(data.version!==2||!Array.isArray(data.packages)||!Array.isArray(data.signed))throw Error('Invalid workspace');replay(data);if(data.procedural){verifySnapshot(data.procedural.snapshot,data.procedural.trust,identity(key).publicKey,this.#now(),{allowStale:true});if(!Array.isArray(data.procedural.outbox)||!Array.isArray(data.procedural.cases))throw Error('Invalid procedural workspace');}if(epoch!==this.#epoch)throw Error('Unlock interrupted');this.#path=path;this.#key=key;this.#vault=e.vault;this.#data=data;this.#etag=hashBytes(bytes);this.#expires=this.#now()+SESSION;return this.view();});}
  view(){if(!this.unlocked){this.lock();return {locked:true,hasFile:!!this.#path};}const d=this.#data;replay(d);let s=initialState();for(const event of d.demo?.events??[]){const c=event.payload.command;if(c.type==='settle'&&d.demo.unknown.includes(c.data.transferId))continue;s=execute(s,c).state;}return {locked:false,label:d.label,publicKey:identity(this.#key).publicKey,address:identity(this.#key).address,expiresAt:this.#expires,liveConnection:false,trust:d.trust?{fingerprint:digest(d.trust),issuer:d.trust.issuer}:null,packages:d.packages.map(p=>({id:p.id,kind:p.kind,importedAt:p.importedAt,actorId:p.actorId})),signed:d.signed.map(p=>({id:p.id,kind:p.kind,at:p.at,actorId:p.actorId})),demo:d.demo?{mode:'FICTIONAL TEST PROGRAMME',issuer:'Asterwell Bank · DEMO',programme:'USD deposit programme 01',family:'Rose',currency:'USD',precision:2,rateBps:s.rateBps,clock:s.clock,sequence:s.sequence,balances:Object.fromEntries(['buyer','seller','supplier'].map(a=>[a,balances(s,a)])),transfers:Object.entries(s.transfers).map(([id,t])=>({id,...t,deliveryStatus:d.demo.unknown.includes(id)?'unknown':t.status})),redemptions:Object.entries(s.redemptions).map(([id,r])=>({id,...r})),history:s.journal.slice().reverse(),issued:s.issued,redeemed:s.redeemed,platformCents:s.platformCents,rewardFundingCents:s.rewardFundingCents}:null};}
  async backup(path){return this.#single(async()=>{this.#require();await exclusive(path,Buffer.from(serialise(this.#envelope(this.#data))+'\n'));return {saved:true};});}
  async changePassword(oldPassword,newPassword){return this.#single(async()=>{this.#require();const epoch=this.#epoch;await unlock(this.#vault,oldPassword);const vault=await seal(this.#key,newPassword);if(epoch!==this.#epoch||!this.unlocked)throw Error('Wallet locked during password change');await this.#save(this.#data,vault);return this.view();});}
  async importTrust(trust,fingerprint){return this.#single(async()=>{this.#require();exact(trust,['format','issuer']);if(trust.format!=='sunphi-consent-trust-v1'||fingerprint!==digest(trust))throw Error('Independently confirmed trust fingerprint required');publicKey(trust.issuer.sourceKey);publicKey(trust.issuer.bankKey);if(this.#data.trust&&digest(this.#data.trust)!==fingerprint)throw Error('Use a separate profile for another institution trust binding');const d=structuredClone(this.#data);d.trust=trust;await this.#save(d);return this.view();});}
  async importPackage(pkg){return this.#single(async()=>{this.#require();if(!this.#data.trust)throw Error('Import independently verified institution trust first');let kind,p,actorId;if(pkg.payload?.domain==='sunphi-consent-proposal-sandbox-v1'){kind='consent';p=verifyConsentProposal(pkg,this.#data.trust,this.#now());actorId=p.snapshot.parties.find(x=>x.publicKey===identity(this.#key).publicKey)?.actorId;}else{kind='enrollment';p=inspectKeyChallenge(pkg,this.#data.trust,this.#now());if(p.publicKey===identity(this.#key).publicKey)actorId=p.actorId;}if(!actorId)throw Error('This package is assigned to a different wallet key');const packageId=digest(pkg),d=structuredClone(this.#data);if(!d.packages.some(x=>x.id===packageId)){if(d.packages.length>=50)throw Error('Package limit reached');d.packages.push({id:packageId,kind,pkg,actorId,importedAt:this.#now()});await this.#save(d);}return this.view();});}
  inspectPackage(packageId){this.#require();const p=this.#data.packages.find(p=>p.id===packageId);if(!p)throw Error('Package not found');const verified=p.kind==='consent'?verifyConsentProposal(p.pkg,this.#data.trust,this.#now()):inspectKeyChallenge(p.pkg,this.#data.trust,this.#now());return {kind:p.kind,actorId:p.actorId,verified};}
  prepare(input){this.#require();input=reviewData(input);const allowed={start:[],issue:['quantity'],transfer:['recipient','amount'],receive:['transferId'],settle:['transferId','loseReply'],reconcile:['transferId'],cancel:['transferId'],redeem:['owner','amount'],payout:['redemptionId'],advance:[],sign:['packageId']};if(!Object.hasOwn(allowed,input.kind))throw Error('Unsupported wallet action');exact(input,['kind',...allowed[input.kind]]);let details={...input,environment:'LOCAL TEST ONLY'},seq=this.#data.demo?.events.length??0;
    if(input.kind==='sign'){details={...details,environment:'INSTITUTION INTEGRATION PROTOTYPE',...this.inspectPackage(input.packageId)};}
    else if(input.kind==='start'){if(this.#data.demo)throw Error('A test programme already exists');}
    else {if(!this.#data.demo)throw Error('Start the test programme first');if(this.#data.demo.unknown.length&&input.kind!=='reconcile')throw Error('Query the original unknown outcome before another test operation');const s=replay(this.#data);if(['transfer','redeem'].includes(input.kind)){details.amountMinor=amountMinor(input.amount);if(input.kind==='transfer'&&!['seller','supplier'].includes(input.recipient))throw Error('Choose a test recipient');if(input.kind==='redeem'&&!['buyer','seller','supplier'].includes(input.owner))throw Error('Choose a test holder');}
      if(input.kind==='issue'){if(!/^\d{1,8}$/.test(input.quantity)||Number(input.quantity)<1)throw Error('Enter a positive whole quantity');details.principalMinor=Number(input.quantity)*100;details.feeMinor=Number(input.quantity)*2;details.totalMinor=Number(input.quantity)*102;}
      if(['receive','settle','reconcile','cancel'].includes(input.kind)){const t=s.transfers[input.transferId];if(!t)throw Error('Transfer not found');details.transfer=t;if(this.#data.demo.unknown.includes(input.transferId)&&input.kind!=='reconcile')throw Error('Resolve the original unknown outcome first');if(input.kind==='settle'&&typeof input.loseReply!=='boolean')throw Error('Invalid delivery option');}
      if(input.kind==='payout'){details.redemption=s.redemptions[input.redemptionId];if(!details.redemption)throw Error('Redemption not found');}
    }
    const review={id:id(),expiresAt:this.#now()+120000,details};this.#review={...review,input,seq};return structuredClone(review);
  }
  async confirm(reviewId){return this.#single(async()=>{this.#require();const r=this.#review;this.#review=null;if(!r||r.id!==reviewId||r.expiresAt<=this.#now()||r.seq!==(this.#data.demo?.events.length??0))throw Error('Review expired or changed. Review again');const d=structuredClone(this.#data),i=r.input;let exported=null;
    if(i.kind==='start')d.demo=newDemo(this.#key);
    else if(i.kind==='sign'){const p=d.packages.find(x=>x.id===i.packageId);exported=p.kind==='consent'?signConsentProposal(p.pkg,d.trust,p.actorId,this.#key,this.#now()):signKeyChallenge(p.pkg,d.trust,p.actorId,this.#key,this.#now());if(!d.signed.some(x=>x.id===p.id))d.signed.push({id:p.id,kind:p.kind,actorId:p.actorId,at:this.#now(),output:exported});else exported=d.signed.find(x=>x.id===p.id).output;}
    else {const s=replay(d);if(d.demo.events.length>=990)throw Error('Test journal limit reached');const add=(actor,type,data,at)=>addEvent(d,this.#key,actor,type,data,at);
      switch(i.kind){
        case 'issue':add('bank','issue',{paymentId:id(),lotId:id(),owner:'buyer',quantity:Number(i.quantity),paidCents:Number(i.quantity)*102});break;
        case 'transfer':add('buyer','transfer',{transferId:id(),recipient:i.recipient,amount:amountMinor(i.amount)});break;
        case 'receive':add(s.transfers[i.transferId].recipient,'receipt',{transferId:i.transferId});break;
        case 'settle':add('bank','settle',{transferId:i.transferId});if(i.loseReply)d.demo.unknown.push(i.transferId);break;
        case 'reconcile':if(!d.demo.unknown.includes(i.transferId))throw Error('No unknown outcome');d.demo.unknown=d.demo.unknown.filter(x=>x!==i.transferId);break;
        case 'cancel':add('bank','cancel',{transferId:i.transferId,reason:'Explicit local test bank cancellation'});break;
        case 'redeem':add(i.owner,'redeem',{redemptionId:id(),amount:amountMinor(i.amount)});break;
        case 'payout':add('bank','payout',{redemptionId:i.redemptionId,paymentId:id()});break;
        case 'advance':add('bank','tick',{},s.clock+30*DAY);break;
      }
    }
    replay(d);await this.#save(d);return {view:this.view(),signed:!!exported};
  });}
  exportApproval(packageId){this.#require();const p=this.#data.signed.find(x=>x.id===packageId);if(!p)throw Error('Sign the reviewed package first');return structuredClone(p.output);}
  procedureView(){
    if(!this.unlocked)return null;const d=this.#data.procedural;
    if(!d)return {connected:false,production:false};
    const snapshot=verifySnapshot(d.snapshot,d.trust,identity(this.#key).publicKey,this.#now(),{allowStale:true});
    return {connected:true,production:false,snapshot,stale:snapshot.expiresAt<=this.#now(),outbox:d.outbox.map(({proposal,authority,...x})=>({...x,proposal:proposal.payload.body})),cases:structuredClone(d.cases),trustFingerprint:digest(d.trust)};
  }
  async procedure(method,args={}){return this.#single(async()=>{
    if(method==='sync'){if(!this.unlocked){this.lock();throw Error('Unlock your wallet first');}exact(args,[]);}else this.#require();
    const epoch=this.#epoch,holder=identity(this.#key).publicKey;
    const checked=()=>{if(epoch!==this.#epoch||!this.unlocked)throw Error('Wallet locked during operation. Reopen and query the original result');};
    if(!this.#adapter)throw Error('No approved adapter configured. Production connections are unavailable');
    if(method==='connect'){
      if(this.#data.procedural)return this.procedureView();
      const result=await this.#adapter.connect(holder,{label:this.#data.label});checked();verifySnapshot(result.snapshot,result.trust,holder,this.#now());
      // Preserve the exact original file, including legacy signed records, before extending its schema.
      await exclusive(this.#path+'.before-0.3-'+id()+'.json',await boundedRead(this.#path));checked();
      const d=structuredClone(this.#data);d.procedural={version:1,environment:ENVIRONMENT,trust:result.trust,snapshot:result.snapshot,outbox:[],cases:[]};await this.#save(d);return this.procedureView();
    }
    if(!this.#data.procedural)throw Error('Connect the isolated procedure laboratory first');
    const applySnapshot=async record=>{
      checked();const d=structuredClone(this.#data),w=d.procedural,s=verifySnapshot(record,w.trust,holder,this.#now(),{minSequence:w.snapshot.payload.body.sequence});
      w.snapshot=record;
      for(const q of w.outbox){const t=s.transactions.find(t=>t.id===q.id);if(t){if(digest(t.proposal)!==digest(q.proposal)||digest(t.authority)!==digest(q.authority))throw Error('Original result does not match the durable instruction');q.state=t.state;q.error='';}else if(q.proposal.payload.body.expiresAt<=this.#now()&&['SUBMITTING','UNKNOWN'].includes(q.state)){q.state='REJECTED';q.error='Authoritative laboratory snapshot confirms non-execution after proposal expiry';}}
      await this.#save(d);return this.procedureView();
    };
    if(method==='refresh'||method==='sync'){
      const record=await this.#adapter.query(holder);checked();
      verifySnapshot(record,this.#data.procedural.trust,holder,this.#now(),{minSequence:this.#data.procedural.snapshot.payload.body.sequence});
      if(method==='sync'&&record.payload.body.sequence===this.#data.procedural.snapshot.payload.body.sequence&&this.#data.procedural.snapshot.payload.body.expiresAt>this.#now()+60000)return this.procedureView();
      return applySnapshot(record);
    }
    if(method==='recipient'){
      exact(args,['address','sourceId']);const result=await this.#adapter.resolveRecipient(holder,args);checked();return result;
    }
    if(method==='quote-recipient'){
      exact(args,['address','sourceId','destinationId','amount','purpose']);
      const w=this.#data.procedural;verifySnapshot(w.snapshot,w.trust,holder,this.#now());
      if(w.outbox.some(q=>['SUBMITTING','UNKNOWN','RECOVERY_REQUIRED'].includes(q.state))||w.snapshot.payload.body.transactions.some(t=>t.state==='RECOVERY_REQUIRED'))throw Error('Resolve the original pending outcome before another instruction');
      const proposal=await this.#adapter.quoteRecipient(holder,{...args,delivery:'normal'});checked();
      const details=checkProposal(proposal,w.trust,holder,this.#now());this.#procedureReview={id:id(),proposal};return {id:this.#procedureReview.id,details};
    }
    if(method==='quote'){
      const w=this.#data.procedural;verifySnapshot(w.snapshot,w.trust,holder,this.#now());
      if(w.outbox.some(q=>['SUBMITTING','UNKNOWN','RECOVERY_REQUIRED'].includes(q.state))||w.snapshot.payload.body.transactions.some(t=>t.state==='RECOVERY_REQUIRED'))throw Error('Resolve the original pending outcome before another instruction');
      exact(args,['routeId','amount','delivery']);const proposal=await this.#adapter.quote(holder,args);checked();
      const details=checkProposal(proposal,w.trust,holder,this.#now());this.#procedureReview={id:id(),proposal};return {id:this.#procedureReview.id,details};
    }
    if(method==='confirm'){
      exact(args,['id']);const r=this.#procedureReview;this.#procedureReview=null;if(!r||r.id!==args.id)throw Error('Review expired or replaced; review again');
      checkProposal(r.proposal,this.#data.procedural.trust,holder,this.#now());
      const authority=consent(this.#key,r.proposal,this.#now()),commandId=r.proposal.payload.transitionId,d=structuredClone(this.#data);
      if(d.procedural.outbox.length>=150)throw Error('Laboratory journal limit reached; export your evidence');
      d.procedural.outbox.push({id:commandId,proposal:r.proposal,authority,state:'SUBMITTING',createdAt:this.#now(),error:''});
      await this.#save(d);checked();
      try{return await applySnapshot(await this.#adapter.execute(holder,r.proposal,authority));}
      catch(e){checked();const pending=structuredClone(this.#data),q=pending.procedural.outbox.find(q=>q.id===commandId);q.state='UNKNOWN';q.error='No verified outcome received. Query the original instruction; do not submit it again.';await this.#save(pending);return this.procedureView();}
    }
    if(method==='recover'){
      exact(args,['id']);const t=this.#data.procedural.snapshot.payload.body.transactions.find(t=>t.id===args.id);
      if(!t||t.state!=='RECOVERY_REQUIRED')throw Error('No recoverable laboratory operation');
      return applySnapshot(await this.#adapter.recover(holder,args.id));
    }
    if(method==='case'){
      exact(args,['operationId','category','description']);
      if(!['Technical issue','Financial-right dispute','Access recovery'].includes(args.category)||typeof args.description!=='string'||args.description.trim().length<10||args.description.length>2000)throw Error('Provide a category and a description between 10 and 2,000 characters');
      if(args.operationId&&!this.#data.procedural.outbox.some(q=>q.id===args.operationId)&&!this.#data.procedural.snapshot.payload.body.transactions.some(t=>t.id===args.operationId))throw Error('Unknown operation reference');
      const d=structuredClone(this.#data);if(d.procedural.cases.length>=50)throw Error('Local draft limit reached');d.procedural.cases.push({id:'DRAFT-'+id().slice(0,12),...args,createdAt:this.#now(),status:'LOCAL DRAFT — NOT SUBMITTED'});await this.#save(d);return this.procedureView();
    }
    throw Error('Unsupported procedural action');
  });}
  exportProcedures(){this.#require();if(!this.#data.procedural)throw Error('No procedural evidence');return {format:'sunphi-procedure-wallet-export-v1',environment:ENVIRONMENT,exportedAt:this.#now(),holder:identity(this.#key).publicKey,...structuredClone(this.#data.procedural)};}
  exportStatement(){this.#require();const v=this.view();return {format:'sunphi-desktop-statement-v1',exportedAt:this.#now(),environment:'LOCAL TEST / NO REAL FUNDS',label:v.label,publicKey:v.publicKey,demo:v.demo};}
}
