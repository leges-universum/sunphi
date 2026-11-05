// Linux consumer entry point: one owned runner, pinned profile, persistent keys.
import {fork} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import assert from 'node:assert/strict';
import {validateConsumerProfile} from './consumer-profile.mjs';
const here=import.meta.dirname,root=resolve(here,'../..');
const pin=JSON.parse(readFileSync(join(root,'connection-pin.json'))).sha256,p=validateConsumerProfile(JSON.parse(readFileSync(join(root,'connection-profile.json'))),pin);
const state=join(process.env.XDG_STATE_HOME||join(homedir(),'.local/state'),'duebyte',p.config.chainId);mkdirSync(state,{recursive:true,mode:0o700});
const lock=join(state,'consumer.pid');if(existsSync(lock)){const pid=Number(readFileSync(lock));let alive=true;try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}assert(!alive,'DueByte is already running; use the existing process');unlinkSync(lock);}writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});
const runner=fork(join(here,'consumer-runner.mjs'),[join(root,'connection-profile.json'),pin,state],{stdio:['ignore','inherit','inherit','ipc']});let stopping=false,last='';
runner.on('message',m=>{if(m.progress!==last){last=m.progress;console.log('DueByte: '+last+(m.error?' — '+m.error:''));}if(m.walletReady&&!stopping&&!globalThis.walletAnnounced){globalThis.walletAnnounced=true;console.log('Wallet (this computer only): http://127.0.0.1:'+p.walletPort+'/');}});
const stop=()=>{if(!stopping){stopping=true;if(runner.connected)runner.send({command:'stop'});}};process.on('SIGINT',stop);process.on('SIGTERM',stop);
runner.on('error',e=>{console.error(e.message);process.exitCode=1;});runner.on('close',code=>{if(existsSync(lock)&&readFileSync(lock,'utf8')===String(process.pid))unlinkSync(lock);process.exitCode=code??1;});
