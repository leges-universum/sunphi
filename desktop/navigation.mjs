// Navigation never interrupts an active wallet operation or bypasses its lock.
export function operationLabel(action){
 return ({status:'Reading wallet status', 'last-wallet':'Reading the saved wallet selection',
  'clear-wallet-selection':'Updating the wallet selection','select-wallet':'Choosing a wallet file',
  open:'Unlocking the wallet',create:'Creating the wallet',restore:'Restoring the backup',
  backup:'Saving the encrypted backup','copy-locked':'Saving an encrypted wallet copy',
  refresh:'Checking network history',prepare:'Preparing the payment proof',send:'Submitting the payment',
  recover:'Checking the payment result',invoice:'Saving the payment request',
  'review-invoice':'Reading the payment request',import:'Verifying the receipt',
  'export-receipt':'Saving the receipt',bitcoin:'Reading Bitcoin network information',
  profile:'Choosing a network profile',lock:'Locking the wallet',
  procedure:'Completing the Coin operation','procedure-status':'Reading Coin account status',
  'connection-request':'Saving the connection request',stop:'Disconnecting the node',
  start:'Starting the node',wallet:'Opening the wallet',home:'Opening the node'})[action]||'Completing the wallet operation';
}
export class Navigation{
 constructor({isBusy,operation,lock,load,waitMs=120000,pollMs=50}){Object.assign(this,{isBusy,operation,lock,load,waitMs,pollMs});this.current=null;}
 get pending(){return !!this.current;}
 get loading(){return this.current?.phase==='loading';}
 status(){const c=this.current;if(!c)return {pending:false};const name={coin:'Coin',network:'Network',node:'Node'}[c.target];return {pending:true,cancellable:c.phase==='waiting',message:c.phase==='waiting'?`${this.operation()}. ${name} will open automatically when it finishes.`:c.phase==='locking'?`Locking the wallet before opening ${name}…`:`Opening ${name}…`};}
 cancel(){if(this.current?.phase!=='waiting')return false;this.current.cancelled=true;return true;}
 async go(target){
  if(this.current)return {ok:false,error:'A screen change is already in progress.'};
  const c=this.current={target,phase:'waiting',cancelled:false};const started=Date.now();
  try{
   while(this.isBusy()){
    if(c.cancelled)return {ok:false,cancelled:true};
    if(Date.now()-started>=this.waitMs)return {ok:false,error:`${this.operation()} is still running. The screen change was cancelled; try again when it finishes.`};
    await new Promise(r=>setTimeout(r,this.pollMs));
   }
   if(c.cancelled)return {ok:false,cancelled:true};
   c.phase='locking';await this.lock();c.phase='loading';await this.load(target);return {ok:true};
  }finally{if(this.current===c)this.current=null;}
 }
}
