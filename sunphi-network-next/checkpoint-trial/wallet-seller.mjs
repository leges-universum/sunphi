import assert from 'node:assert/strict';
import {hash,exact} from './crypto.mjs';
import {formatToken} from './token-units.mjs';
import {ProtectedSellerSigner,validateSellerProfile,PERSONAL_SELLER_PROFILE} from './research/purchase-seller-protected.mjs';
import {purchaseTransport,securePurchaseRequest} from './research/purchase-transport.mjs';
import {relayRequest} from './research/purchase-home-relay.mjs';
const externalAmount=(value,decimals)=>{const scale=10n**BigInt(decimals),fraction=String(value%scale).padStart(decimals,'0').replace(/0+$/,'');return String(value/scale)+(fraction?'.'+fraction:'');};
export class WalletSeller {
 constructor({config,profile,transport,bundle,key,journal,ready,request=securePurchaseRequest}){
  assert.equal(profile.domain,PERSONAL_SELLER_PROFILE);validateSellerProfile(profile);assert.equal(hash(profile.config),hash(config));assert.equal(key.publicKey,profile.config.purchaseLab.policy.seller);assert.equal(hash(bundle),profile.vaultHash);purchaseTransport(transport);
  Object.assign(this,{profile:structuredClone(profile),transport:structuredClone(transport),bundle,key,journal,ready,request});this.signer=null;this.epoch=0;this.busy=false;this.message='Sales paused. Enable only after reviewing the limits.';
 }
 status(){const prices=Object.entries(this.profile.settings.rates).map(([asset,r])=>{const units=(1000000n*BigInt(r.numerator)+BigInt(r.denominator)-1n)/BigInt(r.denominator);return {asset,amount:externalAmount(units,this.profile.config.purchaseLab.policy.routes[asset].decimals)};});return {available:true,enabled:!!this.signer,profileHash:hash(this.profile),operator:this.profile.operator,seller:this.key?.publicKey??null,endpoint:new URL(this.transport.url).origin,daily:formatToken(this.profile.dailyLimitMicro,'1000000'),maximum:formatToken(this.profile.settings.maxOrderMicro,'1000000'),prices,message:this.message};}
 start(pin){assert.equal(pin,hash(this.profile),'Seller terms changed. Review again.');assert(this.ready(),'Wait for verified network data.');assert(!this.signer,'Sales already enabled.');this.signer=new ProtectedSellerSigner({profile:this.profile,bundle:this.bundle,key:this.key,journal:this.journal});this.message='Sales enabled while this wallet is open and network data is verified.';this.epoch++;}
 stop(){this.epoch++;this.abort?.abort();this.signer?.close();this.signer=null;this.message='Sales paused. Existing orders remain on the network.';}
 async tick(){
  if(this.busy||!this.signer)return;
  if(!this.ready()){this.stop();this.message='Sales paused: verify the connection, then enable again.';return;}
  this.busy=true;const epoch=this.epoch;this.abort=new AbortController();
  const current=()=>this.signer&&epoch===this.epoch&&this.ready();
  try{
   const r=await this.request(this.transport,relayRequest(this.profile,this.key,'poll',{}),{signal:this.abort.signal,timeoutMs:10000});if(!current())return;exact(r,['job']);if(!r.job)return;
   exact(r.job,['id','action','payload']);const j=r.job;assert(['quote','prepare'].includes(j.action));assert.equal(j.id,hash({profile:hash(this.profile),action:j.action,payload:j.payload}));
   let result;try{result={value:this.signer[j.action](j.payload)};}catch{result={error:'Signing request rejected by wallet limits.'};}
   if(!current())return;
   await this.request(this.transport,relayRequest(this.profile,this.key,'complete',{id:j.id,result}),{signal:this.abort.signal,timeoutMs:10000});if(current())this.message=result.error??'Request signed locally. Private key stays on this computer.';
  }catch{if(epoch===this.epoch)this.message='Seller connection unavailable. Saved requests will be retried.';}
  finally{this.busy=false;this.abort=null;}
 }
 close(){this.stop();this.key=null;this.bundle=null;}
}
