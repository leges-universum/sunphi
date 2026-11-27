import {createServer} from 'node:http';
import {readFileSync,existsSync,writeFileSync,renameSync,unlinkSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {Store} from './store.mjs';
import {stateHash,validateConfig,block,applyTx,workReceipt} from './core.mjs';
import {hash,canonical,exact} from './crypto.mjs';
import {verifyCheckpoint} from './checkpoint.mjs';
import {validatorUpdates,activate} from './authority.mjs';
import {checkCheckpointState} from './checkpoint-state.mjs';
import {acceptSnapshot} from './bootstrap-snapshot.mjs';
import {snapshotChunk} from './snapshot-chunk.mjs';
import {reserveSummary} from './network-reserves.mjs';
import {protectionSummary} from './protection-reserve.mjs';
import {createApplicationAuth,applicationAuthorized,privateApplicationMethods} from './application-auth.mjs';
import {PRIVATE_APPLICATION_BYTES} from './consensus-context.mjs';
import {applicationRuntime} from './runtime-compatibility.mjs';
import {openIndexedSchemaApplication} from './research/indexed-schema-upgrade.mjs';
import {startJournalMaintenance} from './research/journal-maintenance.mjs';
import {startArchiveMaintenance,ARCHIVE_STORAGE} from './research/archive-maintenance.mjs';
import {ARCHIVE_READ,ARCHIVE_ROW,archiveChunk,configuredArchiveSources} from './research/archive-transport.mjs';
import {cleanArchiveStaging} from './research/archive-staging.mjs';
import {acceptedSnapshotExpired} from './research/snapshot-expiry.mjs';
import {ARCHIVE_SNAPSHOTS,ARCHIVE_SNAPSHOT_CHUNK,archiveSnapshotQuery} from './research/archive-snapshot-route.mjs';
import {ArchivePreparationSession} from './research/archive-preflight-task.mjs';
import {bootstrapRecoveryAnchor} from './research/bootstrap-recovery.mjs';
import {verifyIndexedSchemaActivation,openGuardedIndexedSchemaBoundary} from './research/indexed-schema-readiness.mjs';
import {acquireStateAccess,assertStateInstallationComplete} from './state-access.mjs';
import {BootstrapProgress} from './bootstrap-progress.mjs';
import {FundingQueue,FUNDING_REQUEST,fundingState} from './funding-service.mjs';
import {ServerEnrollment} from './server-validator-enrollment.mjs';
import {enrollmentRoute} from './validator-enrollment.mjs';
import {queryBounded} from './research/bounded-query.mjs';
import {prepareOperatorLink,signOperatorLink} from './operator-link.mjs';
const [directory,portText]=process.argv.slice(2),home=resolve(directory),port=Number(portText);assert(Number.isInteger(port)&&port>=1024&&port<=65535);
const releaseStateAccess=acquireStateAccess(home);
process.once('exit',releaseStateAccess);
assertStateInstallationComplete(home);
cleanArchiveStaging(join(home,'application-indexed.sqlite'));
const bootstrapProgress=new BootstrapProgress(home);
const read=f=>JSON.parse(readFileSync(join(home,f),'utf8'));
const config=read('app-config.json'),policy=read('trust-policy.json');
const freshSettings=existsSync(join(home,'fresh-activation.json'))?read('fresh-activation.json'):null;
const schemaSettings=existsSync(join(home,'indexed-schema-activation.json'))?read('indexed-schema-activation.json'):null;
assert(Number(!!freshSettings)+Number(!!schemaSettings)+Number(existsSync(join(home,'indexed-activation.json')))<=1,'ambiguous state authority');
const runtime=await applicationRuntime(resolve(import.meta.dirname,'../..'),config,freshSettings);
const {openBoundedApplication,BoundedApplication,BoundedNetworkInterpreter,createBoundedApi,IndexedCheckpointRepository,observeIndexedCheckpoint,acceptIndexedSnapshot,IndexedSnapshotReceiver,verifyChunk,checkIndexedCheckpoint,verifyBoundedTransitionTerms,openFreshApplication,freshRootTerms}=runtime;
const boundaryFile=existsSync(join(home,'indexed-schema-boundary.json')),planFile=existsSync(join(home,'indexed-schema-prepare.json'));
assert(boundaryFile===planFile,'schema boundary requires its independently pinned local preparation plan');
const preparation=planFile?read('indexed-schema-prepare.json'):null;
if(preparation){
 assert(boundaryFile,'missing schema boundary');
 if(schemaSettings){assert.equal(hash(preparation.certificate),hash(schemaSettings.certificate));assert.equal(hash(preparation.trustedBoundary),hash(schemaSettings.trustedBoundary));}
 else assert(freshSettings&&runtime.kind==='v6','boundary guard requires the original V6 interpreter');
}
if(schemaSettings){
 const keyFile='config/priv_validator_key.json',publicKey=existsSync(join(home,keyFile))?Buffer.from(read(keyFile).pub_key.value,'base64').toString('base64url'):null;
 const isValidator=(existsSync(join(home,'run-settings.json'))&&read('run-settings.json').isValidator===true)||schemaSettings.trustedBoundary.validators.some(v=>v.key===publicKey);
 verifyIndexedSchemaActivation(schemaSettings,config,{isValidator});
 assert(!existsSync(join(home,'application.sqlite')),'schema upgrade cannot adopt legacy state');
}
if(freshSettings){freshRootTerms(config,freshSettings);assert(!existsSync(join(home,'application.sqlite')),'fresh home cannot adopt legacy state');}
const store=freshSettings||schemaSettings?null:new Store(join(home,'application.sqlite'),config);
const work=existsSync(join(home,'work-key.json'))?read('work-key.json'):null;
const applicationToken=createApplicationAuth(home);
// Explicit clean-genesis provisioning and signed legacy migration are separate.
// With neither file, existing deployment behaviour is preserved.
const indexedSettings=schemaSettings??freshSettings??(existsSync(join(home,'indexed-activation.json'))?read('indexed-activation.json'):null);
let indexed=null,indexedApi=null,indexedCheckpoints=null,indexedReceiver=null,indexedInstalling=false,stopJournalMaintenance=()=>{};
let archivePreparation=null,indexedChunkIndexes=new Set();
let fundingQueue=null;
let validatorEnrollment;
function enrollment(){
 assert(indexed&&work&&!indexedInstalling&&!bootstrapPending,'Validator service is synchronizing.');
 return validatorEnrollment??=new ServerEnrollment(home,config,work,indexed.handler);
}
let ruleWindow=0,ruleRequests=0;
function funding(){assert(indexed&&work&&!indexedInstalling&&!bootstrapPending,'Funding service is not ready');
 if(!fundingQueue)fundingQueue=new FundingQueue(join(home,'funding-requests.sqlite'),{configHash:hash(config),key:work,view:b=>fundingState(indexed.handler,work.node,b)});return fundingQueue;
}
const bootstrapPendingFile=join(home,'indexed-bootstrap-pending.json');
let bootstrapPending=existsSync(bootstrapPendingFile)?read('indexed-bootstrap-pending.json'):null,indexedReplay=null;
function clearBootstrapPending(){if(bootstrapPending){unlinkSync(bootstrapPendingFile);bootstrapPending=null;}indexedReplay=null;}
function rememberBootstrap(manifest){
 const record={manifestHash:hash(manifest),height:manifest.height,root:manifest.root},temp=bootstrapPendingFile+'.next';
 const fd=openSync(temp,'w',0o600);try{writeFileSync(fd,JSON.stringify(record));fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,bootstrapPendingFile);
 if(process.platform!=='win32'){const dir=openSync(home,'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
 bootstrapPending=record;
}
const indexedSource=indexedSettings&&!freshSettings&&!schemaSettings?(store.state.height===0&&indexedSettings.source?indexedSettings.source:store.state):null;
const bootstrapClient=schemaSettings?schemaSettings.bootstrap:freshSettings?freshSettings.bootstrap===true:!!indexedSettings?.source;
const freshInstalled=join(home,'fresh-state-installed.json');
const schemaInstalled=join(home,'indexed-schema-installed.json');
function connectIndexed(installed=null){
 indexed=schemaSettings?openIndexedSchemaApplication(join(home,'application-indexed.sqlite'),config,schemaSettings.certificate,schemaSettings.trustedBoundary):freshSettings?openFreshApplication(join(home,'application-indexed.sqlite'),config,freshSettings):installed?new BoundedApplication(BoundedNetworkInterpreter.open(join(home,'application-indexed.sqlite'),config,installed.root),indexedSettings.certificate.body):openBoundedApplication(join(home,'application-indexed.sqlite'),indexedSource,config,indexedSettings.certificate);
 if(preparation&&!schemaSettings)indexed=openGuardedIndexedSchemaBoundary(home,indexed,config,preparation.certificate,preparation.trustedBoundary);
 if(schemaSettings){const certificateHash=hash(schemaSettings.certificate);if(existsSync(schemaInstalled))assert.equal(read('indexed-schema-installed.json').certificateHash,certificateHash,'installed upgrade authority changed');else{const fd=openSync(schemaInstalled,'wx',0o600);try{writeFileSync(fd,JSON.stringify({certificateHash}));fsyncSync(fd);}finally{closeSync(fd);}}}
 if(freshSettings&&!existsSync(freshInstalled)){const fd=openSync(freshInstalled,'wx',0o600);try{writeFileSync(fd,JSON.stringify({manifestHash:freshSettings.manifestHash}));fsyncSync(fd);}finally{closeSync(fd);}}
 indexedCheckpoints=new IndexedCheckpointRepository(home,indexed,policy);
 indexedApi=createBoundedApi(indexed.handler,{rootReader:root=>indexedCheckpoints.readRoot(root)});indexedApi.listen(indexedSettings.readPort,'127.0.0.1');
 const releaseFile=resolve(import.meta.dirname,'../../release-config.json'),release=existsSync(releaseFile)?JSON.parse(readFileSync(releaseFile)):null,archiveEnabled=process.platform==='linux'&&release?.edition==='server'&&release?.storageFormat===ARCHIVE_STORAGE;
 stopJournalMaintenance=archiveEnabled?startArchiveMaintenance(indexed.handler.store,{enabled:true,onError:error=>console.error('History archival paused; committed history retained: '+error.message)}):startJournalMaintenance(indexed.handler.store,{onError:error=>console.error('History compaction paused; history retained: '+error.message)});
}
if(indexedSettings){
 assert(Number.isInteger(indexedSettings.readPort)&&indexedSettings.readPort>=1024&&indexedSettings.readPort<=65535&&indexedSettings.readPort!==port,'indexed read port');
 if(!freshSettings&&!schemaSettings)verifyBoundedTransitionTerms(indexedSettings.certificate,indexedSource,config,hash(indexedSource));
 if(existsSync(join(home,'application-indexed.sqlite')))connectIndexed();
 else assert(schemaSettings?bootstrapClient&&!existsSync(schemaInstalled):freshSettings?bootstrapClient&&!existsSync(freshInstalled):store.state.height===0&&indexedSettings.source,'indexed state is missing; cannot fall back');
 if(indexed&&bootstrapPending){
  assert(bootstrapClient&&(!store||store.state.height===0),'bootstrap marker on validator');
  if(indexed.blocks.header.height>bootstrapPending.height)clearBootstrapPending();
  else{assert.equal(indexed.blocks.header.height,bootstrapPending.height);assert.equal(indexed.handler.root,bootstrapPending.root,'pending bootstrap root');}
 }
}
let offered=null;const b64=h=>Buffer.from(h,'hex').toString('base64');
function publication(){if(!existsSync(join(home,'checkpoint.json')))return null;const doc=read('checkpoint.json');verifyCheckpoint(doc,policy);return doc;}
function dispatch(q){
 if(q.method==='operatorPrepare'||q.method==='operatorConsent'){
  exact(q,['method','profile','automaticLegalUpdates','revoke',...(q.method==='operatorConsent'?['expectedHash']:[])]);
  assert(indexed&&work&&!indexedInstalling&&!bootstrapPending,'Node is not ready');
  const view=queryBounded(indexed.handler,{type:'operator-reward',id:work.node},indexed.handler.root).result.data;
  const review=prepareOperatorLink({profile:q.profile,view,config,automaticLegalUpdates:q.automaticLegalUpdates,revoke:q.revoke});
  assert.equal(review.management,work.publicKey,'Node management key unavailable');
  if(q.method==='operatorPrepare')return {review,hash:hash(review)};
  assert.equal(hash(review),q.expectedHash,'Registration terms changed; review again');
  return {packet:signOperatorLink(review,work,config),applicationId:review.applicationId};
 }
 if(q.method==='bootstrapRecovery'){
  assert(indexed&&bootstrapPending&&bootstrapClient&&!indexedInstalling,'no published bootstrap to recover');
  assert.equal(read('run-settings.json').isValidator,false,'validator recovery cannot reset consensus metadata');
  const own=Buffer.from(read('config/priv_validator_key.json').pub_key.value,'base64').toString('base64url');
  assert(!(indexed.blocks.header.authority?.validators??config.control.validators).some(v=>v.key===own),'voter cannot use bootstrap recovery');
  assert(!indexed.blocks.header.authority?.archiveVoting?.leases.some(v=>v.key===own),'archive voter cannot use bootstrap recovery');
  return bootstrapRecoveryAnchor({pending:bootstrapPending,header:indexed.blocks.header,root:indexed.handler.root,config,policy,previous:read('indexed-checkpoint.json').document,sources:configuredArchiveSources(home)});
 }
 if(q.method==='prepareArchive'||q.method==='archivePreparation'){
  exact(q,['method']);const file=resolve(import.meta.dirname,'../../release-config.json'),release=existsSync(file)?JSON.parse(readFileSync(file)):null;
  if(indexed||!bootstrapClient||runtime.kind!=='current'||release?.edition!=='server'||!(freshSettings||schemaSettings))return {state:'ready'};
  if(q.method==='prepareArchive'&&!archivePreparation){
   archivePreparation=new ArchivePreparationSession(home,{config,policy,rpcServers:configuredArchiveSources(home),fresh:freshSettings,schemaUpgrade:schemaSettings},{onProgress:p=>bootstrapProgress.archive(p)});
   void archivePreparation.prepare().catch(()=>{});
  }
  assert(archivePreparation,'archive preparation not started');if(archivePreparation.failure)throw archivePreparation.failure;return {state:archivePreparation.state};
 }
 if(indexedSettings){
  if(q.method==='offerSnapshot'){
   assert(!archivePreparation?.pending,'archive preparation still owns the receiver');
   assert(!indexedInstalling,'bootstrap verification is in progress');const previous=existsSync(join(home,'indexed-checkpoint.json'))?read('indexed-checkpoint.json').document:existsSync(join(home,'checkpoint.json'))?read('checkpoint.json'):null;
   const metadata=acceptIndexedSnapshot(q,previous,policy,config,store?.state.height??0);
   if(indexed){
    assert(bootstrapPending&&bootstrapClient,'bootstrap must not replace existing state');
    assert.equal(hash(metadata.manifest),bootstrapPending.manifestHash,'only the installed bootstrap may be acknowledged');
    assert.equal(indexed.blocks.header.height,bootstrapPending.height);assert.equal(indexed.handler.root,bootstrapPending.root);
    indexedReplay=metadata;return {accept:true};
   }
   const archiveSources=metadata.manifest.format===6?configuredArchiveSources(home):[];
   indexedReceiver=new IndexedSnapshotReceiver({directory:join(home,'indexed-incoming'),target:join(home,'application-indexed.sqlite'),metadata,policy,config,source:indexedSource,certificate:schemaSettings?null:indexedSettings.certificate,fresh:freshSettings,schemaUpgrade:schemaSettings?{certificate:schemaSettings.certificate,trustedBoundary:schemaSettings.trustedBoundary}:null,previous,archiveSources});indexedChunkIndexes=new Set();bootstrapProgress.start(metadata.manifest);return {accept:true};
  }
  if(q.method==='applySnapshotChunk'){
   if(indexedReplay){
    assert(indexed&&bootstrapPending&&!indexedInstalling);assert.equal(indexed.blocks.header.height,bootstrapPending.height);assert.equal(indexed.handler.root,bootstrapPending.root);
    checkIndexedCheckpoint(indexedReplay.document,indexedReplay.manifest,policy,config);
    assert(typeof q.chunk==='string'&&q.chunk.length<=1500000);const chunk=JSON.parse(Buffer.from(q.chunk,'base64'));assert.equal(chunk.index,q.index);verifyChunk(indexedReplay.manifest,chunk);return {accept:true};
   }
   assert(!indexed&&!indexedInstalling&&indexedReceiver,'no pending indexed bootstrap');
   if(acceptedSnapshotExpired(indexedReceiver.metadata)){indexedReceiver=null;bootstrapProgress.phase('waiting-current-snapshot');return {snapshotResult:'reject-snapshot'};}
   assert(typeof q.chunk==='string'&&q.chunk.length<=1500000);const c=JSON.parse(Buffer.from(q.chunk,'base64'));assert.equal(c.index,q.index);try{indexedReceiver.receive(c);}catch(error){bootstrapProgress.phase('failed');console.error('Snapshot chunk '+c.index+' rejected: '+String(error.message).replace(/[\r\n]/g,' ').slice(0,400));throw error;}
   indexedChunkIndexes.add(c.index);bootstrapProgress.received(c.index);
   // Preflight/restart may already have every chunk on disk. Complete the
   // CURRENT Comet exchange before publication; cached bytes are not receipts.
   if(indexedChunkIndexes.size===indexedReceiver.metadata.manifest.chunks&&indexedReceiver.complete()){indexedInstalling=true;bootstrapProgress.phase('verifying');const install=archivePreparation?(options=>archivePreparation.install(indexedReceiver,options)):(options=>indexedReceiver.installAsync(options));return install({beforePublish:()=>{const {document,manifest}=indexedReceiver.metadata,temp=join(home,'indexed-checkpoint.pending.json');rememberBootstrap(manifest);writeFileSync(temp,JSON.stringify({document,manifest,directory:null}),{mode:0o600});renameSync(temp,join(home,'indexed-checkpoint.json'));}}).then(async result=>{await archivePreparation?.close();archivePreparation=null;connectIndexed(result);indexedReceiver=null;bootstrapProgress.phase('complete');return {accept:true};}).catch(error=>{if(!existsSync(join(home,'application-indexed.sqlite'))&&acceptedSnapshotExpired(indexedReceiver?.metadata)){indexedReceiver=null;bootstrapProgress.phase('waiting-current-snapshot');return {snapshotResult:'reject-snapshot'};}bootstrapProgress.phase('failed');throw error;}).finally(()=>{indexedInstalling=false;});}return {accept:true};
  }
  if(q.method==='listSnapshots')return indexedCheckpoints?.list()??{snapshots:[]};
  if(q.method==='loadSnapshotChunk'){assert(indexedCheckpoints);return indexedCheckpoints.load(q);}
  if(q.method==='prepareIndexedSnapshot'){assert(indexedCheckpoints);return indexedCheckpoints.prepare();}
  if(q.method==='inspectIndexedCheckpoint'){assert(indexed);observeIndexedCheckpoint(indexed,q.body,q.manifest);return {renewals:indexed.blocks.header.authority?.renewals??[]};}
  if(q.method==='indexedPolicy'){assert(indexed);return {renewals:indexed.blocks.header.authority?.renewals??[]};}
  if(q.method==='indexedCheckpoint'){assert(indexedCheckpoints);const r=indexedCheckpoints.current;return {record:r?{document:r.document,manifest:r.manifest}:null,served:indexedCheckpoints.publication()};}
  if(q.method==='installCheckpoint'){assert(indexedCheckpoints);return indexedCheckpoints.install(q.document,q.manifest);}
  if(q.method==='publicCheckpoint'&&indexedCheckpoints?.current)return {value:indexedCheckpoints.publication()};
  if(q.method==='fundingList'){exact(q,['method']);return {node:work?.node??null,requests:funding().list()};}
  if(q.method==='publicWork'&&q.key.includes(enrollmentRoute)){
   assert(Buffer.byteLength(q.key)<=4096);
   const second=Math.floor(Date.now()/1000);
   if(ruleWindow!==second){ruleWindow=second;ruleRequests=0;}
   assert(++ruleRequests<=8,'Validator service is busy.');
   return {value:enrollment().request(JSON.parse(q.key))};
  }
  if(q.method==='publicWork'&&q.key.includes('DUEBYTE_SERVER_RULE_')){
   assert(indexed&&work&&!indexedInstalling&&!bootstrapPending&&Buffer.byteLength(q.key)<=4096);
   const second=Math.floor(Date.now()/1000);
   if(ruleWindow!==second){ruleWindow=second;ruleRequests=0;}
   assert(++ruleRequests<=8,'Server voting is busy');
   const request=JSON.parse(q.key);
   const meta=queryBounded(indexed.handler,{type:'wallet-meta',id:null},indexed.handler.root).result;
   assert(!meta.isolatedIssuance&&Math.abs(meta.data.money.time-second)<120,'Wait for server synchronization');
   if(Object.hasOwn(request,'cutoverStart')){
    const root=indexed.handler.root;
    return Promise.all([import('./bonded-cutover.mjs'),import('./local-validator-key.mjs')]).then(([{signCutoverRequest},{validatorKey}])=>({value:signCutoverRequest(request,{state:meta.data.network,network:config.chainId,worker:work,
     payouts:queryBounded(indexed.handler,{type:'reward-account',id:work.node},root).result.data?.payouts,
     get:k=>indexed.handler.store.proof(k,root).value,key:()=>validatorKey(home)})}));
   }
   return import('./server-rule-vote.mjs').then(({localRuleVote})=>({
    value:localRuleVote(request,{home,state:{...meta.data.network,money:meta.data.money},network:config.chainId,worker:work,
     payouts:queryBounded(indexed.handler,{type:'reward-account',id:work.node},indexed.handler.root).result.data?.payouts})
   }));
  }
  if(q.method==='fundingDecide'){exact(q,['method','id','decision']);return funding().decide({id:q.id,decision:q.decision});}
  if(q.method==='publicWork'){const request=JSON.parse(q.key);if([ARCHIVE_SNAPSHOTS,ARCHIVE_SNAPSHOT_CHUNK].includes(request?.operation)){assert(indexed&&!indexedInstalling&&!bootstrapPending&&Buffer.byteLength(q.key)<=1024);return {value:archiveSnapshotQuery(indexedCheckpoints,request)};}if([ARCHIVE_READ,ARCHIVE_ROW].includes(request?.operation)){assert(indexed&&!indexedInstalling&&Buffer.byteLength(q.key)<=1024);return {value:archiveChunk(indexed.handler.store,request)};}if(request?.operation===FUNDING_REQUEST){assert(Buffer.byteLength(q.key)<=8192);return {value:funding().request(request)};}}
  if(indexed){const result=indexed.dispatch(q,{work,publication});if(q.method==='commit'&&bootstrapPending&&indexed.blocks.header.height>bootstrapPending.height)clearBootstrapPending();
   if(q.method==='commit'&&work&&!bootstrapPending&&!indexedInstalling&&(validatorEnrollment||existsSync(join(home,'validator-enrollment.sqlite')))){
    // Maintenance errors must never interrupt consensus application commits.
    try{enrollment().tick();}catch(e){console.warn('Validator enrollment unavailable:',e.message);}
   }
   return result;}
  assert(['info','init','runtime','status','publicCheckpoint'].includes(q.method),'indexed bootstrap incomplete');
  if(freshSettings||schemaSettings){
   if(q.method==='init'){assert.equal(q.chain,config.chainId);assert.equal(hash(JSON.parse(Buffer.from(q.state,'base64'))),validateConfig(config));}
   if(q.method==='publicCheckpoint')return {value:publication()};
   if(q.method==='runtime')return {value:{height:0,memory:process.memoryUsage(),cpu:process.cpuUsage()}};
   return {height:0,hash:b64(schemaSettings?schemaSettings.trustedBoundary.genesisRoot:freshSettings.manifest.root),...(q.method==='status'?{value:{chain:config.chainId,height:0,indexed:true,bootstrapPending:true}}:{})};
  }
 }
 const s=store.state,root=stateHash(s,config);const response={height:s.height,hash:b64(root)};
 const txs=(q.txs??[]).map(x=>Buffer.from(x,'base64'));
 const req={height:q.height,blockHash:q.hash?Buffer.from(q.hash,'base64').toString('hex'):'0'.repeat(64),time:q.time,txs};
 switch(q.method){
 case 'info':return response;
 case 'init':assert.equal(q.chain,config.chainId);assert.equal(hash(JSON.parse(Buffer.from(q.state,'base64'))),validateConfig(config));return response;
 case 'check':try{if(s.money.liability||s.authority?.nodeRewards||s.authority?.spendProtection)block(s,config,{height:s.height+1,blockHash:'0'.repeat(64),time:s.money.time,txs:[txs[0]]});else applyTx({...s,height:s.height+1,...(s.authority?{authority:activate(s.authority,s.height+1)}:{})},txs[0],config,s.money.time);return {code:0};}catch{return {code:1};}
 case 'prepare':{const out=block(s,config,{...req,txs:txs.slice(0,64)},true);return {txs:out.accepted.map(x=>x.toString('base64'))};}
 case 'process':try{block(s,config,req);return {accept:true};}catch{return {accept:false};}
 case 'finalize':{const out=store.finalize(req);return {hash:b64(stateHash(out.state,config)),codes:out.codes,updates:validatorUpdates(out.state,req.height)};}
 case 'commit':store.commit();return {};
 case 'status':return {...response,value:{profile:config.profile,chain:config.chainId,height:s.height,appHash:root,money:s.money,...(s.authority?{authority:s.authority}:{}),...(s.rewards?{rewards:s.rewards}:{}),...(s.networkReserves?{reserves:reserveSummary(s)}:{}),...(s.money.liability?{protection:protectionSummary(s)}:{}),trialOnly:true}};
 case 'snapshot':{const at=q.key?Number(q.key):s.height;const state=store.snapshot(at);return {height:at,value:{state,appHash:stateHash(state,config)}};}
 case 'work':assert(work,'no worker');return {value:workReceipt(s,q.pid,q.index,work.node,work)};
 case 'publicWork':{assert(work,'no worker');const r=JSON.parse(q.key);assert.equal(Object.keys(r).sort().join(','),'index,pid');return {value:workReceipt(s,r.pid,r.index,work.node,work)};}
 case 'runtime':return {value:{memory:process.memoryUsage(),cpu:process.cpuUsage(),height:s.height}};
 case 'publicCheckpoint':return {value:publication()};
 case 'installCheckpoint':{const previous=existsSync(join(home,'checkpoint.json'))?read('checkpoint.json'):null;verifyCheckpoint(q.document,policy,{previous,allowGap:true});const b=q.document.body;assert.equal(store.snapshot(b.height).blockHash,b.blockHash,'checkpoint must be in this node committed history');checkCheckpointState(q.document,store.snapshot(b.appHeight),config,policy);const temp=join(home,'checkpoint.pending.json');writeFileSync(temp,JSON.stringify(q.document),{mode:0o600});renameSync(temp,join(home,'checkpoint.json'));return {installed:b.sequence};}
 case 'listSnapshots':{let d;try{d=publication();}catch{return {snapshots:[]};}if(!d)return {snapshots:[]};const state=store.snapshot(d.body.appHeight);assert.equal(hash(state),d.body.snapshotHash);return {snapshots:[{height:d.body.appHeight,format:1,chunks:1,hash:b64(d.body.snapshotHash),metadata:Buffer.from(JSON.stringify(d)).toString('base64')}]};}
 case 'loadSnapshotChunk':{const d=publication();assert(d);return snapshotChunk(q,d.body.appHeight,height=>store.snapshot(height));}
 case 'offerSnapshot':{const d=read('checkpoint.json');offered=acceptSnapshot(q,d,policy,config,store.state.height);return {accept:true};}
 case 'applySnapshotChunk':{assert(offered&&q.index===0);const bytes=Buffer.from(q.chunk,'base64');assert(bytes.length<=1048576);const state=JSON.parse(bytes);checkCheckpointState(offered,state,config,policy);store.restore(state);const temp=join(home,'checkpoint.bootstrap.json');writeFileSync(temp,JSON.stringify(offered),{mode:0o600});renameSync(temp,join(home,'checkpoint.json'));offered=null;return {accept:true};}
 default:throw Error('unknown method');
 }
}
const server=createServer(async(req,res)=>{if(req.method!=='POST'||req.url!=='/'||req.headers.origin){res.writeHead(403);res.end();return;}try{const authorized=applicationAuthorized(req.headers['x-duebyte-app-auth'],applicationToken),limit=authorized?PRIVATE_APPLICATION_BYTES:2*1048576;let size=0,parts=[];for await(const b of req){size+=b.length;if(size>limit)throw Error('request size');parts.push(b);}const q=JSON.parse(Buffer.concat(parts));if(privateApplicationMethods.has(q.method)&&!authorized){res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'private application channel required'}));return;}const result=await dispatch(q);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));}catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}});
server.requestTimeout=10000;server.headersTimeout=5000;server.listen(port,'127.0.0.1',()=>console.log('Duebyte public trial app ready '+port));
process.on('SIGTERM',async()=>{stopJournalMaintenance();await archivePreparation?.close();server.close(()=>{const close=()=>{fundingQueue?.close();indexed?.close();store?.close();process.exit(0);};if(indexedApi)indexedApi.close(close);else close();});});
