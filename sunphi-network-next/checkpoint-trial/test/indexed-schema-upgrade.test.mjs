import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {hash,keys,sign,canonical} from '../crypto.mjs';
import {origin} from '../core.mjs';
import {cleanConfig} from '../research/fresh-chain-preparation.mjs';
import {prepareIndexedSchemaUpgrade,openIndexedSchemaApplication,verifyIndexedSchemaUpgrade,indexedSchemaRootTerms,verifyIndexedSchemaPredecessor} from '../research/indexed-schema-upgrade.mjs';
import {verifyBoundedViewAnchor} from '../research/bounded-root-transition.mjs';
import {serviceBoundedProfile} from '../service-profile.mjs';
import {indexedBlock,indexedCheckpointBody} from '../research/indexed-checkpoint.mjs';
import {CHECKPOINT,attest} from '../checkpoint.mjs';
import {exportIndexedSnapshot,readChunk,snapshotOffer,IndexedSnapshotReceiver} from '../research/indexed-snapshot.mjs';
import {readApplicationAuth} from '../application-auth.mjs';
import {sha256,verifyPackage} from '../update-core.mjs';
import {initialize} from '../operator.mjs';
import {validateConsumerProfile,consumerConnections} from '../consumer-profile.mjs';
import {consumerIdentity,prepareConsumer} from '../consumer-setup.mjs';
import {authenticateConsumerIndexedCheckpoint} from '../consumer-indexed.mjs';
import {validateTransitionDelivery,stageTransitionProfile} from '../profile-delivery.mjs';
import {IndexedCheckpointRepository} from '../research/indexed-checkpoint.mjs';
import {guardIndexedSchemaBoundary,indexedSchemaReadinessBody,verifyIndexedSchemaReadiness,persistIndexedSchemaBoundary,openGuardedIndexedSchemaBoundary,verifyIndexedSchemaActivation} from '../research/indexed-schema-readiness.mjs';
import {createBoundedApi} from '../research/bounded-api.mjs';
import {FIXED_BLOCK_TIMING} from '../fixed-block-timing.mjs';
import {once} from 'node:events';
import http from 'node:http';
import {installIndexedSchema} from '../research/indexed-schema-install.mjs';
import {retireSchemaCandidate} from '../qa/schema-candidate-retirement.mjs';
import {serviceRuntime} from '../runtime-compatibility.mjs';
import {BoundedNetworkInterpreter} from '../research/bounded-network-interpreter.mjs';
import {acquireStateAccess,assertStateInstallationComplete,SCHEMA_INSTALL_PENDING} from '../state-access.mjs';
import {authority,rootBytes,feed,signed as signMetadata} from '../qa/update-signing.mjs';
import {prepareSchemaProfileCatalogPlan,signProfileCatalogPlan,verifyProfileCatalog} from '../qa/profile-catalog-plan.mjs';
import {exerciseFreshRecovery} from '../qa/fresh-recovery-20261109.mjs';
import {withStoppedRecoveryState} from '../recovery-state.mjs';
import {SchemaReadinessApprovalJournal} from '../qa/schema-readiness-approval.mjs';
import {verifySchemaJournal,SCHEMA_RESTART_ROWS} from '../research/indexed-schema-upgrade.mjs';
const baseline=process.env.DUEBYTE_V6_PACKAGE;
assert(baseline,'immutable released Server 0.3.56 package required');
verifyPackage(baseline,{version:'0.3.56',edition:'server',platform:'linux-x64',manifestSha256:'feb36180d3f5bd22a26e1896503c3debb50a9d033e98fc46b0c836a656c3b9bc',networkPin:'15b2d004316dcab66d65eca71aa583ed9574c0a54abb335cd0ce8db139d45429'});
const {BoundedNetworkInterpreter:Legacy}=await import(pathToFileURL(path.join(baseline,'sunphi-network-next/checkpoint-trial/research/bounded-network-interpreter.mjs')));
const {freshRootTerms:legacyFreshRootTerms}=await import(pathToFileURL(path.join(baseline,'sunphi-network-next/checkpoint-trial/research/fresh-application.mjs')));
const {BoundedApplication:LegacyApplication}=await import(pathToFileURL(path.join(baseline,'sunphi-network-next/checkpoint-trial/research/bounded-application.mjs')));
function fixture(t,{blocks=5}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'duebyte-schema-upgrade-')),closers=[];t.after(async()=>{for(const close of closers)await close();assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});});
 const validators=Array.from({length:10},keys),members=Array.from({length:4},keys);
 const config=cleanConfig({chainId:'duebyte-trial-schema-upgrade',previousChainId:'old-fixture',time:1000,control:{validators:validators.map((k,i)=>({key:k.publicKey,group:hash(i)})),policy:{version:1,members:members.map((k,i)=>({key:k.publicKey,group:hash(i)})),threshold:3,maxAge:3600,notAfter:Math.floor(Date.now()/1000)+86400}}});
 const source=path.join(dir,'source.sqlite'),initial=origin(config),old=Legacy.create(source,initial,config,hash(initial)),genesisRoot=old.root;
 for(let height=1;height<=blocks;height++)old.commitBlock({height,time:1000+height*10,blockHash:hash(['old',height]),txs:[]},old.root);
 const state=old.snapshotForAudit(),trustedBoundary={network:config.chainId,configHash:hash(config),genesisRoot,height:state.height,root:old.root,journalHash:old.store.meta.journalHash,generation:state.authority.generation,validators:state.authority.validators};old.close();
 const target=path.join(dir,'target.sqlite'),args={source,target,config,trustedBoundary},signBody=body=>({body,approvals:validators.slice(0,7).map(k=>({key:k.publicKey,signature:sign(body,k.privateKey)}))});
 return {dir,source,target,config,trustedBoundary,args,state,signBody,validators,members,closers};
}
const q=height=>({method:'finalize',height,time:1000+height*10,hash:Buffer.from(hash(['new',height]),'hex').toString('base64'),txs:[]});
const infoHash=app=>Buffer.from(app.dispatch({method:'info'}).hash,'base64').toString('hex');

test('restart work is bounded while full recovery audits retained history beyond the suffix',t=>{
 const f=fixture(t,{blocks:140}),p=prepareIndexedSchemaUpgrade(f.args),cert=f.signBody(p.body);
 let app=openIndexedSchemaApplication(f.target,f.config,cert,f.trustedBoundary);
 for(let h=141;h<=210;h++){app.dispatch(q(h));app.dispatch({method:'commit'});}
 assert.equal(verifySchemaJournal(app.handler,p.body).rows,SCHEMA_RESTART_ROWS);
 assert.equal(verifySchemaJournal(app.handler,p.body,{full:true}).rows,211);
 const root=app.handler.root;app.close();
 const prepare=DatabaseSync.prototype.prepare,snapshot=BoundedNetworkInterpreter.prototype.snapshotForAudit;let bodyReads=0;
 DatabaseSync.prototype.prepare=function(sql){
  if(/FROM journal/i.test(sql)){assert(!/SELECT \*/i.test(sql),'unbounded journal scan');if(/SELECT body/i.test(sql))bodyReads++;}
  return prepare.call(this,sql);
 };
 BoundedNetworkInterpreter.prototype.snapshotForAudit=()=>{throw Error('population scan on restart');};
 try{app=openIndexedSchemaApplication(f.target,f.config,cert,f.trustedBoundary);assert.equal(app.handler.root,root);app.close();assert.equal(bodyReads,SCHEMA_RESTART_ROWS);}
 finally{DatabaseSync.prototype.prepare=prepare;BoundedNetworkInterpreter.prototype.snapshotForAudit=snapshot;}
 const db=new DatabaseSync(f.target);db.exec("UPDATE journal SET body='{}' WHERE sequence=2");db.close();
 // Archived corruption does not alter current authenticated state. It MUST be
 // rejected by full recovery/import even though ordinary restart skips it.
 app=openIndexedSchemaApplication(f.target,f.config,cert,f.trustedBoundary);assert.equal(app.handler.root,root);app.close();
 assert.throws(()=>openIndexedSchemaApplication(f.target,f.config,cert,f.trustedBoundary,{auditJournal:true}));
 const bad=new DatabaseSync(f.target);bad.exec('DELETE FROM journal WHERE sequence=200');bad.close();
 assert.throws(()=>openIndexedSchemaApplication(f.target,f.config,cert,f.trustedBoundary));
});

test('encrypted schema backup restores independently with native signer state and full semantic state',async t=>{
 const f=installFixture(t);f.install();fs.mkdirSync(path.join(f.home,'data'));fs.mkdirSync(path.join(f.home,'config'));
 f.write('data/priv_validator_state.json',{height:'6',round:0,step:3});
 f.write('config/priv_validator_key.json',{pub_key:{value:Buffer.from(f.validators[0].publicKey,'base64url').toString('base64')},privateFixture:'isolated-only'});
 f.write('config/node_key.json',{privateFixture:'isolated-peer-only'});
 const app=openIndexedSchemaApplication(path.join(f.home,'application-indexed.sqlite'),f.config,f.settings.certificate,f.trustedBoundary);
 app.dispatch(q(6));app.dispatch({method:'commit'});app.close();
 const receipt=await withStoppedRecoveryState(f.home);
 await assert.rejects(()=>withStoppedRecoveryState(f.home,{expected:{...receipt,height:5}}),/differs/);
 await withStoppedRecoveryState(f.home,{},async()=>{assert.throws(()=>acquireStateAccess(f.home),/state is in use/);});
 const result=await exerciseFreshRecovery({out:f.dir,home:f.home});assert(result.passed);assert.equal(result.format,'indexed-schema');assert.equal(result.height,6);assert.equal(result.safeToStartSigner,false);
 await withStoppedRecoveryState(result.restoredHome,{expected:receipt});
 fs.unlinkSync(path.join(result.restoredHome,'config/node_key.json'));await assert.rejects(()=>withStoppedRecoveryState(result.restoredHome),/incomplete native signer/);
 f.write('fresh-activation.json',{});await assert.rejects(()=>withStoppedRecoveryState(f.home),/exactly one/);
 fs.unlinkSync(path.join(f.home,'fresh-activation.json'));f.write(SCHEMA_INSTALL_PENDING,{});await assert.rejects(()=>withStoppedRecoveryState(f.home),/incomplete/);
});

function installFixture(t){
 const f=fixture(t),prepared=prepareIndexedSchemaUpgrade(f.args),certificate=f.signBody(prepared.body);
 const body=indexedSchemaReadinessBody(f.config,certificate,f.trustedBoundary);
 const settings={readPort:28304,bootstrap:false,certificate,trustedBoundary:f.trustedBoundary,readiness:{body,approvals:f.validators.map(k=>({key:k.publicKey,signature:sign(body,k.privateKey)}))}};
 const home=path.join(f.dir,'node');fs.mkdirSync(home);
 const write=(name,value)=>fs.writeFileSync(path.join(home,name),JSON.stringify(value));
 fs.copyFileSync(f.source,path.join(home,'application-indexed.sqlite'));
 write('app-config.json',f.config);write('indexed-schema-prepare.json',{certificate,trustedBoundary:f.trustedBoundary});
 persistIndexedSchemaBoundary(home,f.config,certificate,f.trustedBoundary);
 const manifest={domain:'DUEBYTE_FRESH_GENESIS_V2',network:f.config.chainId,configHash:hash(f.config),stateHash:hash(origin(f.config)),root:f.trustedBoundary.genesisRoot,height:0,issuance:false,imports:false,timing:{...FIXED_BLOCK_TIMING}};
 write('fresh-activation.json',{manifest,manifestHash:hash(manifest),readPort:28304,bootstrap:false});
 write('native-signing-state.json',{height:'5',round:0,step:3});write('encrypted-wallet.json',{synthetic:true});
 return {...f,home,settings,write,install:options=>installIndexedSchema({home,candidate:f.target,settings,...options})};
}

test('staging retirement resumes after interruption and preserves installed state, source and wallet',async t=>{
 for(const step of ['intent','retired'])await t.test(step,t=>{
  const f=installFixture(t);f.install();const directory=path.join(f.dir,'candidate-control');fs.mkdirSync(directory);
  fs.copyFileSync(f.target,path.join(directory,'candidate.sqlite'));
  const names=['application-indexed.sqlite','application-indexed.pre-schema.sqlite','fresh-activation.pre-schema.json','native-signing-state.json','encrypted-wallet.json'];
  const before=names.map(n=>fs.readFileSync(path.join(f.home,n)));
  const args={home:fs.realpathSync(f.home),directory:fs.realpathSync(directory),settingsHash:hash(f.settings),observeStopped:()=>({fenced:true})};
  assert.throws(()=>retireSchemaCandidate({...args,onStep:s=>{if(s===step)throw Error('interrupt');}}),/interrupt/);
  assert(retireSchemaCandidate(args).retired);assert(!fs.existsSync(path.join(directory,'candidate.sqlite')));
  assert(retireSchemaCandidate(args).alreadyRetired);
  names.forEach((n,i)=>assert.deepEqual(fs.readFileSync(path.join(f.home,n)),before[i]));
  assert.equal(f.install().status,'ALREADY_INSTALLED');
 });
});
test('staging retirement rejects altered copies, incomplete installation and active writers',t=>{
 const f=installFixture(t);f.install();const directory=path.join(f.dir,'candidate-control');fs.mkdirSync(directory);
 const candidate=path.join(directory,'candidate.sqlite');fs.copyFileSync(f.target,candidate);
 const args={home:fs.realpathSync(f.home),directory:fs.realpathSync(directory),settingsHash:hash(f.settings),observeStopped:()=>({fenced:true})};
 const release=acquireStateAccess(f.home);try{assert.throws(()=>retireSchemaCandidate(args),/state is in use/);}finally{release();}
 fs.appendFileSync(candidate,'changed');assert.throws(()=>retireSchemaCandidate(args),/candidate changed/);fs.copyFileSync(f.target,candidate);
 f.write(SCHEMA_INSTALL_PENDING,{});assert.throws(()=>retireSchemaCandidate(args),/incomplete/);fs.unlinkSync(path.join(f.home,SCHEMA_INSTALL_PENDING));
 assert.throws(()=>retireSchemaCandidate({...args,settingsHash:hash('other')}));
 assert.throws(()=>retireSchemaCandidate({...args,onStep:()=>fs.appendFileSync(candidate,'changed')}),/Assertion/);
 assert(fs.existsSync(candidate));assert(fs.existsSync(path.join(f.home,'application-indexed.pre-schema.sqlite')));
});

function readinessFixture(t){
 const f=installFixture(t),packageRoot=process.env.DUEBYTE_COMPAT_PACKAGE;
 assert(packageRoot,'compatible package required for stopped source recovery');
 fs.mkdirSync(path.join(f.home,'data'));fs.mkdirSync(path.join(f.home,'config'));
 f.write('data/priv_validator_state.json',{height:'5',round:0,step:3});
 f.write('config/priv_validator_key.json',{pub_key:{value:Buffer.from(f.validators[0].publicKey,'base64url').toString('base64')},privateFixture:'synthetic-only'});
 f.write('config/node_key.json',{privateFixture:'synthetic-peer'});
 const identity={network:f.config.chainId,configHash:hash(f.config),key:f.validators[0].publicKey},file=path.join(f.dir,'readiness.sqlite');
 let journal=new SchemaReadinessApprovalJournal(file,{...identity,create:true}),held=true,calls=0;
 f.closers.unshift(()=>journal.close());
 const args={home:f.home,packageRoot,candidate:f.target,config:f.config,certificate:f.settings.certificate,trustedBoundary:f.trustedBoundary,committedBlockHash:hash('committed-fixture'),
  fence:{identity:{network:f.config.chainId,unit:'duebyte-fresh-v45-node0.service',operation:'schema-test'},observe:()=>{assert(held,'fixture fence released');return {stopped:true,fenced:true,guardHash:hash('fixture-guard')};}},
  verifyBackup:async({boundary,receipt})=>({boundary,sourceReceipt:receipt,restoredReceipt:receipt,archiveAuthenticated:true,manifestHash:hash('manifest'),archiveHash:hash('archive')}),
  verifyConsensusBoundary:async boundary=>({boundary,commitVerified:true,readOnly:true,committedHeight:5,appliedHeight:5}),
  signer:body=>{calls++;return sign(body,f.validators[0].privateKey);}};
 return {...f,args,file,identity,get journal(){return journal;},calls:()=>calls,setHeld:x=>held=x,reopen:()=>{journal.close();journal=new SchemaReadinessApprovalJournal(file,identity);return journal;}};
}

test('schema proposal derives its own candidate and persists intent before the first signature',async t=>{
 const f=readinessFixture(t),args={...f.args,candidate:path.join(f.dir,'independent-proposal.sqlite')};
 await assert.rejects(()=>f.journal.approveProposal({...args,signer:()=>{assert.equal(f.journal.db.prepare('SELECT count(*) n FROM schema_proposals').get().n,1);throw Error('interrupted first signature');}}),/interrupted/);
 f.reopen();const a=await f.journal.approveProposal(args);assert.deepEqual(a.body,f.settings.certificate.body);
 assert.deepEqual(await f.reopen().approveProposal(args),a);assert.equal(f.calls(),1);
 for(const patch of [{genesisRoot:hash('other genesis')},{generation:args.trustedBoundary.generation+1},{validators:args.trustedBoundary.validators.map((v,i)=>i? v:{...v,power:v.power+1})}])await assert.rejects(()=>f.journal.approveProposal({...args,trustedBoundary:{...args.trustedBoundary,...patch}}));
 assert.equal(f.calls(),1,'Changed authority must not request another signature');
 const base=args.verifyBackup;
 await assert.rejects(()=>f.journal.approveProposal({...args,verifyBackup:async x=>({...await base(x),archiveHash:hash('different archive')})}),/evidence changed/);
 const db=new DatabaseSync(args.candidate);db.exec("UPDATE journal SET body='{}' WHERE sequence=2");db.close();
 await assert.rejects(()=>f.journal.approveProposal(args),/candidate changed/i);assert.equal(f.calls(),1);
});

test('schema proposal rejects unsafe evidence before conversion or signing',async t=>{
 const f=readinessFixture(t),args={...f.args,candidate:path.join(f.dir,'not-created.sqlite')},base=args.verifyBackup;
 for(const patch of [{committedHeight:6},{appliedHeight:4},{commitVerified:false}])await assert.rejects(()=>f.journal.approveProposal({...args,verifyConsensusBoundary:async b=>({...await args.verifyConsensusBoundary(b),...patch})}));
 await assert.rejects(()=>f.journal.approveProposal({...args,verifyBackup:async x=>({...await base(x),archiveAuthenticated:false})}));
 f.setHeld(false);await assert.rejects(()=>f.journal.approveProposal(args),/fence released/);
 assert(!fs.existsSync(args.candidate));assert.equal(f.calls(),0);assert.equal(f.journal.db.prepare('SELECT count(*) n FROM schema_proposals').get().n,0);
});

test('schema proposal refuses a supplied candidate and detects signing-time changes',async t=>{
 const f=readinessFixture(t);
 await assert.rejects(()=>f.journal.approveProposal(f.args),/target must not exist/);assert.equal(f.calls(),0);
 const args={...f.args,candidate:path.join(f.dir,'local-candidate.sqlite')};
 await assert.rejects(()=>f.journal.approveProposal({...args,signer:body=>{f.write('data/priv_validator_state.json',{height:'6',round:0,step:3});return args.signer(body);}}),/Native signing state changed/);
 assert.equal(f.journal.db.prepare('SELECT signature FROM schema_proposals').get().signature,null);
});

test('schema readiness uses restored encrypted backup and reuses durable approval after restart',async t=>{
 const f=readinessFixture(t);let transfer;
 const recovery=await exerciseFreshRecovery({out:f.dir,home:f.home,packageRoot:f.args.packageRoot,onSealed:v=>{transfer=v;}});
 assert(recovery.passed&&recovery.signingStateRetained);const restored=await withStoppedRecoveryState(recovery.restoredHome,{packageRoot:f.args.packageRoot,expected:transfer.expected});
 const base=f.args.verifyBackup;f.args.verifyBackup=async expected=>({...await base(expected),sourceReceipt:transfer.expected,restoredReceipt:restored});
 const a=await f.journal.approveSchema(f.args);assert.deepEqual(await f.reopen().approveSchema(f.args),a);assert.equal(f.calls(),1);
 const body=indexedSchemaReadinessBody(f.config,f.settings.certificate,f.trustedBoundary);
 assert.equal(a.key,f.validators[0].publicKey);assert.equal(a.signature,sign(body,f.validators[0].privateKey));
});

test('schema readiness rejects old recovery material, missing guard and unverified pending commit',async t=>{
 const f=readinessFixture(t),base=f.args.verifyBackup;
 for(const change of [b=>({...b,archiveAuthenticated:false}),b=>({...b,restoredReceipt:{...b.restoredReceipt,height:4}}),b=>({...b,sourceReceipt:{...b.sourceReceipt,identities:{}}}),b=>({...b,boundary:{...b.boundary,operation:'old'}})]){
  await assert.rejects(()=>f.journal.approveSchema({...f.args,verifyBackup:async x=>change(await base(x))}));
 }
 for(const change of [{commitVerified:false},{committedHeight:6},{appliedHeight:4}])await assert.rejects(()=>f.journal.approveSchema({...f.args,verifyConsensusBoundary:async b=>({...await f.args.verifyConsensusBoundary(b),...change})}));
 f.setHeld(false);await assert.rejects(()=>f.journal.approveSchema(f.args),/fence released/);f.setHeld(true);
 fs.unlinkSync(path.join(f.home,'indexed-schema-boundary.json'));await assert.rejects(()=>f.journal.approveSchema(f.args));assert.equal(f.calls(),0);
});

test('schema readiness persists intent before key invocation and refuses conflicting recovery on retry',async t=>{
 const f=readinessFixture(t);
 await assert.rejects(()=>f.journal.approveSchema({...f.args,signer:()=>{assert.equal(f.journal.db.prepare('SELECT count(*) AS n FROM schema_readiness').get().n,1);throw Error('signer interrupted');}}),/interrupted/);
 f.reopen();const base=f.args.verifyBackup;
 await assert.rejects(()=>f.journal.approveSchema({...f.args,verifyBackup:async x=>({...await base(x),archiveHash:hash('other-archive')})}),/evidence changed/);
 assert.equal(f.calls(),0);assert(await f.journal.approveSchema(f.args));
});

test('schema readiness detects fence and native watermark changes during asynchronous signing',async t=>{
 const f=readinessFixture(t),signer=f.args.signer;
 await assert.rejects(()=>f.journal.approveSchema({...f.args,signer:async body=>{f.setHeld(false);return signer(body);}}),/fence released/);
 assert.equal(f.journal.db.prepare('SELECT signature FROM schema_readiness').get().signature,null);
 f.setHeld(true);
 await assert.rejects(()=>f.journal.approveSchema({...f.args,signer:async body=>{f.write('data/priv_validator_state.json',{height:'6',round:0,step:3});return signer(body);}}),/Native signing state changed/);
 assert.equal(f.journal.db.prepare('SELECT signature FROM schema_readiness').get().signature,null);
});

test('schema readiness does not sign an altered candidate or a foreign local validator',async t=>{
 const f=readinessFixture(t),db=new DatabaseSync(f.target);db.exec("UPDATE journal SET body='{}' WHERE sequence=2");db.close();
 await assert.rejects(()=>f.journal.approveSchema(f.args));assert.equal(f.calls(),0);
 f.write('config/priv_validator_key.json',{pub_key:{value:Buffer.from(f.validators[1].publicKey,'base64url').toString('base64')}});
 await assert.rejects(()=>f.journal.approveSchema(f.args),/Wrong local validator/);assert.equal(f.calls(),0);
});

test('schema staging rejects low space before intent and after interruption without losing the original',t=>{
 const f=installFixture(t),active=path.join(f.home,'application-indexed.sqlite'),before=fs.readFileSync(active);
 const noSpace=t.mock.method(fs,'statfsSync',()=>({bavail:0n,bsize:4096n}));
 assert.throws(()=>f.install(),/insufficient free space/);assert(!fs.existsSync(path.join(f.home,SCHEMA_INSTALL_PENDING)));assert.deepEqual(fs.readFileSync(active),before);
 noSpace.mock.restore();
 assert.throws(()=>f.install({onStep:s=>{if(s==='intent')throw Error('interrupt');}}),/interrupt/);
 const lowAgain=t.mock.method(fs,'statfsSync',()=>({bavail:0n,bsize:4096n}));
 assert.throws(()=>f.install(),/insufficient free space/);assert.deepEqual(fs.readFileSync(active),before);assert(fs.existsSync(path.join(f.home,SCHEMA_INSTALL_PENDING)));
 lowAgain.mock.restore();assert.equal(f.install().status,'INSTALLED');
 assert.deepEqual(fs.readFileSync(path.join(f.home,'application-indexed.pre-schema.sqlite')),before);
});

test('offline schema installation resumes every durable boundary without replacing keys, history or balances',async t=>{
 for(const step of ['intent','staged','source-retained','database-installed','profile-retained','profile-installed','completed'])await t.test(step,t=>{
  const f=installFixture(t),before=new Map(['native-signing-state.json','encrypted-wallet.json','app-config.json'].map(n=>[n,fs.readFileSync(path.join(f.home,n))]));
  const oldBytes=fs.readFileSync(f.source);
  assert.throws(()=>f.install({onStep:s=>{if(s===step)throw Error('simulated interruption');}}),/simulated interruption/);
  assert.throws(()=>assertStateInstallationComplete(f.home),/incomplete/);
  assert.equal(f.install().status,'INSTALLED');assertStateInstallationComplete(f.home);
  assert.deepEqual(fs.readFileSync(path.join(f.home,'application-indexed.pre-schema.sqlite')),oldBytes);
  for(const [n,bytes]of before)assert.deepEqual(fs.readFileSync(path.join(f.home,n)),bytes);
  assert(!fs.existsSync(path.join(f.home,'fresh-activation.json')));
  const app=openIndexedSchemaApplication(path.join(f.home,'application-indexed.sqlite'),f.config,f.settings.certificate,f.trustedBoundary);
  try{assert.equal(canonical(app.handler.snapshotForAudit()),canonical(f.state));app.dispatch(q(6));app.dispatch({method:'commit'});}finally{app.close();}
  assert.equal(f.install().status,'ALREADY_INSTALLED');
  const advanced=openIndexedSchemaApplication(path.join(f.home,'application-indexed.sqlite'),f.config,f.settings.certificate,f.trustedBoundary);
  try{assert.equal(advanced.blocks.header.height,6);}finally{advanced.close();}
 });
});

test('offline installation rejects active writers, changed authority and changed retained state; partial staging can resume',t=>{
 const f=installFixture(t),release=acquireStateAccess(f.home);
 try{assert.throws(()=>f.install(),/state is in use/);assert.throws(()=>acquireStateAccess(f.home),/state is in use/);}finally{release();}
 assert(!fs.existsSync(path.join(f.home,SCHEMA_INSTALL_PENDING)));
 f.write('supervisor.lock',process.pid);assert.throws(()=>f.install(),/Stop the existing node/);fs.unlinkSync(path.join(f.home,'supervisor.lock'));
 assert.throws(()=>f.install({settings:{...f.settings,readiness:{...f.settings.readiness,approvals:f.settings.readiness.approvals.slice(0,9)}}}),/every active/);
 assert.throws(()=>f.install({onStep:s=>{if(s==='intent')throw Error('interrupt');}}),/interrupt/);
 fs.writeFileSync(path.join(f.home,'application-indexed.schema-stage.sqlite'),'partial copy');
 assert.throws(()=>f.install({settings:{...f.settings,readPort:28305}}),/authority changed/);
 const active=path.join(f.home,'application-indexed.sqlite'),saved=fs.readFileSync(active);fs.appendFileSync(active,'changed');
 assert.throws(()=>f.install(),/original database changed/);fs.writeFileSync(active,saved);
 assert.equal(f.install().status,'INSTALLED');
});

test('application rejects an unfinished installation before creating authorization or reading mixed settings',async t=>{
 const f=installFixture(t);assert.throws(()=>f.install({onStep:s=>{if(s==='database-installed')throw Error('interrupt');}}),/interrupt/);
 const child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../app.mjs'),f.home,'28303'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let output='';child.stderr.on('data',b=>output+=b);const [code]=await once(child,'exit');
 assert.notEqual(code,0);assert.match(output,/schema installation is incomplete/);
 assert(!fs.existsSync(path.join(f.home,'application-auth')));
 assert.equal(f.install().status,'INSTALLED');
});

test('installed services select the current interpreter and later restart does not materialize the population',async t=>{
 const f=installFixture(t);f.install();
 assert.equal((await serviceRuntime(f.dir,f.home,f.home)).kind,'current');
 const active=path.join(f.home,'application-indexed.sqlite'),app=openIndexedSchemaApplication(active,f.config,f.settings.certificate,f.trustedBoundary);
 app.dispatch(q(6));app.dispatch({method:'commit'});const root=app.handler.root;app.close();
 const original=BoundedNetworkInterpreter.prototype.snapshotForAudit;
 BoundedNetworkInterpreter.prototype.snapshotForAudit=()=>{throw Error('unexpected population scan');};
 try{const restored=openIndexedSchemaApplication(active,f.config,f.settings.certificate,f.trustedBoundary);try{assert.equal(restored.handler.root,root);restored.dispatch(q(7));restored.dispatch({method:'commit'});}finally{restored.close();}}
 finally{BoundedNetworkInterpreter.prototype.snapshotForAudit=original;}
});

test('full disk during candidate copy leaves the source intact and resumes from the durable intent',t=>{
 const f=installFixture(t),copy=fs.copyFileSync,before=fs.readFileSync(path.join(f.home,'application-indexed.sqlite'));
 fs.copyFileSync=(source,destination)=>{fs.writeFileSync(destination,'incomplete');throw Object.assign(Error('disk full'),{code:'ENOSPC'});};
 try{assert.throws(()=>f.install(),/disk full/);}finally{fs.copyFileSync=copy;}
 assert.deepEqual(fs.readFileSync(path.join(f.home,'application-indexed.sqlite')),before);
 assert.throws(()=>assertStateInstallationComplete(f.home),/incomplete/);
 assert.equal(f.install().status,'INSTALLED');
});

test('a stopped backup resumes installation at a different path without the original candidate',t=>{
 const f=installFixture(t);
 assert.throws(()=>f.install({onStep:s=>{if(s==='database-installed')throw Error('interrupt');}}),/interrupt/);
 const restored=path.join(f.dir,'restored-node');fs.cpSync(f.home,restored,{recursive:true});
 const names=['native-signing-state.json','encrypted-wallet.json','app-config.json'];
 const before=names.map(n=>fs.readFileSync(path.join(restored,n)));
 // The database is already staged in the copied stopped home. Recovery must
 // use that authenticated copy, not depend on the original preparation path.
 assert.equal(installIndexedSchema({home:restored,candidate:path.join(f.dir,'unavailable'),settings:f.settings}).status,'INSTALLED');
 names.forEach((n,i)=>assert.deepEqual(fs.readFileSync(path.join(restored,n)),before[i]));
 const app=openIndexedSchemaApplication(path.join(restored,'application-indexed.sqlite'),f.config,f.settings.certificate,f.trustedBoundary);
 try{assert.equal(canonical(app.handler.snapshotForAudit()),canonical(f.state));app.dispatch(q(6));app.dispatch({method:'commit'});}finally{app.close();}
 assert.throws(()=>assertStateInstallationComplete(f.home),/incomplete/);
 assertStateInstallationComplete(restored);
});

test('state ownership is released by the OS after killing its holder, without PID-file recovery',async t=>{
 const f=installFixture(t),module=pathToFileURL(path.resolve(import.meta.dirname,'../state-access.mjs')).href;
 const code=`import {acquireStateAccess} from ${JSON.stringify(module)}; acquireStateAccess(${JSON.stringify(f.home)}); console.log('locked'); setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 try{await once(child.stdout,'data');assert.throws(()=>acquireStateAccess(f.home),/state is in use/);const exited=once(child,'exit');child.kill('SIGKILL');await exited;const release=acquireStateAccess(f.home);release();assert.equal(f.install().status,'INSTALLED');}
 finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
});

test('schema readiness requires every active writer and a guarded legacy boundary survives restart',t=>{
 const f=fixture(t),prepared=prepareIndexedSchemaUpgrade(f.args),certificate=f.signBody(prepared.body);
 const body=indexedSchemaReadinessBody(f.config,certificate,f.trustedBoundary),receipt={body,approvals:f.validators.map(k=>({key:k.publicKey,signature:sign(body,k.privateKey)}))};
 verifyIndexedSchemaReadiness(receipt,f.config,certificate,f.trustedBoundary);
 const settings={readPort:28304,bootstrap:false,certificate,trustedBoundary:f.trustedBoundary};
 assert.throws(()=>verifyIndexedSchemaActivation(settings,f.config));
 verifyIndexedSchemaActivation({...settings,readiness:receipt},f.config,{isValidator:true});
 verifyIndexedSchemaActivation({...settings,bootstrap:true},f.config);
 assert.throws(()=>verifyIndexedSchemaActivation({...settings,bootstrap:true},f.config,{isValidator:true}),/cannot bypass/);
 assert.throws(()=>verifyIndexedSchemaActivation({...settings,readiness:{...receipt,approvals:receipt.approvals.slice(0,7)}},f.config,{isValidator:true}),/every active/);
 for(const approvals of [receipt.approvals.slice(0,7),receipt.approvals.slice(0,9),[...receipt.approvals.slice(0,9),receipt.approvals[0]]])assert.throws(()=>verifyIndexedSchemaReadiness({body,approvals},f.config,certificate,f.trustedBoundary));
 for(const change of [{sourceHeight:6},{certificateHash:hash('another certificate')},{generation:1}])assert.throws(()=>verifyIndexedSchemaReadiness({...receipt,body:{...body,...change}},f.config,certificate,f.trustedBoundary));
 const open=()=>new LegacyApplication(Legacy.open(f.source,f.config,f.trustedBoundary.root),{kind:'fresh-genesis'});
 assert.deepEqual(persistIndexedSchemaBoundary(f.dir,f.config,certificate,f.trustedBoundary),body);
 assert.deepEqual(persistIndexedSchemaBoundary(f.dir,f.config,certificate,f.trustedBoundary),body);
 for(let restart=0;restart<2;restart++){
  const old=open(),guard=openGuardedIndexedSchemaBoundary(f.dir,old,f.config,certificate,f.trustedBoundary),before=canonical(old.handler.snapshotForAudit());
  try{
   assert.deepEqual(guard.readinessBody,body);assert.equal(infoHash(guard),f.trustedBoundary.root);
   assert.equal(guard.dispatch({method:'check',txs:[]}).code,1);assert.equal(guard.dispatch({...q(6),method:'process'}).accept,false);
   for(const method of ['prepare','finalize','commit','init','work','publicWork'])assert.throws(()=>guard.dispatch({...q(6),method}),/compatible runtime/);
   assert.equal(canonical(old.handler.snapshotForAudit()),before);
  }finally{guard.close();}
 }
 const file=path.join(f.dir,'indexed-schema-boundary.json'),saved=fs.readFileSync(file),old=open();
 try{
  fs.writeFileSync(file,JSON.stringify({body:{...body,sourceHeight:6},certificate,trustedBoundary:f.trustedBoundary}));
  assert.throws(()=>openGuardedIndexedSchemaBoundary(f.dir,old,f.config,certificate,f.trustedBoundary),/conflict/);
  assert.throws(()=>persistIndexedSchemaBoundary(f.dir,f.config,certificate,f.trustedBoundary),/conflict/);
  fs.unlinkSync(file);assert.throws(()=>openGuardedIndexedSchemaBoundary(f.dir,old,f.config,certificate,f.trustedBoundary),/ENOENT/);
  fs.writeFileSync(file,saved);
 }finally{old.close();}
 const late=open();late.dispatch(q(6));late.dispatch({method:'commit'});
 try{assert.throws(()=>guardIndexedSchemaBoundary(late,f.config,certificate,f.trustedBoundary),/beyond/);}finally{late.close();}
});

test('Home schema delivery waits for supported software and verified state; staggered installs retain wallets and recover after binding commit',async t=>{
 const f=fixture(t),write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));},read=file=>JSON.parse(fs.readFileSync(file));
 const prepared=prepareIndexedSchemaUpgrade(f.args),certificate=f.signBody(prepared.body),app=openIndexedSchemaApplication(f.target,f.config,certificate,f.trustedBoundary);f.closers.push(()=>app.close());
 const state=path.join(f.dir,'home'),oldNode=path.join(state,'node-fresh-v1'),native=initialize(oldNode,'synthetic-test-password');
 const genesis={...native.genesisTemplate,chain_id:f.config.chainId,app_state:f.config,validators:f.validators.map(k=>({power:'10',pub_key:{type:'tendermint/PubKeyEd25519',value:Buffer.from(k.publicKey,'base64url').toString('base64')}}))};
 const policy={domain:CHECKPOINT+'/POLICY',network:f.config.chainId,genesisHash:hash(genesis),...f.config.control.policy},signed=body=>({body,signatures:f.members.slice(0,3).map(k=>attest(body,k))}),now=Math.floor(Date.now()/1000);
 const checkpoint=signed({domain:CHECKPOINT,policyHash:hash(policy),network:f.config.chainId,genesisHash:hash(genesis),sequence:1,height:6,blockHash:hash('old-bootstrap'),appHeight:5,appHash:f.trustedBoundary.root,snapshotHash:hash('old-snapshot'),previous:null,issuedAt:now,expiresAt:now+300});
 const manifest={domain:'DUEBYTE_FRESH_GENESIS_V2',network:f.config.chainId,configHash:hash(f.config),stateHash:hash(origin(f.config)),root:f.trustedBoundary.genesisRoot,height:0,issuance:false,imports:false,timing:{...FIXED_BLOCK_TIMING}};
 const pin='ssh-ed25519 '+Buffer.concat([Buffer.from('0000000b7373682d6564323535313900000020','hex'),Buffer.alloc(32,1)]).toString('base64');
 const original={version:1,config:f.config,genesis,policy,basePort:28300,walletPort:28310,hosts:[{ip:'192.0.2.1',port:2244,user:'duebytefollower',pin,forwards:[[28400,28400],[28401,28401],[28525,28525]]},{ip:'192.0.2.2',port:2244,user:'duebytefollower',pin,forwards:[[28410,28410],[28411,28411]]}],peers:[{id:'1'.repeat(40),port:28400},{id:'2'.repeat(40),port:28410}],rpcServers:['http://127.0.0.1:28401','http://127.0.0.1:28411'],workers:{},fresh:{manifest,manifestHash:hash(manifest),readPort:28304,url:'http://127.0.0.1:28525'}};
 const oldPin=hash(original),profile={...original,schemaUpgrade:{previousProfileHash:oldPin,previousManifestHash:hash(manifest),readPort:28304,url:original.fresh.url,certificate,trustedBoundary:f.trustedBoundary}};delete profile.fresh;
 const nextPin=hash(profile),body={domain:'DUEBYTE_HOME_PROFILE_DELIVERY_V1',sequence:1,fromProfileHash:oldPin,toProfileHash:nextPin,minimumVersion:'0.3.58',issuedAt:now,expiresAt:now+300,profile},release={edition:'home',version:'0.3.58',networkPin:oldPin};
 validateConsumerProfile(profile,nextPin);validateTransitionDelivery(body,release,original);
 for(const version of ['0.3.56','0.3.57'])assert.throws(()=>validateTransitionDelivery(body,{...release,version},original),/newer software/);
 for(const mutate of [p=>p.schemaUpgrade.previousManifestHash=hash('foreign'),p=>p.schemaUpgrade.certificate.approvals.pop(),p=>p.schemaUpgrade.trustedBoundary.genesisRoot=hash('foreign'),p=>p.fresh=original.fresh]){const bad=structuredClone(profile);mutate(bad);assert.throws(()=>validateTransitionDelivery({...body,profile:bad,toProfileHash:hash(bad)},release,original));}
 const setup=path.join(f.dir,'old-profile');for(const [name,data] of Object.entries({'genesis.json':genesis,'app-config.json':f.config,'trust-policy.json':policy,'checkpoint.json':checkpoint,'operators-public.json':original.peers.map(x=>({peerId:x.id,endpoint:`127.0.0.1:${x.port}`}))}))write(path.join(setup,name),data);
 legacyFreshRootTerms(f.config,original.fresh);
 // The immutable baseline is a Linux package; retain its real V6 database and
 // authority, with a native Windows non-voting identity for the Home fixture.
 for(const [name,data] of Object.entries({'config/genesis.json':genesis,'app-config.json':f.config,'trust-policy.json':policy,'checkpoint.json':checkpoint,'run-settings.json':{basePort:original.basePort,isValidator:false,trustPolicyHash:hash(policy)},'fresh-activation.json':{manifest,manifestHash:hash(manifest),readPort:28304,bootstrap:true}}))write(path.join(oldNode,name),data);
 fs.copyFileSync(f.source,path.join(oldNode,'application-indexed.sqlite'));
 write(path.join(state,'installation.json'),{version:1,profileHash:oldPin,network:f.config.chainId,nodeDirectory:'node-fresh-v1',manifestHash:hash(manifest)});
 const wallet=path.join(state,'wallet');for(const [name,data] of Object.entries({'genesis.json':genesis,'app-config.json':f.config,'trust-policy.json':policy,'checkpoint.json':checkpoint,'connections.json':consumerConnections(original),'indexed-wallet.json':{bounded:{url:original.fresh.url,fresh:{manifest,manifestHash:hash(manifest)}}},'wallet.encrypted.json':{sentinel:'encrypted keys retained'},'pending-payments.json':{sentinel:'obligations retained'}}))write(path.join(wallet,name),data);
 const identity=consumerIdentity(state,profile,nextPin);assert.equal(read(path.join(state,'installation.json')).profileHash,oldPin);
 const retained=['node-fresh-v1/application-indexed.sqlite','node-fresh-v1/config/node_key.json','node-fresh-v1/data/priv_validator_state.json','wallet/wallet.encrypted.json','wallet/pending-payments.json','transport-key','device.json'].map(n=>[n,sha256(fs.readFileSync(path.join(state,n)))]);
 const late=path.join(f.dir,'late-home');fs.cpSync(state,late,{recursive:true});
 const packageRoot=path.join(f.dir,'delivery-package'),signers=authority(),trust=rootBytes(signers);
 const readinessBody=indexedSchemaReadinessBody(f.config,certificate,f.trustedBoundary),readiness={body:readinessBody,approvals:f.validators.map(k=>({key:k.publicKey,signature:sign(readinessBody,k.privateKey)}))};
 const retainedTargets={'home-windows-x64.json':Buffer.from('immutable Windows release'),'home-linux-x64.json':Buffer.from('immutable Linux release'),'server-linux-x64.json':Buffer.from('immutable Server release')};
 const baseFeed=feed(signers,retainedTargets,{version:1}),catalog={root:trust,targets:baseFeed['targets.json'],snapshot:baseFeed['snapshot.json'],timestamp:baseFeed['timestamp.json']};
 const planArgs={original,certificate,trustedBoundary:f.trustedBoundary,readiness,sequence:1,expiresAt:now+300,catalog,pinnedRootSha256:sha256(trust),now};
 assert.throws(()=>prepareSchemaProfileCatalogPlan({...planArgs,readiness:{...readiness,approvals:readiness.approvals.slice(0,9)}}),/every active validator/);
 assert.throws(()=>prepareSchemaProfileCatalogPlan({...planArgs,original:{...original,fresh:{...original.fresh,manifestHash:hash('different predecessor')}}}));
 const catalogPlan=prepareSchemaProfileCatalogPlan(planArgs),signedPlan=signProfileCatalogPlan(catalogPlan,catalog,(v,r)=>signMetadata(v,r,signers),now);
 assert.deepEqual(JSON.parse(signedPlan.profileBytes),body);assert.equal(catalogPlan.review.readinessHash,hash(readiness));
 const checked=verifyProfileCatalog({catalog:signedPlan.catalog,pinnedRootSha256:sha256(trust),now});
 for(const name of Object.keys(retainedTargets))assert.deepEqual(checked.targets.signed.targets[name].toJSON(),JSON.parse(catalog.targets).signed.targets[name]);
 const target=signedPlan.profileBytes,metadata=Object.fromEntries(['targets','snapshot','timestamp'].map(r=>[r+'.json',signedPlan.catalog[r]]));
 write(path.join(packageRoot,'connection-profile.json'),original);write(path.join(packageRoot,'connection-pin.json'),{sha256:oldPin});fs.writeFileSync(path.join(packageRoot,'update-root.json'),trust);
 const releaseConfig={schema:1,...release,platform:process.platform==='win32'?'windows-x64':'linux-x64',rootSha256:sha256(trust),metadataUrl:'https://duebyte.com/updates/stable/metadata/',targetsUrl:'https://duebyte.com/updates/stable/targets/'};write(path.join(packageRoot,'release-config.json'),releaseConfig);
 let cut=true;const content={'/metadata/1.root.json':trust,...Object.fromEntries(Object.entries(metadata).map(([name,bytes])=>['/metadata/'+name,bytes])),'/targets/home-indexed-profile.json':target};
 const delivery=http.createServer((req,res)=>{if(cut&&req.url==='/targets/home-indexed-profile.json'){res.destroy();return;}const bytes=content[req.url];res.statusCode=bytes?200:404;res.end(bytes);});delivery.listen(0,'127.0.0.1');await once(delivery,'listening');f.closers.unshift(()=>new Promise(resolve=>delivery.close(resolve)));
 const base='http://127.0.0.1:'+delivery.address().port,urls={metadata:base+'/metadata/',targets:base+'/targets/'},stage=()=>stageTransitionProfile({root:packageRoot,state,urls});
 await assert.rejects(stage);assert(!fs.existsSync(path.join(state,'updates/profiles/highest.json')));assert.equal(read(path.join(state,'installation.json')).profileHash,oldPin);
 cut=false;write(path.join(packageRoot,'release-config.json'),{...releaseConfig,version:'0.3.57'});await assert.rejects(stage,/newer software/);assert(!fs.existsSync(path.join(state,'updates/profiles/highest.json')));
 write(path.join(packageRoot,'release-config.json'),releaseConfig);const staged=await stage();assert.deepEqual(fs.readFileSync(staged.file),target);assert.equal(staged.active,false);assert.equal(staged.issuance,false);assert.equal(read(path.join(state,'installation.json')).profileHash,oldPin);assert.deepEqual(await stage(),staged);
 assert.throws(()=>prepareConsumer(state,profile,nextPin,checkpoint),/authenticated/);await assert.rejects(()=>authenticateConsumerIndexedCheckpoint(profile,checkpoint),/first indexed/);
 app.dispatch(q(6));app.dispatch({method:'commit'});const repository=new IndexedCheckpointRepository(f.dir,app,policy),transport=await repository.prepare();app.dispatch(q(7));app.dispatch({method:'commit'});
 const current=signed(indexedCheckpointBody(app,transport.manifest,policy,{previous:checkpoint}));repository.install(current,transport.manifest);
 const api=createBoundedApi(app.handler,{rootReader:root=>repository.readRoot(root)});api.listen(28525,'127.0.0.1');await once(api,'listening');f.closers.unshift(()=>new Promise(resolve=>api.close(resolve)));
 const proof=await authenticateConsumerIndexedCheckpoint(profile,current);
 write(path.join(oldNode,'supervisor.lock'),process.pid);assert.throws(()=>prepareConsumer(state,profile,nextPin,current,proof),/Stop the existing/);fs.unlinkSync(path.join(oldNode,'supervisor.lock'));
 const installed=prepareConsumer(state,profile,nextPin,current,proof);assert.equal(installed.node,path.join(state,'node-schema-v15'));assert.equal(consumerIdentity(state,profile,nextPin).id,identity.id);
 assert.equal(read(path.join(late,'installation.json')).profileHash,oldPin,'late Home stays untouched');
 for(const [n,digest] of retained)assert.equal(sha256(fs.readFileSync(path.join(state,n))),digest,n);
 assert.equal(sha256(fs.readFileSync(path.join(installed.node,'config/node_key.json'))),sha256(fs.readFileSync(path.join(oldNode,'config/node_key.json'))));
 assert.equal(read(path.join(wallet,'indexed-wallet.json')).bounded.schemaUpgrade.certificate.body.targetRoot,certificate.body.targetRoot);
 assert.match(fs.readFileSync(path.join(installed.node,'config/config.toml'),'utf8'),/timeout_commit = "10s"/);
 assert.deepEqual(prepareConsumer(state,profile,nextPin,current,proof),installed);
 // Model power loss after the one-way binding, before node/wallet publication.
 write(path.join(late,'installation.json'),read(path.join(state,'installation.json')));fs.mkdirSync(path.join(late,'node-schema-v15-preparing-interrupted'));write(path.join(late,'node-schema-v15-preparing-interrupted/sentinel.json'),{retained:true});
 const recovered=prepareConsumer(late,profile,nextPin,current,proof);assert.equal(recovered.node,path.join(late,'node-schema-v15'));
 for(const [n,digest] of retained)assert.equal(sha256(fs.readFileSync(path.join(late,n))),digest,n);
 assert(fs.existsSync(path.join(late,'node-schema-v15-preparing-interrupted/sentinel.json')));
 assert.throws(()=>consumerIdentity(state,original,oldPin),/incompatible|profile|downgrade/);
});

test('wallet authority advances only from the pinned V6 genesis and preserves its anchor',t=>{
 const f=fixture(t),p=prepareIndexedSchemaUpgrade(f.args),certificate=f.signBody(p.body),terms=indexedSchemaRootTerms(f.config,{certificate,trustedBoundary:f.trustedBoundary});
 const previous={kind:'fresh-genesis',manifestHash:hash('original manifest'),network:f.config.chainId,configHash:hash(f.config),targetSchema:'DUEBYTE_BOUNDED_NETWORK_V6',sourceHeight:0,activationHeight:1,sourceRoot:hash(origin(f.config)),targetRoot:f.trustedBoundary.genesisRoot,archive:null};
 verifyIndexedSchemaPredecessor(previous,terms);verifyIndexedSchemaPredecessor(terms,terms);
 for(const change of [{targetRoot:hash('foreign')},{network:'foreign'},{sourceRoot:hash('foreign')},{targetSchema:'DUEBYTE_BOUNDED_NETWORK_V15'},{sourceHeight:1}])assert.throws(()=>verifyIndexedSchemaPredecessor({...previous,...change},terms));
 assert.throws(()=>verifyIndexedSchemaPredecessor(terms,previous));assert.throws(()=>verifyIndexedSchemaPredecessor(terms,{...terms,targetRoot:hash('new certificate')}));
 const app=openIndexedSchemaApplication(f.target,f.config,certificate,f.trustedBoundary);try{const anchor=app.handler.store.proof('meta/anchor',app.handler.root).value;verifyBoundedViewAnchor(anchor,terms);for(const change of [{height:5},{sourceStateHash:terms.sourceRoot},{domain:previous.targetSchema},{issuance:true}])assert.throws(()=>verifyBoundedViewAnchor({...anchor,...change},terms));}finally{app.close();}
});

test('service profile requires the same certificate and rejects conflicting local authorities',t=>{
 const f=fixture(t),p=prepareIndexedSchemaUpgrade(f.args),certificate=f.signBody(p.body),activation={certificate,trustedBoundary:f.trustedBoundary,readPort:28204,bootstrap:true},write=(name,value)=>fs.writeFileSync(path.join(f.dir,name),JSON.stringify(value));
 write('indexed-checkpoint-operator.json',{applicationHome:f.dir});write('indexed-schema-activation.json',activation);
 assert.deepEqual(serviceBoundedProfile(f.dir,f.config),{url:'http://127.0.0.1:28204',schemaUpgrade:{certificate,trustedBoundary:f.trustedBoundary}});
 write('indexed-schema-activation.json',{...activation,certificate:{...certificate,approvals:certificate.approvals.slice(0,6)}});assert.throws(()=>serviceBoundedProfile(f.dir,f.config));
 write('indexed-schema-activation.json',{...activation,readPort:80});assert.throws(()=>serviceBoundedProfile(f.dir,f.config));
 write('indexed-schema-activation.json',activation);write('fresh-activation.json',{});assert.throws(()=>serviceBoundedProfile(f.dir,f.config),/ambiguous/);
});

test('same-chain upgrade preserves the complete old journal and survives finalize/commit acknowledgement loss',t=>{
 const f=fixture(t),sourceHash=sha256(fs.readFileSync(f.source)),prepared=prepareIndexedSchemaUpgrade(f.args),cert=f.signBody(prepared.body),open=()=>openIndexedSchemaApplication(f.target,f.config,cert,f.trustedBoundary);
 assert.equal(prepared.productionInstallable,false);assert.equal(sha256(fs.readFileSync(f.source)),sourceHash);
 let app=open();assert.equal(canonical(app.handler.snapshotForAudit()),canonical(f.state));assert.equal(infoHash(app),f.trustedBoundary.root);
 const old=new DatabaseSync(f.source,{readOnly:true});try{const rows=old.prepare('SELECT * FROM journal ORDER BY sequence').all();assert.deepEqual(app.handler.store.db.prepare('SELECT * FROM journal WHERE sequence<=5 ORDER BY sequence').all(),rows);}finally{old.close();}
 const candidate=app.dispatch(q(6));assert.equal(infoHash(app),f.trustedBoundary.root);app.close();
 app=open();assert.equal(infoHash(app),f.trustedBoundary.root);assert.deepEqual(app.dispatch(q(6)),candidate);app.dispatch({method:'commit'});assert.equal(app.dispatch({method:'info'}).height,6);assert.equal(infoHash(app),Buffer.from(candidate.hash,'base64').toString('hex'));app.close();
 app=open();assert.deepEqual(app.dispatch(q(6)),candidate);app.dispatch({method:'commit'});assert.equal(app.handler.store.meta.sequence,7);assert.equal(indexedBlock(app,6).root,infoHash(app));
 app.dispatch(q(7));app.dispatch({method:'commit'});assert.equal(indexedBlock(app,7).blockHash,hash(['new',7]));const root=infoHash(app);app.close();
 app=open();assert.equal(infoHash(app),root);assert.equal(app.blocks.header.height,7);assert.equal(app.handler.snapshotForAudit().money.supply,'0');app.close();assert.equal(sha256(fs.readFileSync(f.source)),sourceHash);
});

test('independent conversions agree and old V6 cannot open the converted state',t=>{
 const f=fixture(t),a=prepareIndexedSchemaUpgrade(f.args),b=prepareIndexedSchemaUpgrade({...f.args,target:path.join(f.dir,'second.sqlite')});assert.deepEqual(a,b);
 assert.throws(()=>Legacy.open(f.target,f.config,a.body.targetRoot));
 const cert=f.signBody(a.body),left=openIndexedSchemaApplication(f.target,f.config,cert,f.trustedBoundary),right=openIndexedSchemaApplication(path.join(f.dir,'second.sqlite'),f.config,cert,f.trustedBoundary);
 try{for(const h of [6,7,8]){assert.deepEqual(left.dispatch(q(h)),right.dispatch(q(h)));left.dispatch({method:'commit'});right.dispatch({method:'commit'});assert.equal(infoHash(left),infoHash(right));}}finally{left.close();right.close();}
});

test('quorum, pins, generation, no-issuance and exact activation height are required',t=>{
 const f=fixture(t),p=prepareIndexedSchemaUpgrade(f.args),cert=f.signBody(p.body),verify=c=>verifyIndexedSchemaUpgrade(c,f.config,f.trustedBoundary);
 verify(cert);assert.throws(()=>verify({...cert,approvals:cert.approvals.slice(0,6)}));assert.throws(()=>verify({...cert,approvals:[...cert.approvals.slice(0,6),cert.approvals[0]]}));
 for(const change of [{sourceRoot:hash('foreign')},{network:'foreign'},{activationHeight:7},{generation:1},{issuance:true},{targetSchema:'other'}])assert.throws(()=>verify(f.signBody({...p.body,...change})));
 assert.throws(()=>verify({...cert,approvals:cert.approvals.map(s=>({...s,signature:'x'}))}));
 assert.throws(()=>openIndexedSchemaApplication(f.target,f.config,cert,{...f.trustedBoundary,journalHash:hash('wrong')}));
});

test('missing or altered source journal rejects preparation without modifying source or target',t=>{
 const f=fixture(t),db=new DatabaseSync(f.source);db.prepare('DELETE FROM journal WHERE sequence=2').run();db.close();const before=sha256(fs.readFileSync(f.source));
 assert.throws(()=>prepareIndexedSchemaUpgrade(f.args));assert(!fs.existsSync(f.target));assert.equal(sha256(fs.readFileSync(f.source)),before);assert(!fs.readdirSync(f.dir).some(n=>n.startsWith('.schema-upgrade-')));
});

test('restart refuses a missing bridge, altered original history or a changed bridge',t=>{
 for(const sql of ['DELETE FROM journal WHERE sequence=6',"UPDATE journal SET body='{}' WHERE sequence=2","UPDATE journal SET digest='bad' WHERE sequence=6"]){
  const f=fixture(t),p=prepareIndexedSchemaUpgrade(f.args),cert=f.signBody(p.body),db=new DatabaseSync(f.target);db.exec(sql);db.close();assert.throws(()=>openIndexedSchemaApplication(f.target,f.config,cert,f.trustedBoundary));
 }
});

test('preparation never overwrites existing output and rejects wrong genesis or stale boundary',t=>{
 const f=fixture(t);fs.writeFileSync(f.target,'retained');assert.throws(()=>prepareIndexedSchemaUpgrade(f.args));assert.equal(fs.readFileSync(f.target,'utf8'),'retained');
 const target=path.join(f.dir,'other.sqlite');for(const change of [{genesisRoot:hash('wrong')},{height:4},{root:hash('wrong')},{generation:1}]){assert.throws(()=>prepareIndexedSchemaUpgrade({...f.args,target,trustedBoundary:{...f.trustedBoundary,...change}}));assert(!fs.existsSync(target));}
 assert(!fs.readdirSync(f.dir).some(n=>n.startsWith('.schema-upgrade-')));
});

test('post-upgrade snapshot restores through the worker, keeps old history and resumes consensus',async t=>{
 const f=fixture(t),p=prepareIndexedSchemaUpgrade(f.args),certificate=f.signBody(p.body),schemaUpgrade={certificate,trustedBoundary:f.trustedBoundary};
 const app=openIndexedSchemaApplication(f.target,f.config,certificate,f.trustedBoundary);f.closers.push(()=>app.close());
 app.dispatch(q(6));app.dispatch({method:'commit'});const expected=app.handler.snapshotForAudit(),snapshot=await exportIndexedSnapshot(app.handler,path.join(f.dir,'export'));
 app.dispatch(q(7));app.dispatch({method:'commit'});
 const policy={domain:CHECKPOINT+'/POLICY',network:f.config.chainId,genesisHash:hash({chain_id:f.config.chainId,app_state:f.config}),...f.config.control.policy};
 const body=indexedCheckpointBody(app,snapshot.manifest,policy),document={body,signatures:f.members.slice(0,3).map(k=>attest(body,k))};
 const target=path.join(f.dir,'restored.sqlite'),args={directory:path.join(f.dir,'incoming'),target,metadata:{document,manifest:snapshot.manifest},policy,config:f.config,schemaUpgrade};
 let receiver=new IndexedSnapshotReceiver(args);assert.throws(()=>receiver.install(),/incomplete/);
 for(let index=snapshot.manifest.chunks-1;index>=0;index--)receiver.receive(readChunk(snapshot.file,snapshot.manifest,snapshot.levels,index));
 receiver=new IndexedSnapshotReceiver(args);receiver.receive(readChunk(snapshot.file,snapshot.manifest,snapshot.levels,0));
 await assert.rejects(()=>receiver.installAsync({beforePublish:()=>{throw Error('interrupted');}}),/interrupted/);assert(!fs.existsSync(target));
 assert.deepEqual(await receiver.installAsync(),{height:6,root:snapshot.manifest.root});
 const restored=openIndexedSchemaApplication(target,f.config,certificate,f.trustedBoundary);
 try{assert.deepEqual(restored.handler.snapshotForAudit(),expected);assert.equal(restored.handler.store.db.prepare('SELECT count(*) n FROM journal WHERE sequence<=5').get().n,5);restored.dispatch(q(7));restored.dispatch({method:'commit'});assert.equal(infoHash(restored),infoHash(app));}finally{restored.close();}
 assert.throws(()=>new IndexedSnapshotReceiver(args),/existing state/);
 for(const change of [{source:f.state},{fresh:{}},{certificate}])assert.throws(()=>new IndexedSnapshotReceiver({...args,target:path.join(f.dir,'bad.sqlite'),...change}),/single state authority/);
 assert.throws(()=>new IndexedSnapshotReceiver({...args,target:path.join(f.dir,'bad.sqlite'),schemaUpgrade:{certificate,trustedBoundary:{...f.trustedBoundary,root:hash('wrong')}}}));
});

test('valid transport signatures cannot hide missing upgrade history',async t=>{
 const f=fixture(t),p=prepareIndexedSchemaUpgrade(f.args),certificate=f.signBody(p.body),app=openIndexedSchemaApplication(f.target,f.config,certificate,f.trustedBoundary);f.closers.push(()=>app.close());
 app.dispatch(q(6));app.dispatch({method:'commit'});app.handler.store.db.exec('DELETE FROM journal WHERE sequence=2');
 const snapshot=await exportIndexedSnapshot(app.handler,path.join(f.dir,'damaged-export'));app.dispatch(q(7));app.dispatch({method:'commit'});
 const policy={domain:CHECKPOINT+'/POLICY',network:f.config.chainId,genesisHash:hash({chain_id:f.config.chainId,app_state:f.config}),...f.config.control.policy};
 const body=indexedCheckpointBody(app,snapshot.manifest,policy),document={body,signatures:f.members.slice(0,3).map(k=>attest(body,k))},target=path.join(f.dir,'must-not-install.sqlite');
 const receiver=new IndexedSnapshotReceiver({directory:path.join(f.dir,'incoming'),target,metadata:{document,manifest:snapshot.manifest},policy,config:f.config,schemaUpgrade:{certificate,trustedBoundary:f.trustedBoundary}});
 for(let i=0;i<snapshot.manifest.chunks;i++)receiver.receive(readChunk(snapshot.file,snapshot.manifest,snapshot.levels,i));
 await assert.rejects(()=>receiver.installAsync());assert(!fs.existsSync(target));assert(!fs.readdirSync(receiver.directory).some(n=>n.startsWith('assembled-')));
});

test('ordinary validator process rejects missing readiness and a bootstrap bypass before touching data',async t=>{
 const f=fixture(t),prepared=prepareIndexedSchemaUpgrade(f.args),certificate=f.signBody(prepared.body),home=path.join(f.dir,'guarded-validator');
 fs.mkdirSync(path.join(home,'config'),{recursive:true});
 for(const [name,value]of Object.entries({'app-config.json':f.config,'trust-policy.json':{},'config/priv_validator_key.json':{pub_key:{value:Buffer.from(f.validators[0].publicKey,'base64url').toString('base64')}}}))fs.writeFileSync(path.join(home,name),JSON.stringify(value));
 for(const bootstrap of [false,true]){
  fs.writeFileSync(path.join(home,'indexed-schema-activation.json'),JSON.stringify({readPort:28304,bootstrap,certificate,trustedBoundary:f.trustedBoundary}));
  const child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../app.mjs'),home,'28303'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let error='';child.stderr.on('data',b=>error+=b);const timer=setTimeout(()=>child.kill(),15000);
  const [code]=await once(child,'exit');clearTimeout(timer);assert.notEqual(code,null,'application did not fail promptly');assert.notEqual(code,0);
  assert.match(error,bootstrap?/validator cannot bypass/:/AssertionError/);
  for(const name of ['application-auth','application-indexed.sqlite','application.sqlite','indexed-schema-installed.json'])assert(!fs.existsSync(path.join(home,name)),name);
 }
});

test('ordinary upgraded process restores a snapshot, replays its acknowledgement and refuses state loss',async t=>{
 const f=fixture(t),p=prepareIndexedSchemaUpgrade(f.args),certificate=f.signBody(p.body),app=openIndexedSchemaApplication(f.target,f.config,certificate,f.trustedBoundary);
 let snapshot,document;const policy={domain:CHECKPOINT+'/POLICY',network:f.config.chainId,genesisHash:hash({chain_id:f.config.chainId,app_state:f.config}),...f.config.control.policy};
 try{app.dispatch(q(6));app.dispatch({method:'commit'});snapshot=await exportIndexedSnapshot(app.handler,path.join(f.dir,'http-export'));app.dispatch(q(7));app.dispatch({method:'commit'});const body=indexedCheckpointBody(app,snapshot.manifest,policy);document={body,signatures:f.members.slice(0,3).map(k=>attest(body,k))};}finally{app.close();}
 const home=path.join(f.dir,'http-home');fs.mkdirSync(home);const probes=[createServer(),createServer()];for(const probe of probes)await new Promise(ok=>probe.listen(0,'127.0.0.1',ok));const [port,readPort]=probes.map(s=>s.address().port);for(const probe of probes)await new Promise(ok=>probe.close(ok));
 for(const [name,value]of Object.entries({'app-config':f.config,'trust-policy':policy,'indexed-schema-activation':{readPort,bootstrap:true,certificate,trustedBoundary:f.trustedBoundary}}))fs.writeFileSync(path.join(home,name+'.json'),JSON.stringify(value));
 const children=new Set(),call=(request,token)=>fetch('http://127.0.0.1:'+port,{method:'POST',headers:token?{'x-duebyte-app-auth':token}:{},body:JSON.stringify(request),signal:AbortSignal.timeout(30000)});
 const stop=async child=>{if(child.exitCode===null&&child.signalCode===null){const done=new Promise(ok=>child.once('exit',ok));child.kill();await done;}children.delete(child);};f.closers.push(async()=>{for(const child of children)await stop(child);});
 const launch=()=>{const log=fs.openSync(path.join(home,'process.log'),'a'),child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../app.mjs'),home,String(port)],{stdio:['ignore',log,log],windowsHide:true});fs.closeSync(log);children.add(child);return child;};
 const start=async()=>{const child=launch();for(let i=0;i<100;i++){try{if((await call({method:'info'})).ok)return child;}catch{}assert.equal(child.exitCode,null,fs.readFileSync(path.join(home,'process.log'),'utf8'));await new Promise(ok=>setTimeout(ok,50));}assert.fail('startup timeout');};
 let child=await start(),token=readApplicationAuth(home);assert(!fs.existsSync(path.join(home,'application.sqlite')));assert.equal((await(await call({method:'info'})).json()).height,0);
 assert.equal((await call(q(1),token)).status,400);const offer={method:'offerSnapshot',snapshot:snapshotOffer(document,snapshot.manifest),appHash:snapshot.manifest.root};
 assert.equal((await call(offer)).status,403);assert.equal((await call({...offer,appHash:hash('wrong')},token)).status,400);assert.equal((await call(offer,token)).status,200);
 const chunks=Array.from({length:snapshot.manifest.chunks},(_,i)=>({method:'applySnapshotChunk',index:i,chunk:Buffer.from(JSON.stringify(readChunk(snapshot.file,snapshot.manifest,snapshot.levels,i))).toString('base64')}));
 for(const chunk of chunks){const r=await call(chunk,token);assert.equal(r.status,200,await r.text());}
 const ready=await(await call({method:'info'})).json();assert.equal(ready.height,6);assert.equal(Buffer.from(ready.hash,'base64').toString('hex'),snapshot.manifest.root);
 await stop(child);child=await start();token=readApplicationAuth(home);assert.deepEqual(await(await call({method:'info'})).json(),ready);
 assert.equal((await call(offer,token)).status,200);for(const chunk of chunks)assert.equal((await call(chunk,token)).status,200);assert.deepEqual(await(await call({method:'info'})).json(),ready);
 assert.equal((await call(q(7),token)).status,200);await stop(child);child=await start();token=readApplicationAuth(home);assert.equal((await(await call({method:'info'})).json()).height,6);
 assert.equal((await call(q(7),token)).status,200);assert.equal((await call({method:'commit'},token)).status,200);assert.equal((await call(offer,token)).status,400);
 await stop(child);child=await start();assert.equal((await(await call({method:'info'})).json()).height,7);await stop(child);
 fs.renameSync(path.join(home,'application-indexed.sqlite'),path.join(home,'retained.sqlite'));child=launch();const exit=await new Promise(ok=>child.once('exit',ok));assert.notEqual(exit,0);assert(!fs.existsSync(path.join(home,'application-indexed.sqlite')));assert(!fs.existsSync(path.join(home,'application.sqlite')));
 assert.match(fs.readFileSync(path.join(home,'process.log'),'utf8'),/indexed state is missing; cannot fall back/);
});
