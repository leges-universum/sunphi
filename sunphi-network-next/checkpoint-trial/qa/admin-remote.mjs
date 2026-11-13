import {spawn} from 'node:child_process';
import {join} from 'node:path';
import assert from 'node:assert/strict';
export const hosts=['root@2.29.99.36','ubuntu@54.39.231.189','root@2.29.115.43','root@204.168.225.219'];
export const sshArgs=['-F','none','-i',join(process.env.LOCALAPPDATA,'SunPhi/WanderServer/hetzner_ed25519'),'-o','BatchMode=yes','-o','ConnectTimeout=15','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile=D:/CodexData/wander-known-hosts'];
const args=sshArgs;
export function run(exe,args,input='',timeout=120000){return new Promise((ok,fail)=>{const p=spawn(exe,args,{windowsHide:true}),output=[],errors=[];const timer=setTimeout(()=>p.kill(),timeout);p.stdout.on('data',b=>output.push(b));p.stderr.on('data',b=>errors.push(b));p.once('error',fail);p.once('close',code=>{clearTimeout(timer);try{assert.equal(code,0,Buffer.concat(errors).toString().slice(-2000));ok(Buffer.concat(output).toString());}catch(e){fail(e);}});p.stdin.end(input);});}
export const remote=(i,script)=>run('ssh.exe',[...args,hosts[i],'sudo -n bash -s'],'set -euo pipefail\n'+script);
export const upload=(i,file,to)=>run('scp.exe',[...args,file,hosts[i]+':'+to]);
