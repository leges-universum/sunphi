import {tokenUnit,quoteTokenValue} from './token-units.mjs';
import {enhanceSelect} from './select-control.mjs';
import {formatUnits} from './procedure-products.mjs';
const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
export function installRecipientTransfer({root,ownFlow,call,run,message,review,instrumentIdentity,transferBalance}){
 let state,proc,checked=null,revision=0,mode='own';
 const modes=node('div',undefined,'actions access-modes transfer-modes');
 const send=node('section',undefined,'panel'),receive=node('section',undefined,'panel');
 send.append(node('h2','Send to a recipient'),node('p','Choose an asset and check the recipient before entering the amount. This demonstration connects wallets registered on this computer only.'));
 const form=node('form');form.id='recipient-form';send.append(form);
 const field=(caption,input)=>{const label=node('label',caption);label.append(input);return label;};
 const balanceSummary=node('div');balanceSummary.id='recipient-balance-summary';
 const source=node('select');source.id='recipient-source';source.required=true;
 const address=node('input');address.id='recipient-address';address.required=true;address.autocomplete='off';address.spellcheck=false;address.placeholder='sunphi_lab1_…';address.maxLength=76;address.pattern='sunphi_lab1_[a-f0-9]{64}';address.dataset.formatHint='Enter a wallet address beginning with sunphi_lab1_ followed by 64 lowercase hexadecimal characters. Copy it from the recipient’s Receive screen.';
 const check=node('button','Check recipient');check.type='button';
 const status=node('div',undefined,'recipient-status');status.setAttribute('role','status');
 const dest=node('select');dest.id='recipient-destination';dest.required=true;
 const destLabel=field('Receiving product *',dest);
 const identity=node('div',undefined,'recipient-identity');
 const amount=node('input');amount.id='recipient-amount';amount.inputMode='decimal';amount.required=true;amount.autocomplete='off';
 const unit=node('span',undefined,'transfer-amount-unit');unit.id='recipient-amount-unit';
 const amountBox=node('span',undefined,'transfer-amount-field');amountBox.append(amount,unit);
 const amountCaption=node('span','Tokens to send *');amountCaption.id='recipient-amount-label';
 const amountLabel=node('label');amountLabel.htmlFor=amount.id;amountLabel.append(amountCaption,amountBox);
 amount.setAttribute('aria-labelledby','recipient-amount-label recipient-amount-unit');
 const balance=node('small',undefined,'transfer-amount-hint');balance.id='recipient-balance';amount.setAttribute('aria-describedby',balance.id);const estimate=node('small',undefined,'transfer-amount-hint');estimate.id='recipient-valuation';amountLabel.append(balance,estimate);amount.oninput=()=>{const p=sourcePosition(),v=p?quoteTokenValue(p,amount.value):null;estimate.textContent=v===null?'':'Basket estimate: ≈ '+v+' XDR · Fixed demonstration rate';};
 const purpose=node('input');purpose.id='recipient-purpose';purpose.maxLength=280;purpose.placeholder='Invoice number or a short note';purpose.autocomplete='off';
 const purposeLabel=field('Payment purpose (optional)',purpose);
 const error=node('p',undefined,'access-error');error.hidden=true;error.setAttribute('role','alert');
 const submit=node('button','Review transfer');submit.type='submit';
 form.append(field('Asset to send *',source),balanceSummary,field('Recipient wallet *',address),check,status,destLabel,identity,amountLabel,purposeLabel,error,submit);
 const sourceControl=enhanceSelect(source),destControl=enhanceSelect(dest);
 receive.append(node('h2','Receive assets'),node('p','Share this wallet address with the sender. Your wallet must first start the demonstration on this computer; wallets on other computers and real institutional transfers are not connected.'));
 const myLabel=node('p'),myAddress=node('textarea');myAddress.readOnly=true;myAddress.rows=3;
 const copy=node('button','Copy wallet address');copy.type='button';copy.onclick=()=>run(async()=>{const r=await call('copy-address');message(r?.copied?'Wallet address copied.':'Select and copy the address shown here.');});
 const receiveInfo=node('p',undefined,'muted');
 receive.append(myLabel,field('Your wallet address',myAddress),copy,receiveInfo);
 for(const [id,caption] of [['own','Between my products'],['send','Send to a recipient'],['receive','Receive']]){
   const b=node('button',caption);b.type='button';b.dataset.transferMode=id;b.onclick=()=>setMode(id);modes.append(b);
 }
 root.prepend(modes);root.append(send,receive);
 function setMode(value){mode=value;ownFlow.hidden=mode!=='own';send.hidden=mode!=='send';receive.hidden=mode!=='receive';for(const b of modes.children)b.setAttribute('aria-pressed',String(b.dataset.transferMode===mode));}
 function sourcePosition(){return proc?.snapshot?.positions.find(p=>p.id===source.value);}
 function blocked(){return !proc?.connected||proc.stale||proc.outbox.some(q=>['SUBMITTING','UNKNOWN','RECOVERY_REQUIRED'].includes(q.state))||proc.snapshot.transactions.some(t=>t.state==='RECOVERY_REQUIRED');}
 function clearCheck(){revision++;checked=null;dest.replaceChildren();destControl.update();destLabel.hidden=true;identity.replaceChildren();status.replaceChildren();error.hidden=true;amount.value='';updateAmount();}
 function updateAmount(){
   const p=sourcePosition();balanceSummary.replaceChildren(transferBalance(p,proc));unit.textContent=p?tokenUnit(p):'';amount.placeholder=p?(p.precision?'0.'+'0'.repeat(p.precision):'0'):'Choose an asset';
   balance.textContent=p?`${proc.stale?'Last confirmed available':'Available'}: ${formatUnits(p.available,p.precision)} ${tokenUnit(p)} · Enter token quantity; XDR is the separate basket valuation.`:'Start the demonstration in Overview first.';
   amount.oninput();amount.disabled=!checked||blocked();submit.disabled=!checked||!dest.value||blocked();check.disabled=!p||!address.value.trim()||!proc?.connected;
 }
 function showIdentity(){identity.replaceChildren();if(checked){const p=checked.destinations.find(p=>p.id===dest.value);identity.append(instrumentIdentity(sourcePosition(),'From your wallet'),instrumentIdentity(p,'To the recipient'));}updateAmount();}
 source.onchange=clearCheck;address.oninput=clearCheck;
 dest.onchange=()=>{amount.value='';showIdentity();};
 check.onclick=()=>run(async()=>{
   clearCheck();const request=revision,addr=address.value.trim(),sourceId=source.value;
   if(!address.reportValidity())return;
   check.disabled=true;status.textContent='Checking recipient…';
   try{
     const result=await call('procedure',{action:'recipient',input:{address:addr,sourceId}});
     if(request!==revision||addr!==address.value.trim()||sourceId!==source.value)return;
     checked=result;status.replaceChildren(node('strong',result.label),node('code',result.address),node('small',result.labelStatus));
     for(const p of result.destinations){const o=node('option',`sun(φ) ${p.profile} · ${p.title} · ${p.obligor}`);o.value=p.id;dest.append(o);}
     destControl.update();destLabel.hidden=false;showIdentity();
   }catch(e){if(request===revision){status.textContent='';error.textContent=e.message;error.hidden=false;}}
   finally{if(request===revision)updateAmount();}
 });
 form.onsubmit=e=>{e.preventDefault();run(async()=>{
   error.hidden=true;if(!checked||checked.address!==address.value.trim()){clearCheck();error.textContent='Check the recipient before continuing.';error.hidden=false;return;}
   try{await review({address:checked.address,sourceId:source.value,destinationId:dest.value,amount:amount.value,purpose:purpose.value},submit);}
   catch(e){error.textContent=e.message;error.hidden=false;}
 });};
 setMode('own');clearCheck();
 return {render(next,nextProc){
   state=next;proc=nextProc;
   if(next.locked){source.replaceChildren();sourceControl.update();address.value='';purpose.value='';myAddress.value='';clearCheck();setMode('own');return;}
   myAddress.value=state.address;myLabel.textContent='Wallet label: '+state.label;receiveInfo.textContent=proc?.connected?'Ready to receive eligible test assets. Give the sender this address; incoming transfers and confirmations appear automatically in Activity while this wallet is unlocked.':'Start the demonstration in Overview before receiving test assets.';
   const previous=source.value;source.replaceChildren();
   for(const p of proc?.snapshot?.positions??[]){const o=node('option',`sun(φ) ${p.profile} · ${p.title} · ${p.obligor}${p.profile==='Ma'?' — Not transferable':''}`);o.value=p.id;o.disabled=p.profile==='Ma';source.append(o);}
   source.value=[...source.options].some(o=>o.value===previous&&!o.disabled)?previous:[...source.options].find(o=>!o.disabled)?.value||'';
   source.disabled=!proc?.connected;sourceControl.update();
   if(previous!==source.value)clearCheck();else if(checked)showIdentity();else updateAmount();
 }};
}
