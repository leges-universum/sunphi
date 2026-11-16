import assert from 'node:assert/strict';

// One foreground payment waits for the current verifier, then owns the lane.
// No persisted/autonomous payment queue: expiry or session loss executes nothing.
export class WalletPaymentLane {
 pending=false;
 async run({busy,valid,execute,timeoutMs=10000,pause=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}){
  assert(!this.pending,'A payment operation is already in progress.');
  this.pending=true;
  try{
   const end=now()+timeoutMs;
   while(busy()){
    assert(valid(),'Wallet session or confirmation changed. Review again.');
    assert(now()<end,'Verification is still finishing. No new payment was created. Try again shortly.');
    await pause(50);
   }
   assert(valid(),'Wallet session or confirmation changed. Review again.');
   return await execute();
  }finally{this.pending=false;}
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
