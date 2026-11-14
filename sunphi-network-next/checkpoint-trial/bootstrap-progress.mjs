// Local display telemetry only. Never used to authenticate state or authorize payments.
import {readFileSync,statSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
export function clearBootstrapProgress(home){try{unlinkSync(join(home,'bootstrap-progress.json'));}catch{}}
export function readBootstrapProgress(home){
 try{const file=join(home,'bootstrap-progress.json');if(statSync(file).size>4096)return null;return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}
}
export class BootstrapProgress {
 constructor(home,now=Date.now){this.home=home;this.now=now;this.record=null;this.seen=new Set();this.lastWrite=0;clearBootstrapProgress(home);}
 start(manifest){this.seen.clear();this.record={height:manifest.height,total:manifest.chunks,received:0,phase:'downloading'};this.publish(true);}
 received(index){if(!this.record||!Number.isSafeInteger(index)||index<0||index>=this.record.total)return;this.seen.add(index);this.record.received=this.seen.size;this.publish(false);}
 phase(phase){if(!this.record)return;this.record.phase=phase;if(phase==='verifying'||phase==='complete')this.record.received=this.record.total;this.publish(true);}
 publish(force){
  const now=this.now();if(!force&&now-this.lastWrite<500)return;this.lastWrite=now;
  // A full disk or unavailable telemetry file must not change consensus behaviour.
  try{const file=join(this.home,'bootstrap-progress.json'),temp=file+'.next';writeFileSync(temp,JSON.stringify({...this.record,updatedAt:now}),{mode:0o600});renameSync(temp,file);}catch{}
 }
}
