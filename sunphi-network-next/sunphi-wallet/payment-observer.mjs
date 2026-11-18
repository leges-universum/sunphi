// Dedicated notification transport. No wallet, validator, account or spending keys.
import fs from 'node:fs';
import path from 'node:path';
import {checkpointEvidence} from '../operator-registry/checkpoint-evidence.mjs';
import {boundedHttpQuery} from '../checkpoint-trial/research/bounded-wallet-view.mjs';
import {observeIndexedPage} from './indexed-observer.mjs';
import pins from './node-services-pins.json' with {type:'json'};
const [url,home]=process.argv.slice(2);if(!url||!home)throw Error('LOOPBACK_RPC STATE_DIRECTORY required');
const rpcUrl=new URL(url);if(rpcUrl.protocol!=='http:'||rpcUrl.hostname!=='127.0.0.1')throw Error('Loopback RPC required');
async function query(path,data){
 const r=await fetch(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'abci_query',params:{path,...(data?{data}:{})}}),signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw Error('RPC unavailable');const chunks=[];let size=0;for await(const c of r.body){size+=c.length;if(size>2*1048576)throw Error('RPC response limit');chunks.push(c);}
 const j=JSON.parse(Buffer.concat(chunks));if(j.error||!j.result?.response||j.result.response.code)throw Error('RPC query rejected');return JSON.parse(Buffer.from(j.result.response.value,'base64'));
}
const indexedFile=path.join(home,'indexed-observer.json'),indexed=fs.existsSync(indexedFile)?JSON.parse(fs.readFileSync(indexedFile)):null;
if(indexed){if(!pins.indexedTransition)throw Error('Trusted indexed transition pins required');boundedHttpQuery(indexed.url);}
const endpoint='https://xybinrgjdtklemaxxder.supabase.co/functions/v1/duebyte-wallet-v1';
fs.mkdirSync(home,{recursive:true,mode:0o700});const file=path.join(home,'status.json');
let previous=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;
const save=row=>{fs.writeFileSync(file+'.new',JSON.stringify(row),{mode:0o600});fs.renameSync(file+'.new',file);};
async function cycle(){
 if(pins.indexedTransition){
  if(!indexed)throw Error('Indexed observer configuration required; legacy fallback forbidden');
  const checkpoint=await query('/checkpoint');
  const result=await observeIndexedPage({checkpoint,query:boundedHttpQuery(indexed.url),pins,previous,send:async packet=>{
   const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(packet),redirect:'error',signal:AbortSignal.timeout(20000)});
   if(!r.ok)throw Error('event observation rejected');return r.json();
  }});
  previous={ok:true,checkedAt:new Date().toISOString(),...result};save(previous);console.log(JSON.stringify({ok:true,height:checkpoint.body.height,cursor:result.receipt.cursor}));return result.backlog;
 }
 const checkpoint=await query('/checkpoint'),state=(await query('/snapshot',Buffer.from(String(checkpoint.body.appHeight)).toString('hex'))).state;
 await checkpointEvidence(checkpoint,state,pins,previous?.checkpoint);
 const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'observe_payments',checkpoint,state}),redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!r.ok)throw Error('event observation rejected');const receipt=await r.json();
 previous={ok:true,checkedAt:new Date().toISOString(),checkpoint,receipt};save(previous);
 console.log(JSON.stringify({ok:true,height:checkpoint.body.height,delivered:receipt.delivered,skipped:receipt.skipped}));
}
let stopping=false,wake;for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{stopping=true;wake?.();});
do{
 let backlog=false;try{backlog=await cycle();}catch{save({...previous,ok:false,failedAt:new Date().toISOString(),error:'Verified notification delivery unavailable; the next cycle retries.'});console.error('Notification cycle awaiting verified delivery');if(process.argv.includes('--once'))process.exitCode=1;}
 if(process.argv.includes('--once')||stopping)break;
 await new Promise(r=>{const t=setTimeout(r,backlog?250:30000);wake=()=>{clearTimeout(t);r();};});
}while(!stopping);
