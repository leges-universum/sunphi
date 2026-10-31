// Only authenticated progress can extend the initial verification wait.
// Routine refreshes, renderer polls and animations never count as activity.
export class IdlePolicy {
 constructor({now=()=>performance.now(),idleMs=300000,initialMs=1200000,warningMs=60000}={}){
  this.now=now;this.idleMs=idleMs;this.initialMs=initialMs;this.warningMs=warningMs;this.lock();
 }
 lock(){this.direction=null;this.initial=false;this.epoch=-1;this.scanned=-1;}
 open(direction){const now=this.now();this.direction=direction;this.started=this.activityAt=this.progressAt=now;this.initial=direction==='network';this.epoch=-1;this.scanned=-1;}
 activity(){if(this.direction)this.activityAt=this.now();}
 observe({locked,epoch,scanned,complete}={}){
  if(this.direction!=='network')return;
  if(locked){this.lock();return;}
  if(!this.initial)return;
  const now=this.now();
  if(complete){this.initial=false;this.activityAt=now;return;}
  if(Number.isSafeInteger(epoch)&&epoch>this.epoch){this.epoch=epoch;this.progressAt=now;}
  if(Number.isSafeInteger(scanned)&&scanned>this.scanned){this.scanned=scanned;this.progressAt=now;}
 }
 status(){
  if(!this.direction)return {unlocked:false,warning:false,expired:false};
  const now=this.now(),normal=this.activityAt+this.idleMs;
  const deadline=this.initial?Math.max(normal,Math.min(this.started+this.initialMs,this.progressAt+this.idleMs)):normal;
  const remainingMs=Math.max(0,deadline-now);
  return {unlocked:true,initial:this.initial,remainingMs,warning:remainingMs<=this.warningMs,expired:now>=deadline};
 }
}
