// Retry only a stalled initial, non-voting bootstrap. Never reset data or pins.
export class BootstrapRecovery{
 constructor(now=Date.now()){this.since=now;this.retries=0;this.finished=false;}
 observe(rpc,now=Date.now()){
  if(!rpc.catchingUp||Number(rpc.height)>0){this.finished=true;return 'continue';}
  if(this.finished||now-this.since<45000)return 'continue';
  this.since=now;if(this.retries>=2)return 'stop';
  this.retries++;return 'restart';
 }
}
