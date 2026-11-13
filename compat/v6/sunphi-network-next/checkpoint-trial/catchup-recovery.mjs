// A follower can stay in consensus replay after a long disconnection. Re-enter
// block sync through a bounded, graceful restart, retaining all verified data.
export function corroboratesCatchup(local,remote,wall=Date.now()){
 const sync=remote?.sync_info,head=Number(sync?.latest_block_height),height=Number(local.height);
 const time=Date.parse(sync?.latest_block_time),saved=Date.parse(local.time);
 return remote?.node_info?.network===local.chain&&sync?.catching_up===false&&
  Number.isSafeInteger(head)&&Number.isSafeInteger(height)&&height>0&&head-height>100&&
  Number.isFinite(time)&&Number.isFinite(saved)&&time-saved>=600000&&wall-time>=0&&wall-time<=120000;
}
export class CatchupRecovery {
 constructor(){this.sample=null;this.retries=0;this.lastRestart=-Infinity;this.freshSince=null;}
 interrupted(){this.sample=null;this.freshSince=null;}
 observe(rpc,now=performance.now(),wall=Date.now()){
  const height=Number(rpc.height),time=Date.parse(rpc.time),lag=wall-time;
  if(String(rpc.votingPower)!=='0'||!Number.isSafeInteger(height)||height<=0||
   !Number.isFinite(time)||!Number.isFinite(now)||!Number.isFinite(wall)||lag<0||
   !Number.isSafeInteger(rpc.peers)||rpc.peers<1){this.interrupted();return 'continue';}
  // A stable, current follower earns a new recovery allowance. A short status
  // fluctuation must not reset the lifetime limit for the same outage.
  if(lag<30000){
   this.sample=null;this.freshSince??=now;
   if(now-this.freshSince>=300000){this.retries=0;this.lastRestart=-Infinity;}
   return 'continue';
  }
  this.freshSince=null;
  if(rpc.catchingUp!==false||lag<600000||this.retries>=2||now-this.lastRestart<1800000){this.sample=null;return 'continue';}
  if(!this.sample||now<this.sample.now||height<this.sample.height||time<this.sample.time){this.sample={now,wall,height,time};return 'continue';}
  const elapsed=now-this.sample.now;
  if(elapsed<120000)return 'continue';
  // Reject large wall-clock adjustments; do not restart a healthy node because
  // the operating system clock changed or observations were interrupted.
  if(elapsed>150000||Math.abs((wall-this.sample.wall)-elapsed)>5000){this.sample={now,wall,height,time};return 'continue';}
  const closingSpeed=(time-this.sample.time)/elapsed-1;
  this.sample={now,wall,height,time};
  // Leave fast replay alone if it is already within two minutes of the tip.
  if(closingSpeed>0&&lag/closingSpeed<=120000)return 'continue';
  this.retries++;this.lastRestart=now;this.sample=null;
  return 'restart';
 }
}
