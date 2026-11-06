// A standby publisher has no signing keys. Every publication still needs the
// independent attester quorum and verified consensus ancestry.
import fs from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {cycle,checkpointDelay} from './checkpoint-coordinator.mjs';
import {VerifiedClient,rpc,snapshot} from './client.mjs';
import {verifyCheckpoint} from './checkpoint.mjs';
import {recoverPath} from './recovery.mjs';
import {checkCheckpointState} from './checkpoint-state.mjs';
export async function publisherStep({profile,settings,client,role,lastPublished=0,now=Date.now()}){
 assert(['primary','standby'].includes(role));
 const read=name=>JSON.parse(fs.readFileSync(join(profile,name))),policy=read('trust-policy.json');
 const q=await rpc(settings.rpc,'abci_query',{path:'/checkpoint'});assert(!q.response.code);
 const live=JSON.parse(Buffer.from(q.response.value,'base64')),local=read('checkpoint.json');
 verifyCheckpoint(live,policy);
 const next=live.body.sequence>=local.body.sequence?live:local;
 verifyCheckpoint(next,policy,{previous:local,allowGap:true});
 // A publisher verifies the checkpoint being adopted at its certified height.
 // A wallet's latest-head sync deliberately requires the latest policy to be
 // checkpointed already; using it here would deadlock the first renewal round.
 if(next.body.sequence>local.body.sequence){
  const result=await recoverPath({binary:client.binary,genesisFile:client.genesisFile,url:settings.rpc,anchor:local.body,target:next.body.height,file:join(client.home,'publisher-adoption-headers.json')});
  assert.equal(result.verified.blockHash,next.body.blockHash);assert.equal(result.verified.appHash,next.body.appHash);
  checkCheckpointState(next,await snapshot(settings.rpc,next.body.appHeight),client.config,policy);
  const temp=join(profile,'checkpoint.verified-next.json');fs.writeFileSync(temp,JSON.stringify(next),{mode:0o600});fs.renameSync(temp,join(profile,'checkpoint.json'));
 }
 const due=role==='primary'?now-lastPublished>=checkpointDelay(settings,now):now-next.body.issuedAt*1000>=90000;
 if(!due)return {published:false,height:next.body.height,sequence:next.body.sequence,lastPublished};
 const result=await cycle(profile,settings);return {published:true,...result,lastPublished:now};
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 const [profile,settingsFile,home,role]=process.argv.slice(2);assert(['primary','standby'].includes(role));
 const read=name=>JSON.parse(fs.readFileSync(join(profile,name))),settings=JSON.parse(fs.readFileSync(settingsFile));fs.mkdirSync(home,{recursive:true,mode:0o700});
 const client=new VerifiedClient({home,config:read('app-config.json'),policy:read('trust-policy.json'),genesisFile:join(profile,'genesis.json'),binary:join(import.meta.dirname,'build/duebyte-abci'+(process.platform==='win32'?'.exe':''))});
 let stopped=false,wake,lastPublished=0;for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{stopped=true;wake?.();});
 try{while(!stopped){try{const result=await publisherStep({profile,settings,client,role,lastPublished});lastPublished=result.lastPublished;const row={ok:true,role,checkedAt:new Date().toISOString(),...result};fs.writeFileSync(join(home,'status.json'),JSON.stringify(row));if(result.published)console.log(JSON.stringify(row));}catch(e){fs.writeFileSync(join(home,'status.json'),JSON.stringify({ok:false,role,checkedAt:new Date().toISOString(),error:e.message}));console.error('Checkpoint publication awaits verified state: '+e.message);}if(!stopped)await new Promise(r=>{const timer=setTimeout(r,10000);wake=()=>{clearTimeout(timer);r();};});}}finally{client.close();}
}
