// A standby publisher has no signing keys. Every publication still needs the
// independent attester quorum and verified consensus ancestry.
import fs from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {cycle,checkpointDelay,refreshIndexedCadence,verifyPublisherAnchor} from './checkpoint-coordinator.mjs';
import {indexedRequest,adoptIndexedCheckpoint} from './checkpoint-operator.mjs';
import {hash} from './crypto.mjs';
import {VerifiedClient,rpc,snapshot} from './client.mjs';
import {verifyCheckpoint} from './checkpoint.mjs';
import {recoverPath} from './recovery.mjs';
import {checkCheckpointState} from './checkpoint-state.mjs';
export function publisherDelay(settings,role,now=Date.now()){
 assert(['primary','standby'].includes(role));const delay=checkpointDelay(settings,now);
 return role==='primary'?delay:Math.max(90000,Math.ceil(delay*1.5));
}
export async function publisherStep({profile,settings,client,role,lastPublished=0,startedAt=Date.now(),now=Date.now(),publish=cycle}){
 assert(['primary','standby'].includes(role));
 const read=name=>JSON.parse(fs.readFileSync(join(profile,name))),policy=read('trust-policy.json');
 const indexed=fs.existsSync(join(profile,'indexed-checkpoint-operator.json'));
 refreshIndexedCadence(profile,settings);
 let live;if(indexed)live=(await indexedRequest(profile,'indexedCheckpoint')).record?.document??null;
 else{const q=await rpc(settings.rpc,'abci_query',{path:'/checkpoint'});assert(!q.response.code);live=JSON.parse(Buffer.from(q.response.value,'base64'));}
 const local=fs.existsSync(join(profile,'checkpoint.json'))?read('checkpoint.json'):null,config=read('app-config.json'),verification={configHash:hash(config)};
 if(local)verifyPublisherAnchor(local,policy,verification);
 if(live){verifyPublisherAnchor(live,policy,verification);if(live.body.expiresAt<=Math.floor(now/1000))live=null;else verifyCheckpoint(live,policy,verification);}
 const next=!local?live:!live?local:live.body.sequence>=local.body.sequence?live:local;
 if(next&&local){const verify=next===local?verifyPublisherAnchor:verifyCheckpoint;verify(next,policy,{previous:local,allowGap:true,...verification});}
 // A publisher verifies the checkpoint being adopted at its certified height.
 // A wallet's latest-head sync deliberately requires the latest policy to be
 // checkpointed already; using it here would deadlock the first renewal round.
 if(next&&(!local||next.body.sequence>local.body.sequence)){
  if(indexed)await adoptIndexedCheckpoint(profile,settings.rpc,next,local);
  else{
  assert(local,'legacy publisher requires a verified local anchor');
  const result=await recoverPath({binary:client.binary,genesisFile:client.genesisFile,url:settings.rpc,anchor:local.body,target:next.body.height,file:join(client.home,'publisher-adoption-headers.json')});
  assert.equal(result.verified.blockHash,next.body.blockHash);assert.equal(result.verified.appHash,next.body.appHash);
  checkCheckpointState(next,await snapshot(settings.rpc,next.body.appHeight),client.config,policy);
  const temp=join(profile,'checkpoint.verified-next.json');fs.writeFileSync(temp,JSON.stringify(next),{mode:0o600});fs.renameSync(temp,join(profile,'checkpoint.json'));
  }
 }
 refreshIndexedCadence(profile,settings);
 // A restart must not produce another snapshot immediately. The standby waits
 // longer than the primary under the same authenticated retention policy.
 const due=next?next.body.expiresAt*1000<=now||now-Math.max(lastPublished,next.body.issuedAt*1000)>=publisherDelay(settings,role,now):role==='primary'||now-startedAt>=publisherDelay(settings,role,now);
 if(!due)return {published:false,height:next?.body.height??0,sequence:next?.body.sequence??0,lastPublished};
 const result=await publish(profile,settings);refreshIndexedCadence(profile,settings);return {published:true,...result,lastPublished:now};
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 const [profile,settingsFile,home,role]=process.argv.slice(2);assert(['primary','standby'].includes(role));
 const read=name=>JSON.parse(fs.readFileSync(join(profile,name))),settings=JSON.parse(fs.readFileSync(settingsFile));fs.mkdirSync(home,{recursive:true,mode:0o700});
 const client=new VerifiedClient({home,config:read('app-config.json'),policy:read('trust-policy.json'),genesisFile:join(profile,'genesis.json'),binary:join(import.meta.dirname,'build/duebyte-abci'+(process.platform==='win32'?'.exe':''))});
 let stopped=false,wake,lastPublished=0;const startedAt=Date.now();for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{stopped=true;wake?.();});
 try{while(!stopped){try{const result=await publisherStep({profile,settings,client,role,lastPublished,startedAt});lastPublished=result.lastPublished;const row={ok:true,role,checkedAt:new Date().toISOString(),...result};fs.writeFileSync(join(home,'status.json'),JSON.stringify(row));if(result.published)console.log(JSON.stringify(row));}catch(e){fs.writeFileSync(join(home,'status.json'),JSON.stringify({ok:false,role,checkedAt:new Date().toISOString(),error:e.message}));console.error('Checkpoint publication awaits verified state: '+e.message);}if(!stopped)await new Promise(r=>{const timer=setTimeout(r,10000);wake=()=>{clearTimeout(timer);r();};});}}finally{client.close();}
}
