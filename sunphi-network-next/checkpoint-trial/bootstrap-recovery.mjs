// Retry only a stalled initial, non-voting bootstrap. Never reset data or pins.
export class BootstrapRecovery{
 constructor(){this.since=null;this.retries=0;this.finished=false;}
 observe(rpc,now=performance.now()){
  // A zero-height status can precede state sync even when catchingUp is false.
  // Only verified history permanently disables initial-bootstrap recovery.
  if(Number(rpc.height)>0){this.finished=true;return 'continue';}
  if(this.finished)return 'continue';
  // Do not spend the download allowance opening transports or starting the app.
  if(this.since===null){this.since=now;return 'continue';}
  // Slow disks and links must be allowed to finish the initial download.
  // Keep retries bounded without resetting keys, state or verification pins.
  if(now-this.since<10*60*1000)return 'continue';
  this.since=now;if(this.retries>=2)return 'stop';
  this.retries++;return 'restart';
 }
}
