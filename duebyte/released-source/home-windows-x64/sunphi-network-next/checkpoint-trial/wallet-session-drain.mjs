import assert from 'node:assert/strict';

// Reserve the next foreground operation while the verifier finishes.
export class WalletPaymentLane {
 active=false;
 queue=[];
 get pending(){return this.active||this.queue.length>0;}
 async run({busy,valid,execute,waitForCurrent=false,timeoutMs=10000,timeoutMessage='Verification is still finishing. No new payment was created. Try again shortly.',pause=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}){
  const end=now()+timeoutMs;
  if(this.pending){
   assert(waitForCurrent,'A wallet operation is already in progress.');
   assert(this.queue.length<8,'Wallet review queue is full. Please try again shortly.');
   const ticket=Symbol();this.queue.push(ticket);
   try{
    while(this.active||this.queue[0]!==ticket){
     assert(valid(),'Wallet session changed. Reopen the proposal in the current wallet.');
     assert(now()<end,timeoutMessage);
     await pause(50);
    }
   }finally{this.queue.splice(this.queue.indexOf(ticket),1);}
  }
  this.active=true;
  try{
   while(busy()){
    assert(valid(),'Wallet session or confirmation changed. Review again.');
    assert(now()<end,timeoutMessage);
    await pause(50);
   }
   assert(valid(),'Wallet session or confirmation changed. Review again.');
   return await execute();
  }finally{this.active=false;}
 }
}

// Reserve a session change before waiting, so periodic verification cannot
// start another operation between completion of the old one and locking.
export class WalletSessionDrain {
 pending=false;
 async run({busy,valid,close,timeoutMs=10000,pause=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}){
  assert(!this.pending,'Wallet switching is already in progress.');
  this.pending=true;
  try{
   const end=now()+timeoutMs;
   while(busy()){
    assert(valid(),'Wallet session changed.');
    assert(now()<end,'The current wallet operation is still finishing. Your wallet remains open. Try switching again shortly.');
    await pause(50);
   }
   assert(valid(),'Wallet session changed.');
   return close();
  }finally{this.pending=false;}
 }
}
