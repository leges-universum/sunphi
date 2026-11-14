// Offline V6 -> current-schema preparation. This is NOT an activation command.
// The caller must authenticate expectedRoot independently. Source opens read-only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {hash,canonical,exact,integer} from '../crypto.mjs';
import {auditState} from '../core.mjs';
import {AuthenticatedRecordStore} from './authenticated-record-store.mjs';
import {BoundedNetworkInterpreter,boundedInitialRecords,BOUNDED_DOMAIN} from './bounded-network-interpreter.mjs';
import {auditWalletIndex} from './bounded-wallet-index.mjs';
import {emptySeed,addSettlement} from './bounded-reward-context.mjs';
import {custodyIndex} from './bounded-century-context.mjs';
const SOURCE='DUEBYTE_BOUNDED_NETWORK_V6';
const sorted=entries=>[...entries].sort(([a],[b])=>a<b?-1:a>b?1:0);
const sectionKey=k=>/^meta\/(network|economics)(\/chunk\/(0|[1-9][0-9]*))?$/.test(k);
const historyKey=k=>k==='meta/paymentEvents'||k.startsWith('payment-events/')||k.startsWith('wallet/')||k.startsWith('wallet-reverse/');
function section(records,key){
 const head=records.get(key);assert(head,'missing section');
 if(head.kind==='json'){exact(head,['kind','value']);return head.value;}
 exact(head,['kind','count','digest']);assert.equal(head.kind,'chunks');integer(head.count,1);assert(head.count<=128);
 const chunks=[];for(let i=0;i<head.count;i++){const part=records.get(key+'/chunk/'+i);exact(part,['data']);const b=Buffer.from(part.data,'base64');assert.equal(b.toString('base64'),part.data);assert(b.length<=24000);chunks.push(b);}
 const value=JSON.parse(Buffer.concat(chunks).toString());assert.equal(hash(value),head.digest);return value;
}
function readSource(records,config,height){
 const anchor=records.get('meta/anchor');assert.equal(anchor?.domain,SOURCE,'unsupported source schema');assert.equal(anchor.configHash,hash(config));assert.equal(anchor.issuance,false,'isolated issuance source forbidden');assert.equal(anchor.archive,null,'only the existing fresh chain is supported');
 const state={...section(records,'meta/network'),money:{...section(records,'meta/money'),outputs:{},requests:{},nodes:{}}};
 for(const [key,value]of records){
  const m=/^(outputs|requests|nodes)\/([a-f0-9]{64})$/.exec(key);
  if(m){state.money[m[1]][m[2]]=value;continue;}
  if(/^owners\/[a-f0-9]{64}$/.test(key)||historyKey(key)||['meta/anchor','meta/blockRules','meta/blockHead'].includes(key))continue;
  const s=/^(meta\/(money|network|economics))(?:\/chunk\/(0|[1-9][0-9]*))?$/.exec(key);
  assert(s,'unsupported source namespace');if(s[3]!==undefined){const h=records.get(s[1]);assert(h.kind==='chunks'&&Number(s[3])<h.count,'orphan section chunk');}
 }
 assert.equal(state.height,height,'source height changed');assert.equal(records.get('meta/blockHead').height,height);
 auditState(state,config);auditWalletIndex(records,state.money);
 const seed=emptySeed();if(!state.rewards)for(const r of Object.values(state.money.requests))if(r.status==='SETTLED')addSettlement(seed,r,state);
 assert.deepEqual(section(records,'meta/economics'),{workerIds:Object.keys(state.money.nodes).sort(),seed,custody:custodyIndex(state)},'source economic index');
 return state;
}
export function prepareIndexedUpgrade({source,target,config,expectedRoot,expectedHeight}){
 integer(expectedHeight,1);
 const sourcePath=fs.realpathSync(source),targetPath=path.join(fs.realpathSync(path.dirname(target)),path.basename(target));
 assert.notEqual(sourcePath.toLowerCase(),targetPath.toLowerCase(),'source and target must differ');assert(!fs.existsSync(targetPath),'target must not exist');
 const reader=AuthenticatedRecordStore.readOnly(sourcePath,expectedRoot),records=new Map();let state,sourceMeta;
 try{sourceMeta={...reader.meta};reader.scanAuthenticated((k,v)=>records.set(k,v));state=readSource(records,config,expectedHeight);}finally{reader.close();}
 const stateHash=hash(state),entries=boundedInitialRecords(state,config,stateHash);
 // Rebuilding from terminal requests would lose intermediate payment events and
 // reorder owner history. Keep every authenticated original event and slot.
 for(const key of [...entries.keys()])if(historyKey(key))entries.delete(key);
 for(const [key,value]of records)if(historyKey(key))entries.set(key,value);
 // The genesis anchor remains the genesis anchor. A future activation adapter
 // must authenticate the schema transition separately, without inventing genesis.
 entries.set('meta/anchor',{...records.get('meta/anchor'),domain:BOUNDED_DOMAIN});
 entries.set('meta/blockHead',records.get('meta/blockHead'));
 for(const [key,value]of records)if(key!=='meta/anchor'&&!sectionKey(key))assert.equal(canonical(entries.get(key)),canonical(value),'preserved record differs: '+key);
 const store=AuthenticatedRecordStore.create(targetPath,sorted(entries));let handler;
 try{
  handler=new BoundedNetworkInterpreter(store,config);assert.equal(canonical(handler.snapshotForAudit()),canonical(state),'semantic state changed during upgrade');
  return {domain:'DUEBYTE_INDEXED_UPGRADE_PREPARATION_V1',status:'OFFLINE_PREPARATION_ONLY',network:config.chainId,configHash:hash(config),height:expectedHeight,
   source:{schema:SOURCE,root:expectedRoot,sequence:sourceMeta.sequence,journalHash:sourceMeta.journalHash,records:records.size},
   target:{schema:BOUNDED_DOMAIN,root:handler.root,records:entries.size},stateHash,
   historyDigest:hash(sorted([...records].filter(([k])=>historyKey(k)))),preservesBalances:true,preservesObligations:true,preservesWalletHistory:true,
   activationAuthorized:false,productionInstallable:false,issuance:false};
 }finally{if(handler)handler.close();else store.close();}
}
