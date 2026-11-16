// Isolated clean-genesis preparation. No old state, balances or archive imports.
import fs from 'node:fs';import assert from 'node:assert/strict';
import {hash,exact,integer} from '../crypto.mjs';
import {DOMAIN,policyId} from '../payment-model.mjs';
import {PROFILE,origin,validateConfig} from '../core.mjs';
import {BoundedNetworkInterpreter} from './bounded-network-interpreter.mjs';
import {BoundedBlockStore} from './bounded-block-store.mjs';
import {EMPTY} from './authenticated-record-store.mjs';
import {FIXED_BLOCK_TIMING} from '../fixed-block-timing.mjs';
import {UTC_OBLIGATIONS} from '../obligation-clock.mjs';

export function cleanConfig({chainId,time,control,previousChainId}){
 assert(previousChainId&&chainId!==previousChainId,'New chain identity required');integer(time,1);
 const config={profile:PROFILE,chainId,trialOnly:true,obligationClock:UTC_OBLIGATIONS,initial:{domain:DOMAIN,policy:policyId,height:0,epoch:0,time,supply:'0',outputs:{},requests:{},nodes:{},fees:'0'},control:structuredClone(control)};
 validateConfig(config);return config;
}
export function assertCleanConfig(config){validateConfig(config);const m=config.initial;
 assert.equal(config.obligationClock,UTC_OBLIGATIONS,'Fresh candidate requires explicit UTC obligations');
 exact(m,['domain','policy','height','epoch','time','supply','outputs','requests','nodes','fees']);
 assert.equal(m.height,0);assert.equal(m.epoch,0);assert.equal(m.supply,'0');assert.equal(m.fees,'0');
 for(const key of ['outputs','requests','nodes'])assert.deepEqual(m[key],{},'Old balances or obligations are forbidden');
}
export function createFreshChain(file,config){assertCleanConfig(config);assert(!fs.existsSync(file),'Fresh database required');const initial=origin(config),handler=BoundedNetworkInterpreter.create(file,initial,config,hash(initial));
 const manifest={domain:'DUEBYTE_FRESH_GENESIS_V2',network:config.chainId,configHash:hash(config),stateHash:hash(initial),root:handler.root,height:0,issuance:false,imports:false,timing:{...FIXED_BLOCK_TIMING}};
 return {handler,manifest};
}
export function verifyFreshManifest(config,manifest,pinnedManifestHash){
 assertCleanConfig(config);assert.equal(hash(manifest),pinnedManifestHash,'Genesis manifest pin');exact(manifest,['domain','network','configHash','stateHash','root','height','issuance','imports','timing']);
 assert.equal(manifest.domain,'DUEBYTE_FRESH_GENESIS_V2');assert.deepEqual(manifest.timing,FIXED_BLOCK_TIMING);assert.equal(manifest.network,config.chainId);assert.equal(manifest.configHash,hash(config));assert.equal(manifest.stateHash,hash(origin(config)));assert.equal(manifest.height,0);assert.equal(manifest.issuance,false);assert.equal(manifest.imports,false);
 assert.match(manifest.root,/^[a-f0-9]{64}$/);return manifest;
}
export function openFreshChain(file,config,manifest,pinnedManifestHash,expectedRoot){
 verifyFreshManifest(config,manifest,pinnedManifestHash);
 const handler=BoundedNetworkInterpreter.open(file,config,expectedRoot);
 try{const anchor=handler.store.proof('meta/anchor',handler.root).value;assert.equal(anchor.archive,null,'Old archive import forbidden');assert.equal(anchor.height,0);assert.equal(anchor.sourceStateHash,manifest.stateHash);assert.equal(anchor.issuance,false);
 let parent=manifest.root,sequence=0,previous=EMPTY;
 for(const row of handler.store.db.prepare('SELECT * FROM journal ORDER BY sequence').iterate()){
  const body=JSON.parse(row.body);assert.equal(row.sequence,++sequence);assert.equal(body.sequence,sequence);assert.equal(row.parent,parent);assert.equal(body.parent,parent);assert.equal(row.root,body.root);assert.equal(row.digest,hash(body));
  assert.equal(body.previousJournal,previous);assert.equal(body.event.height,sequence);assert.equal(body.event.filter,false);parent=row.root;previous=row.digest;
 }
 assert.equal(parent,handler.root);assert.equal(handler.networkHeader().height,sequence);assert.equal(handler.store.meta.sequence,sequence);assert.equal(handler.store.meta.journalHash,previous);
 handler.snapshotForAudit();return new BoundedBlockStore(handler);
 }catch(e){handler.close();throw e;}
}
