import {readFileSync,mkdirSync,statSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {RenewalBook} from '../src/renewing-history.mjs';
import {ReplicatedApp} from '../src/replicated-app.mjs';
import {replayArchive} from '../src/history-client.mjs';
import {lockController} from '../src/controller-lock.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url))),[command='help',...args]=process.argv.slice(2);
if(command==='help'){console.log('SunPhi Native Node 0.12 — isolated laboratory only\nverify STATE_DIRECTORY [PUBLIC_PROFILE_DIRECTORY]\nstart PREPARED_NODE_HOME BASE_PORT\nNo automatic joining, issuance, rewards or production access. No keys are supplied.');}
else if(command==='verify'){
 if(!args[0])throw Error('A separate writable state directory is required');
 const state=resolve(args[0]),profile=resolve(args[1]??join(root,'profile'));mkdirSync(state,{recursive:true,mode:0o700});
 const file=p=>{if(statSync(p).size>24*1024*1024)throw Error('Input size limit');return readFileSync(p);};
 const data=JSON.parse(file(join(profile,'certificates.json'))),genesisPath=join(profile,'genesis.json'),genesis=JSON.parse(file(genesisPath));
 if(!Array.isArray(data.certificates)||data.certificates.length>1024)throw Error('Checkpoint limit');
 const unlock=lockController([join(state,'history.db'),join(state,'application.sqlite')]);let book,app;
 try{
  book=await RenewalBook.open(join(state,'history.db'),data.policy,{bin:join(root,'runtime/bin/sunphi-abci'+(process.platform==='win32'?'.exe':'')),genesis:genesisPath,temporary:join(state,'verify')});
  for(const c of data.certificates){if(!Number.isSafeInteger(c.body.epoch)||c.body.epoch<0)throw Error('Invalid epoch');if(c.body.epoch>(book.context.last?.body.epoch??-1))await book.accept(c,file(join(profile,`epoch-${c.body.epoch}.json`)));}
  app=await ReplicatedApp.open({mode:'isolated',path:join(state,'application.sqlite'),keyPath:join(root,'profile/verification-key.json'),config:genesis.app_state});
  for(const c of book.certificates){const height=(await app.dispatch({method:'info'})).height;if(height>c.body.endHeight)continue;await replayArchive(app,book.archive(c.body.epoch),c);console.log(`Verified through block ${c.body.endHeight}`);}
  console.log(JSON.stringify({role:'archive-verifier',live:false, ...(await app.dispatch({method:'status'})).value}));
 }finally{app?.close();book?.close();unlock();}
}else if(command==='start'){
 if(!['linux','win32'].includes(process.platform))throw Error('Prepared full-node launcher requires Linux or Windows');
 if(args.length!==2)throw Error('Prepared node home and base port required');
 const child=spawn(process.execPath,[join(root,'tools/run-node.mjs'),resolve(args[0]),join(root,'runtime'),args[1]],{cwd:root,stdio:['inherit','inherit','inherit','ipc'],windowsHide:true});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(child.connected)child.send({command:'stop'});});child.on('exit',code=>{process.exitCode=code??1;});
}else throw Error('Unknown node command');
