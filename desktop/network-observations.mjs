// Session-local observations, never authority for balance or payments.
export class NetworkObservations {
 constructor(){this.samples=[];}
 observe(network,now=Date.now()){
  const n=network??{},last=this.samples.at(-1);
  if(n.ready&&Number.isSafeInteger(n.checkedAt)&&n.checkedAt<=now&&now<n.validUntil&&Number.isInteger(n.heads)&&n.heads>=7&&n.heads<=10&&(!last||n.checkedAt>last.at)){
   this.samples.push({at:n.checkedAt,heads:n.heads});
   if(this.samples.length>60)this.samples.shift();
  }
  return this.samples;
 }
}
