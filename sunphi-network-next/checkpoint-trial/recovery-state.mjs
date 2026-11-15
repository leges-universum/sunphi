// Offline inspection only. A valid old backup is not authority to restart a signer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {hash} from './crypto.mjs';
import {acquireStateAccess,assertStateInstallationComplete} from './state-access.mjs';
import {applicationRuntime} from './runtime-compatibility.mjs';
import {openIndexedSchemaApplication} from './research/indexed-schema-upgrade.mjs';
import {verifyIndexedSchemaActivation} from './research/indexed-schema-readiness.mjs';

export async function withStoppedRecoveryState(home,{packageRoot,expected}={},visit=()=>{}){
 assert(!fs.existsSync(path.join(home,'supervisor.lock')),'signer must be stopped');
 const unlock=acquireStateAccess(home);let app;
 const read=name=>JSON.parse(fs.readFileSync(path.join(home,name)));
 try{
  assertStateInstallationComplete(home);
  const config=read('app-config.json'),schema=fs.existsSync(path.join(home,'indexed-schema-activation.json')),fresh=fs.existsSync(path.join(home,'fresh-activation.json'));
  assert(schema!==fresh,'exactly one recovery authority required');
  assert(!fs.existsSync(path.join(home,'indexed-activation.json')),'ambiguous recovery authority');
  assert(!fs.existsSync(path.join(home,'application.sqlite')),'new-format recovery cannot adopt legacy state');
  assert(!fs.existsSync(path.join(home,'indexed-bootstrap-pending.json')),'snapshot installation is incomplete');
  const settings=read(schema?'indexed-schema-activation.json':'fresh-activation.json'),file=path.join(home,'application-indexed.sqlite');
  const plan=fs.existsSync(path.join(home,'indexed-schema-prepare.json')),boundary=fs.existsSync(path.join(home,'indexed-schema-boundary.json'));
  assert.equal(plan,boundary,'schema boundary requires its independently pinned local preparation plan');
  if(schema&&plan){const prepared=read('indexed-schema-prepare.json');assert.equal(hash(prepared.certificate),hash(settings.certificate));assert.equal(hash(prepared.trustedBoundary),hash(settings.trustedBoundary));}
  if(schema){
   const keyFile='config/priv_validator_key.json',publicKey=fs.existsSync(path.join(home,keyFile))?Buffer.from(read(keyFile).pub_key.value,'base64').toString('base64url'):null;
   const isValidator=(fs.existsSync(path.join(home,'run-settings.json'))&&read('run-settings.json').isValidator===true)||settings.trustedBoundary.validators.some(v=>v.key===publicKey);
   verifyIndexedSchemaActivation(settings,config,{isValidator});
   app=openIndexedSchemaApplication(file,config,settings.certificate,settings.trustedBoundary,{auditJournal:true});
  }else{
   const runtime=await applicationRuntime(packageRoot,config,settings);
   app=runtime.openFreshApplication(file,config,settings,{auditJournal:true});
  }
  app.handler.store.scanAuthenticated(()=>{});
  const state=app.handler.snapshotForAudit(),files=['data/priv_validator_state.json','config/priv_validator_key.json','config/node_key.json'];
  const present=files.filter(n=>fs.existsSync(path.join(home,n)));
  const declaredSigner=fs.existsSync(path.join(home,'run-settings.json'))&&read('run-settings.json').isValidator===true;
  if(present.length||declaredSigner)assert.equal(present.length,files.length,'incomplete native signer recovery material');
  const identities=Object.fromEntries(present.map(n=>[n,hash(read(n))]));
  const result={format:schema?'indexed-schema':'fresh-genesis',network:config.chainId,authorityHash:hash({config,settings}),root:app.handler.root,height:app.blocks.header.height,stateHash:hash(state),supply:state.money.supply,identities};
  if(expected)assert.deepEqual(result,expected,'recovered state differs from independently retained backup receipt');
  app.close();app=null;
  // Keep OS ownership throughout archive creation, including after DB close.
  await visit(result);
  return result;
 }finally{app?.close();unlock();}
}
