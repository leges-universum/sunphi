// Dedicated, bounded signing process. No generic sign or key export operation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
import {exact,hash,sign,verify,integer,hex,publicKey} from '../crypto.mjs';
import {envelope} from '../core.mjs';
import {PURCHASE,acceptance,verifyPurchaseOffer} from './purchase-contract.mjs';
import {PURCHASE_ACTION} from './purchase-native.mjs';
import {isolatedPurchaseConfig,refundAddress} from './purchase-api.mjs';
import {openPurchaseCustody} from './purchase-custody.mjs';
import {unseal} from '../vault.mjs';

const atomic=v=>{assert(typeof v==='string'&&/^[1-9][0-9]{0,17}$/.test(v));return BigInt(v);};
export class SellerSigner {
 #key; #config; #settings; #btcDestinations;
 constructor({config,settings,bundle,password,key:unlockedKey,btcDestinations=[],vaultKind='purchase-custody'}){
  const policy=isolatedPurchaseConfig(config);exact(settings,['maxOrderMicro','minOrderMicro','quoteSeconds','paymentSeconds','rates','usdcDestinations']);
  assert(atomic(settings.minOrderMicro)<=atomic(settings.maxOrderMicro));integer(settings.quoteSeconds,1);assert(settings.quoteSeconds<=300);integer(settings.paymentSeconds,settings.quoteSeconds+1);assert(settings.paymentSeconds<=3600);
  exact(settings.rates,['BTC','USDC']);for(const rate of Object.values(settings.rates)){exact(rate,['numerator','denominator','feeAtomic']);atomic(rate.numerator);atomic(rate.denominator);assert(typeof rate.feeAtomic==='string'&&/^(0|[1-9][0-9]{0,17})$/.test(rate.feeAtomic));}
  assert(Array.isArray(settings.usdcDestinations)&&settings.usdcDestinations.length>0&&settings.usdcDestinations.length<=64);settings.usdcDestinations.forEach(a=>assert.equal(refundAddress('USDC',a),a));assert.equal(new Set(settings.usdcDestinations).size,settings.usdcDestinations.length);
  assert(Array.isArray(btcDestinations)&&btcDestinations.length<=64);btcDestinations.forEach(a=>assert.equal(refundAddress('BTC',a),a));assert.equal(new Set(btcDestinations).size,btcDestinations.length);
  assert(['purchase-custody','personal-wallet'].includes(vaultKind),'unsupported seller vault kind');
  if(vaultKind==='personal-wallet'){
   // Read the existing vault in memory. Never convert, rewrite or export it.
   const key=unlockedKey??unseal(bundle,password);assert.equal(key.publicKey,policy.seller,'personal wallet does not match pinned seller');
   assert(verify({domain:'SELLER_KEY_CHECK'},sign({domain:'SELLER_KEY_CHECK'},key.privateKey),policy.seller));this.#key=key;
  }else{
  const opened=openPurchaseCustody(bundle,password,{configHash:hash(config),policyHash:hash(policy)});
  assert.equal(opened.secrets.length,1,'seller signing vault must not contain refund keys');const secret=opened.secrets[0];assert.equal(secret.kind,'ed25519-private-key');
  const bytes=Buffer.from(secret.data,'base64');try{this.#key={publicKey:policy.seller,privateKey:bytes.toString()};assert(verify({domain:'SELLER_KEY_CHECK'},sign({domain:'SELLER_KEY_CHECK'},this.#key.privateKey),policy.seller),'seller key does not match policy');}finally{bytes.fill(0);secret.data='';}
  }
  this.#config=structuredClone(config);this.#settings=structuredClone(settings);this.#btcDestinations=[...btcDestinations];this.policy=policy;
 }
 quote(p,now=Math.floor(Date.now()/1000)){
  exact(p,['buyer','route','dubytMicro','refundDestination','destination']);publicKey(p.buyer);assert.notEqual(p.buyer,this.policy.seller);assert.equal(refundAddress(p.route,p.refundDestination),p.refundDestination);assert.equal(refundAddress(p.route,p.destination),p.destination);
  const value=atomic(p.dubytMicro),s=this.#settings;assert(value>=atomic(s.minOrderMicro)&&value<=atomic(s.maxOrderMicro),'order amount outside seller limits');
  if(p.route==='USDC')assert(s.usdcDestinations.includes(p.destination),'unprovisioned deposit address');
  if(p.route==='BTC')assert(this.#btcDestinations.includes(p.destination),'unprovisioned deposit address');
  const rate=s.rates[p.route],pay=(value*atomic(rate.numerator)+atomic(rate.denominator)-1n)/atomic(rate.denominator);assert(pay>0n&&pay<10n**24n&&BigInt(rate.feeAtomic)<=pay,'invalid quote price');
  const offer={domain:PURCHASE+'/OFFER',policyHash:hash(this.policy),network:this.policy.network,nonce:randomBytes(32).toString('hex'),seller:this.policy.seller,...p,payAtomic:String(pay),feeAtomic:rate.feeAtomic,createdAt:now,quoteUntil:now+s.quoteSeconds,payUntil:now+s.paymentSeconds};
  return {offer,sellerSignature:sign(offer,this.#key.privateKey)};
 }
 prepare({command,inputs},now=Math.floor(Date.now()/1000)){
  exact(command,['type','offer','sellerSignature','buyerSignature']);assert.equal(command.type,'RESERVE');verifyPurchaseOffer(this.policy,command.offer,command.sellerSignature,now);
  assert(verify(acceptance(this.policy,command.offer),command.buyerSignature,command.offer.buyer),'buyer acceptance required');
  const offer=command.offer,s=this.#settings,value=atomic(offer.dubytMicro),rate=s.rates[offer.route];
  assert(value>=atomic(s.minOrderMicro)&&value<=atomic(s.maxOrderMicro));
  assert((offer.route==='BTC'?this.#btcDestinations:s.usdcDestinations).includes(offer.destination),'unprovisioned deposit address');
  assert.equal(offer.payAtomic,String((value*atomic(rate.numerator)+atomic(rate.denominator)-1n)/atomic(rate.denominator)),'price differs from pinned settings');assert.equal(offer.feeAtomic,rate.feeAtomic);
  assert.equal(offer.quoteUntil,offer.createdAt+s.quoteSeconds);assert.equal(offer.payUntil,offer.createdAt+s.paymentSeconds);
  assert(Array.isArray(inputs)&&inputs.length>0&&inputs.length<=8);inputs.forEach(hex);assert.deepEqual(inputs,[...new Set(inputs)].sort());
  return envelope(this.#config,{type:PURCHASE_ACTION,command,inputs},this.#key);
 }
 close(){this.#key=null;}
}

// IPC is inherited, never a listening socket. Password is absent from argv/env.
if(process.send){
 let signer=null,busy=false;
 process.on('message',message=>{
  const id=message?.id;try{assert(Number.isSafeInteger(id)&&!busy);busy=true;exact(message,['id','action','payload']);
   let result;
   if(message.action==='unlock'){
    assert(!signer,'already unlocked');const p=message.payload;exact(p,['config','settings','vaultFile','password','btcDestinations']);
    assert(fs.statSync(p.vaultFile).size<=34*1024*1024);signer=new SellerSigner({...p,bundle:JSON.parse(fs.readFileSync(p.vaultFile))});p.password='';result={seller:signer.policy.seller};
   }else{assert(signer,'seller locked');assert(['quote','prepare'].includes(message.action),'unsupported signing action');result=signer[message.action](message.payload);}
   process.send({id,result});
  }catch{process.send({id,error:'Seller signing request rejected.'});}finally{busy=false;}
 });
 process.on('disconnect',()=>{signer?.close();process.exit(0);});
}
