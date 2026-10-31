// Progress can extend startup waiting, never authorize consensus or bypass replay.
export class ReplayWatchdog {
 constructor({now=()=>performance.now(),stallMs=90000,maxMs=900000}={}){this.now=now;this.stallMs=stallMs;this.maxMs=maxMs;this.started=this.progressAt=now();this.height=-1;}
 observe(height){if(!Number.isSafeInteger(height)||height<0||height<=this.height)return false;this.height=height;this.progressAt=this.now();return true;}
 get expired(){const now=this.now();return now-this.progressAt>=this.stallMs||now-this.started>=this.maxMs;}
}
