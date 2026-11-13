// Local administrative handoff. Never broadcast, mint or load an owner key.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {hash,exact,hex} from './crypto.mjs';
import {VerifiedClient,rpc} from './client.mjs';
import {signWorkerFunding} from './worker-funding-consent.mjs';

function read(file,{privateFile=false,max=65536}={}){
 assert(path.isAbsolute(file),'absolute file path required');
 assert(!fs.lstatSync(file).isSymbolicLink(),'symbolic file not allowed');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
 try{
  const s=fs.fstatSync(fd);assert(s.isFile()&&s.size<=max,'invalid file size or type');
  if(process.platform==='linux'&&privateFile){assert.equal(s.uid,process.getuid(),'operator file owner');assert.equal(s.mode&0o077,0,'operator file must be private');}
  try{return JSON.parse(fs.readFileSync(fd,'utf8'));}catch{throw new Error('Invalid JSON file');}
 }finally{fs.closeSync(fd);}
}

// Publish only a complete, fsynced receipt. Link creation never replaces evidence.
// A crash before publication can leave a .partial file, never a completed handoff.
export function writeFundingReceipt(outputFile,receipt,io=fs){
 assert(path.isAbsolute(outputFile),'absolute receipt path required');
 assert(!io.existsSync(outputFile),'output already exists; retain the previous handoff');
 const pending=outputFile+'.'+randomUUID()+'.partial';let created=false;
 try{
  const fd=io.openSync(pending,'wx',0o600);created=true;
  try{io.writeFileSync(fd,JSON.stringify(receipt,null,2)+'\n');io.fsyncSync(fd);}finally{io.closeSync(fd);}
  io.linkSync(pending,outputFile);
  if(process.platform!=='win32'){
   const dir=io.openSync(path.dirname(outputFile),'r');
   try{io.fsyncSync(dir);}finally{io.closeSync(dir);}
  }
 }finally{if(created)io.unlinkSync(pending);}
}

// Dependencies are injectable only by imported isolated tests; no CLI bypass.
export async function workerFundingOperator(file,requestFile,outputFile,{Client=VerifiedClient,query=rpc,now=Date.now}={}){
 const cfg=read(file,{privateFile:true});
 exact(cfg,['format','profile','policyPin','home','binary','url','bounded','keyFile','scope']);
 assert.equal(cfg.format,'DUEBYTE_WORKER_FUNDING_OPERATOR_V1');hex(cfg.policyPin);
 for(const value of [cfg.profile,cfg.home,cfg.binary,cfg.keyFile,requestFile,outputFile])assert(path.isAbsolute(value),'absolute operator paths required');
 assert(cfg.bounded,'bounded state endpoint required');
 const config=read(path.join(cfg.profile,'app-config.json'),{max:1048576}),policy=read(path.join(cfg.profile,'trust-policy.json'),{max:1048576});
 assert.equal(hash(policy),cfg.policyPin,'trust policy changed');assert.equal(hash(config),cfg.scope.configHash,'configuration changed');
 const consent=read(requestFile),key=read(cfg.keyFile,{privateFile:true});exact(key,['node','publicKey','privateKey']);
 assert.equal(key.node,cfg.scope.node,'worker identity differs from approved scope');
 assert(!fs.existsSync(outputFile),'output already exists; retain the previous handoff');
 fs.mkdirSync(cfg.home,{recursive:true,mode:0o700});const st=fs.lstatSync(cfg.home);
 assert(st.isDirectory()&&!st.isSymbolicLink(),'operator home must be a real directory');
 if(process.platform==='linux'){assert.equal(st.uid,process.getuid());assert.equal(st.mode&0o077,0,'operator home must be private');}
 const lock=path.join(cfg.home,'funding-sign.lock'),fd=fs.openSync(lock,'wx',0o600);let client;
 try{
  fs.writeSync(fd,String(process.pid));fs.fsyncSync(fd);
  client=new Client({home:cfg.home,config,policy,genesisFile:path.join(cfg.profile,'genesis.json'),binary:cfg.binary,bounded:cfg.bounded});
  const result=await signWorkerFunding(consent,{config,key,scope:cfg.scope,now,view:async({owner,rewardIds})=>{
   const q=await query(cfg.url,'abci_query',{path:'/checkpoint'});assert(q?.response&&!q.response.code,'checkpoint unavailable');
   let checkpoint;try{checkpoint=JSON.parse(Buffer.from(q.response.value,'base64').toString());}catch{throw new Error('Invalid checkpoint response');}
   return client.sync(checkpoint,cfg.url,{owner,rewardIds});
  }});
  const receipt={format:'DUEBYTE_WORKER_FUNDING_HANDOFF_V1',configHash:hash(config),...result};
  writeFundingReceipt(outputFile,receipt);
  return {status:result.status,bodyHash:result.bodyHash,verifiedHeight:result.verifiedHeight,outputFile,submitted:false};
 }finally{try{client?.close();}finally{fs.closeSync(fd);fs.unlinkSync(lock);}}
}

if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)){
 try{assert.equal(process.argv.length,5,'Usage: worker-funding-operator.mjs PROFILE CONSENT OUTPUT');console.log(JSON.stringify(await workerFundingOperator(...process.argv.slice(2)),null,2));}
 catch(e){console.error('Funding handoff refused: '+e.message);process.exitCode=1;}
}
