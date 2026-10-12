import {enhanceSelect,closeSelects} from './select-control.mjs';
import {installWorkspace} from './workspace-ui.mjs';
import {installEnglishValidation} from './english-validation.mjs';
import {developerToolsEnabled} from './developer-tools.mjs';
installEnglishValidation();
const $=id=>document.getElementById(id);
// The HTTP bridge exists only in the separate, loopback-only UI test harness.
const bridge=window.wallet??{request:async(method,args={})=>(await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json','X-SunPhi-Preview':'1'},body:JSON.stringify({method,args})})).json()};
let state={locked:true},reviewId=null,busy=false,workspace;
const money=n=>(n/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const labels={buyer:'Original depositor',seller:'Seller',supplier:'Supplier'};
let noticeTimer;
function clearNotice(){clearTimeout(noticeTimer);$('notice').replaceChildren();}
function scheduleNotice(){clearTimeout(noticeTimer);const notice=$('notice');if(!notice.classList.contains('error')&&notice.textContent&&!notice.matches(':hover,:focus-within'))noticeTimer=setTimeout(clearNotice,4000);}
function message(text,error=false){
  clearNotice();const notice=$('notice');notice.classList.toggle('error',error);notice.setAttribute('aria-atomic','true');
  if(!text)return;
  const icon=el('span',error?'!':'✓','notice-icon');icon.setAttribute('aria-hidden','true');
  notice.append(icon,el('span',text,'notice-text'));
  if(!error){const close=el('button','×','notice-close');close.type='button';close.setAttribute('aria-label','Dismiss notification');close.onclick=clearNotice;notice.append(close);scheduleNotice();}
}
$('notice').addEventListener('pointerenter',()=>clearTimeout(noticeTimer));
$('notice').addEventListener('pointerleave',scheduleNotice);
$('notice').addEventListener('focusin',()=>clearTimeout(noticeTimer));
$('notice').addEventListener('focusout',()=>queueMicrotask(scheduleNotice));
async function call(method,args={}){const r=await bridge.request(method,args);if(!r.ok)throw Error(r.error);return r.value;}
async function run(fn){if(busy)return;busy=true;document.body.setAttribute('aria-busy','true');try{await fn();}catch(e){const dialog=document.querySelector('dialog[open]');if(dialog){let error=dialog.querySelector('.dialog-error');if(!error){error=el('p',undefined,'dialog-error');error.setAttribute('role','alert');dialog.append(error);}error.textContent=e.message;error.scrollIntoView({block:'nearest'});}else message(e.message,true);}finally{busy=false;document.body.removeAttribute('aria-busy');}}
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function action(text,input){const b=el('button',text);b.addEventListener('click',()=>run(()=>prepare(input)));return b;}
function empty(parent,text){parent.replaceChildren(el('p',text,'empty'));}
function row(title,subtitle){const n=el('article',undefined,'record');n.append(el('h3',title,'record-title'),el('p',subtitle));return n;}
let currentTab='overview',navHistory=[];
const screens={
 overview:['Overview','Start the demonstration, inspect your holdings, then review a transfer. All amounts are fictional.'],
 portfolio:['Holdings','Check each asset’s balance, open Available operations to send or exchange tokens, and expand Issuer & terms for details.'],
 transitions:['Transfers & exchanges','1. Choose the asset and destination. 2. Enter the amount in its displayed unit. 3. Review the terms before confirming.'],
 activitynew:['Transaction history','See your transfers and exchanges here, including incoming assets. If confirmation is delayed, use Check status. Do not submit the transfer again.'],
 support:['Support','Record a local support draft with the operation reference. Drafts stay in your wallet and are not sent to a support team.'],
 security:['Security','Save an encrypted backup and manage your password here. To open another wallet or restore a backup, use Lock wallet first.'],
 legacy:['Technical tests · Create test units','1. Set up the test programme. 2. Create test units. 3. Open Test a payment. These test balances are separate from Holdings.'],
 'legacy-payments':['Technical tests · Test a payment','Enter a test quantity and review it. Then complete the recipient and test-bank confirmation steps beneath the form.'],
 'legacy-signing':['Technical tests · File signing','1. Confirm the fingerprint independently and import its trust file. 2. Import a signing package. 3. Review, sign and export the approval.'],
 'legacy-activity':['Technical tests · Test history','Inspect or export the historical test journal. Current procedure transfers are recorded in History.']
};
function selectTab(id,{back=false,reset=false}={}){
 if(state.locked||!screens[id]||(!developerToolsEnabled&&id.startsWith('legacy')))return;
 closeSelects();
 if(reset)navHistory=[];
 else if(!back&&id!==currentTab){navHistory.push({id:currentTab,y:window.scrollY});if(navHistory.length>40)navHistory.shift();}
 currentTab=id;
 reserveGuideSpace();
 document.querySelectorAll('.tab').forEach(n=>n.hidden=n.id!==id);
 document.querySelectorAll('[data-tab]').forEach(n=>{const active=n.dataset.tab===id||(n.closest('#workspace > nav')&&n.dataset.tab==='security'&&id.startsWith('legacy'));if(active)n.setAttribute('aria-current','page');else n.removeAttribute('aria-current');});
 $('screen-title').textContent=screens[id][0];$('screen-help').textContent=screens[id][1];
 $('nav-back').disabled=!navHistory.length;$('nav-home').hidden=id==='overview';
 document.title=screens[id][0]+' · SunPhi Wallet';
 const heading=$('screen-title');heading.focus({preventScroll:true});if(!back)window.scrollTo({top:0,behavior:'instant'});
}
function render(){
  workspace?.render(state);
  document.querySelectorAll('.brand-title').forEach(b=>b.disabled=state.locked);
  $('locked').hidden=!state.locked;$('workspace').hidden=state.locked;$('lock').hidden=state.locked;
  if(state.locked){navHistory=[];currentTab='overview';closeSelects();document.title='Open wallet · SunPhi Wallet';$('review').close();reviewId=null;$('public-key').value='';$('address').value='';$('password-form').reset();resetPasswordVisibility();for(const id of ['holdings','transfers','redemptions','history','packages','review-data'])$(id).replaceChildren();return;}
  $('profile-name').textContent=state.label;$('public-key').value=state.publicKey;$('address').value=state.address;
  $('trust-status').textContent=state.trust?`Pinned institution: ${state.trust.issuer.bankId} · Fingerprint ${state.trust.fingerprint}`:'No institution trust imported.';
  $('import-package').disabled=!state.trust;
  $('demo-start').hidden=!!state.demo;$('issue-panel').hidden=!state.demo;
  const needsUnits=!state.demo||state.demo.issued===0;
  $('legacy-payment-gate').hidden=!needsUnits;
  $('legacy-payment-gate').querySelector('h2').textContent=state.demo?'Create test units first':'Start the deposit test first';
  $('legacy-payment-gate').querySelector('p').textContent=state.demo?'The test programme is ready. Create test units before attempting a payment or redemption.':'Set up a separate test programme, then create test units. This does not change your wallet holdings.';
  $('legacy-payment-gate').querySelector('[data-action=start]').hidden=!!state.demo;
  $('legacy-create-units').hidden=!state.demo;
  $('legacy-payments').querySelector('.grid').hidden=needsUnits;
  $('legacy-payment-balances').hidden=needsUnits;
  if(!needsUnits)$('legacy-payment-balances').textContent='Available test units — Original depositor: '+money(state.demo.balances.buyer.available)+' · Seller: '+money(state.demo.balances.seller.available)+' · Supplier: '+money(state.demo.balances.supplier.available)+'. Transfers use the original depositor’s balance; redemption uses the selected holder’s balance.';
  if(!$('legacy-payment-gate').hidden){$('transfers').closest('.panel').hidden=true;$('redemptions').closest('.panel').hidden=true;}else{$('transfers').closest('.panel').hidden=false;$('redemptions').closest('.panel').hidden=false;}
  $('holdings').replaceChildren();
  if(state.demo){const d=state.demo,b=d.balances.buyer,p=el('div',undefined,'panel');p.append(el('p',`${d.issuer} / ${d.programme}`,'eyebrow'),el('h2','Rose sun(φ) · Test deposit holdings'));
    const grid=el('div',undefined,'metrics');for(const [name,value,hint] of [['Available',b.available,'Spendable test units'],['Reserved',b.reserved+b.redeeming,'Transfer or redemption pending'],['Income accrued',b.interestCents,'Test USD · not a spendable token balance']]){const box=el('div',undefined,'metric');box.append(el('small',name),el('strong',money(value)),el('span',hint));grid.append(box);}p.append(grid,el('p',`Income basis: ${money(b.interestPrincipal)} USD · Simulated day ${Math.floor(d.clock/86400000)}. Seller: ${money(d.balances.seller.available)} available; supplier: ${money(d.balances.supplier.available)} available.`, 'muted'));if(d.transfers.some(t=>t.deliveryStatus==='unknown'))p.append(el('div','Outcome unknown. The original instruction may have executed. Query it below; do not send another payment.','callout'));$('holdings').append(p);
  }
  for(const [formId,enabled] of [['issue-form',!!state.demo],['transfer-form',!!state.demo],['redeem-form',!!state.demo]])for(const n of $(formId).elements)n.disabled=!enabled;
  if(!$('screen-title').textContent)selectTab('overview',{reset:true});
  renderPayments();renderPackages();const history=$('history');history.replaceChildren();
  for(const item of state.demo?.history??[]){const n=row(`${item.type} · ${labels[item.actor]??'Test bank'}`,`Sequence ${item.sequence??'—'} · Test day ${Math.floor(item.at/86400000)}`);n.append(el('code',JSON.stringify(item)));history.append(n);}
  if(!history.children.length)empty(history,'No local test operations yet.');
}
function renderPayments(){const transfers=$('transfers'),redemptions=$('redemptions');transfers.replaceChildren();redemptions.replaceChildren();for(const t of state.demo?.transfers??[]){const n=row(`${money(t.amount)} Rose units → ${labels[t.recipient]}`,`Instruction ${t.id}`);n.append(el('p',t.deliveryStatus,'status'));const a=el('div',undefined,'actions');if(t.deliveryStatus==='unknown')a.append(action('Check status',{kind:'reconcile',transferId:t.id}));else if(t.status==='reserved'){if(!t.receiptId)a.append(action('Test recipient: acknowledge receipt',{kind:'receive',transferId:t.id}));else a.append(action('Test bank: confirm settlement',{kind:'settle',transferId:t.id,loseReply:false}));a.append(action('Test bank: cancel reservation',{kind:'cancel',transferId:t.id}));}n.append(a);transfers.append(n);}if(!transfers.children.length)empty(transfers,'No transfer instructions.');for(const r of state.demo?.redemptions??[]){const n=row(`${money(r.amount)} units · ${labels[r.owner]}`,`Redemption ${r.id}`);n.append(el('p',r.status,'status'));if(r.status==='pending')n.append(action('Test bank: confirm payout',{kind:'payout',redemptionId:r.id}));redemptions.append(n);}if(!redemptions.children.length)empty(redemptions,'No redemption requests.');}
function renderPackages(){const parent=$('packages');parent.replaceChildren();for(const p of state.packages){const n=el('div',undefined,'panel');n.append(el('h2',p.kind==='consent'?'Consent proposal':'Key enrolment challenge'),el('p',`Assigned actor: ${p.actorId}`),el('code',p.id));const a=el('div',undefined,'actions');a.append(action('Review & sign',{kind:'sign',packageId:p.id}));if(state.signed.some(s=>s.id===p.id)){const b=el('button','Export signed approval');b.onclick=()=>run(async()=>{if(await call('export-approval',{id:p.id}))message('Signed public approval exported. No private key was exported.');});a.append(b);}n.append(a);parent.append(n);}if(!parent.children.length)empty(parent,'No signing packages imported.');}
async function refresh(){const wasLocked=state.locked;state=await call('status');if(state.locked&&!wasLocked)setAccessMode('open');if(!state.locked)state.procedural=await call('procedure-status');render();if(state.locked&&!wasLocked)await resumeLastWallet();}
async function prepare(input){
  message('');const r=await call('prepare',input),d=r.details;reviewId=r.id;
  const reviewNames={start:'Set up the test programme',advance:'Advance the laboratory clock',issue:'Review test issuance',transfer:'Review test transfer',redeem:'Review test redemption',receive:'Acknowledge test receipt',settle:'Confirm test settlement',cancel:'Cancel the test reservation',payout:'Confirm test payout',reconcile:'Query the original test instruction',sign:'Review signing authority'};
  $('review-title').textContent=reviewNames[input.kind]||'Review instruction';
  $('review-mode').textContent=d.environment;$('review-data').textContent=JSON.stringify(d,null,2);const summary=$('review-summary');summary.replaceChildren();
  if(input.kind==='start')summary.append(el('p','Create a separate fictional deposit programme in this wallet. No real money is issued and your procedure holdings are unchanged. You can return to Overview at any time.'));
  if(input.kind==='advance')summary.append(el('p','Move the legacy fixture clock forward by 30 days to inspect its test income calculation. The computer clock and procedure laboratory are unchanged.'));
  if(d.kind==='issue')summary.append(el('p',`Principal: ${money(d.principalMinor)} USD · Fee: ${money(d.feeMinor)} USD · Total test payment: ${money(d.totalMinor)} USD`));
  if(d.amountMinor)summary.append(el('p',`Amount: ${money(d.amountMinor)} Rose units · ${d.recipient?'Recipient: '+labels[d.recipient]:'Holder: '+labels[d.owner]}`));
  if(d.transfer)summary.append(el('p',`Amount: ${money(d.transfer.amount)} Rose units · From ${labels[d.transfer.owner]} to ${labels[d.transfer.recipient]}`));
  if(d.redemption)summary.append(el('p',`Payout principal: ${money(d.redemption.amount)} USD · Holder: ${labels[d.redemption.owner]}`));
  if(d.kind==='sign'){const p=d.verified,s=p.snapshot;summary.append(el('p',`Assigned actor: ${d.actorId} · Institution: ${(s?.issuer??p.issuer).bankId}`));if(s){summary.append(el('p',`Amount: ${money(s.terms.amount)} ${s.terms.currency} · Case: ${s.terms.caseId}`));for(const c of s.terms.conditions)summary.append(el('p',`${c.label}: ${c.evidenceRequirement}`));}else summary.append(el('p',`Verify preassigned key for role: ${p.role} · Case: ${p.caseId}`));summary.append(el('p','Check the complete instruction and technical terms below before signing.'));$('review').querySelector('details').open=true;}
  else $('review').querySelector('details').open=false;
  $('review').showModal();
}
async function access(method){
 clearAccessError();
 const password=$('password').value,label=$('label').value;
 if(method!=='create'&&!selectedWallet){showAccessError('Choose your wallet file first.');return;}
 if(password.length<12){showAccessError('Enter a password of at least 12 characters.','password');return;}
 if(method==='create'&&password!==$('repeat').value){showAccessError('The passwords do not match. Enter the same password in both fields.','repeat');return;}
 const submit=$('access').querySelector('[type=submit]');submit.disabled=true;submit.textContent=method==='create'?'Creating wallet…':method==='restore'?'Restoring backup…':'Opening wallet…';
 try{
  const v=await call(method,{password,label,selectionId:selectedWallet?.id});
  if(v){await refresh();selectTab('overview',{reset:true});setAccessMode('open');message(v.rememberWarning?'Wallet opened, but its location could not be saved on this computer.':method==='create'?'Wallet created. Save an encrypted backup in Security.':method==='restore'?'Backup restored to a new wallet file.':'Wallet opened.');}
  else{accessHelp.textContent=method==='create'?'Saving was cancelled. Your wallet has not been created. You can try again.':'Saving was cancelled. Your backup is unchanged. You can try again.';}
 }catch(e){
  let text=e.message;
  if(/Wrong password|authentication failed/.test(text))text='Could not unlock this file. Check its password and try again. If it still fails, the file may be damaged.';
  else if(/ENOENT/.test(text))text='The selected file is no longer available. Choose the wallet file again.';
  else if(/JSON|Unexpected token|Unexpected end|Expected a wallet|Choose a SunPhi|Invalid.*(vault|workspace)|Unexpected.*(key|field)/i.test(text))text='This file could not be read as a SunPhi wallet. Choose the correct wallet file or an intact backup.';
  showAccessError(text,'password');
 }finally{$('password').value='';$('repeat').value='';resetPasswordVisibility();renderAccess();}
}

workspace=installWorkspace({call,run,message,selectTab,refresh});
const navigation=el('div',undefined,'navigation-bar'),backButton=el('button','← Back'),homeButton=el('button','Wallet overview'),title=el('h2');
backButton.id='nav-back';backButton.disabled=true;homeButton.id='nav-home';title.id='screen-title';title.tabIndex=-1;
navigation.append(backButton,homeButton,title);document.querySelector('#workspace > nav').after(navigation);
const help=el('p',undefined,'screen-help');help.id='screen-help';navigation.after(help);
// Reserve the tallest screen explanation at this width, not just the current text.
// This keeps every laboratory subnav in the same position without clipping copy.
const measure=el('div',undefined,'guide-measure');measure.setAttribute('aria-hidden','true');
for(const [,copy] of Object.values(screens)){const p=el('p',copy,'guide-line');measure.append(p);}
measure.append(el('p',screens['legacy-payments'][1],'guide-line'));
navigation.after(measure);
function reserveGuideSpace(){if(state.locked)return;const height=Math.ceil(Math.max(...[...measure.children].map(p=>p.getBoundingClientRect().height)));help.style.minHeight=height+'px';}
new ResizeObserver(reserveGuideSpace).observe(measure);document.fonts.ready.then(reserveGuideSpace);
backButton.onclick=()=>{const previous=navHistory.pop();if(previous){selectTab(previous.id,{back:true});window.scrollTo({top:previous.y,behavior:'instant'});}};
homeButton.onclick=()=>selectTab('overview');
document.querySelectorAll('select:not([data-enhanced])').forEach(enhanceSelect);
for(const dialog of document.querySelectorAll('dialog')){const cancel=el('button','Back to editing');cancel.type='button';cancel.onclick=()=>dialog.close();dialog.append(cancel);dialog.addEventListener('close',()=>dialog.querySelector('.dialog-error')?.remove());}
let accessMode='open',selectedWallet=null,missingWallet=null;
const accessModes=el('div',undefined,'actions access-modes');
for(const [mode,label] of [['open','Open existing'],['create','Create new'],['restore','Restore backup']]){
 const b=el('button',label);b.type='button';b.dataset.mode=mode;
 b.onclick=()=>run(async()=>{setAccessMode(mode);await call('clear-wallet-selection');if(mode==='open'){if(!await resumeLastWallet())await chooseWallet();}else if(mode==='restore')await chooseWallet();});
 accessModes.append(b);
}
$('access').before(accessModes);
const accessHelp=el('p',undefined,'muted');accessModes.after(accessHelp);
const accessError=el('p',undefined,'access-error');accessError.id='access-error';accessError.setAttribute('role','alert');accessError.hidden=true;
$('password').closest('label').after(accessError);
const passwordControls=[];
for(const input of document.querySelectorAll('input[type=password]')){
 const caption=input.closest('label').textContent.trim().toLowerCase();
 input.setAttribute('aria-label',input.closest('label').textContent.trim());
 if(!input.id)input.id='security-'+input.name;
 const field=el('span',undefined,'password-field'),toggle=el('button',undefined,'password-toggle');
 toggle.type='button';toggle.setAttribute('aria-controls',input.id);
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
 svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
 for(const d of ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z','M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0']){
  const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',d);svg.append(path);
 }
 const slash=document.createElementNS(svg.namespaceURI,'path');slash.setAttribute('d','M3 3l18 18');svg.append(slash);toggle.append(svg);
 const setVisible=visible=>{
  input.type=visible?'text':'password';slash.style.display=visible?'':'none';
  toggle.setAttribute('aria-label',(visible?'Hide ':'Show ')+caption);
  toggle.setAttribute('aria-pressed',String(visible));toggle.title=(visible?'Hide ':'Show ')+caption;
 };
 toggle.onclick=()=>setVisible(input.type==='password');
 input.before(field);field.append(input,toggle);setVisible(false);
 passwordControls.push({input,setVisible});
}
function resetPasswordVisibility(){for(const control of passwordControls)control.setVisible(false);}
function clearAccessError(){accessError.hidden=true;accessError.textContent='';for(const id of ['password','repeat'])$(id).removeAttribute('aria-invalid');}
function showAccessError(text,field){accessError.textContent=text;accessError.hidden=false;if(field){$(field).setAttribute('aria-invalid','true');$(field).focus();}}
$('password').addEventListener('input',clearAccessError);$('repeat').addEventListener('input',clearAccessError);
const accessBack=el('button','Back');accessBack.type='button';accessBack.onclick=()=>run(async()=>{await call('clear-wallet-selection');setAccessMode('open');chooseFile.focus();});
$('access').querySelector('.actions').append(accessBack);
const recoveryHelp=el('details');recoveryHelp.append(el('summary','Forgot your password?'),el('p','SunPhi cannot reset the password of an encrypted wallet. If you have a backup and know its password, choose Restore backup. A backup with the same forgotten password cannot unlock your wallet.'));
$('access').after(recoveryHelp);
const selectedFile=el('div',undefined,'selected-wallet'),fileName=el('strong'),fileDirectory=el('small'),chooseFile=el('button');
fileName.id='selected-wallet-name';fileDirectory.id='selected-wallet-directory';
selectedFile.setAttribute('aria-live','polite');chooseFile.type='button';chooseFile.onclick=()=>run(chooseWallet);
selectedFile.append(fileName,fileDirectory,chooseFile);$('access').prepend(selectedFile);
$('password').setAttribute('aria-describedby','selected-wallet-name selected-wallet-directory access-error');
$('access').querySelector('p.muted').textContent='A backup and its password are both needed for recovery. There is no password reset service.';
function renderAccess(){
 const creating=accessMode==='create',ready=creating||!!selectedWallet;
 selectedFile.hidden=creating;accessBack.hidden=!creating&&!selectedWallet;
 $('access-title').textContent={open:selectedWallet?'Unlock your wallet':'Open your wallet',create:'Create a new wallet',restore:selectedWallet?'Restore this backup':'Restore a backup'}[accessMode];
 $('password-label').textContent=creating?'Create password':accessMode==='restore'?'Backup password':'Wallet password';
 $('password').setAttribute('aria-label',$('password-label').textContent);
 $('password').autocomplete=creating?'new-password':'current-password';$('repeat').autocomplete='new-password';
 $('label').required=creating;
 fileName.textContent=selectedWallet?.name||missingWallet?.name||(accessMode==='restore'?'No backup selected':'No wallet selected');
 fileDirectory.textContent=selectedWallet?.directory||missingWallet?.directory||'';
 chooseFile.textContent=missingWallet?'Locate wallet file':selectedWallet?'Choose another file':accessMode==='restore'?'Choose backup file':'Choose wallet file';
 $('password').closest('label').hidden=!ready;$('password').disabled=!ready;
 const submit=$('access').querySelector('[type=submit]');
 submit.hidden=!ready;submit.disabled=!ready;
 submit.textContent={open:'Unlock selected wallet',create:'Create encrypted wallet',restore:'Restore selected backup'}[accessMode];
}
async function resumeLastWallet(){
 const previous=await call('last-wallet');
 if(!previous)return false;
 selectedWallet=previous.missing?null:previous;missingWallet=previous.missing?previous:null;
 renderAccess();
 accessHelp.textContent=previous.missing?'Your last wallet file is unavailable. Locate it or choose another wallet.':'Your last opened wallet is selected. Enter its password, or choose another file.';
 if(selectedWallet)$('password').focus();
 return true;
}
async function chooseWallet(){
 selectedWallet=null;missingWallet=null;$('password').value='';clearAccessError();resetPasswordVisibility();clearNotice();renderAccess();
 chooseFile.disabled=true;chooseFile.textContent='Choosing file…';
 try{selectedWallet=await call('select-wallet',{mode:accessMode});}catch(e){showAccessError(e.message);}finally{chooseFile.disabled=false;renderAccess();}
 if(selectedWallet)$('password').focus();else chooseFile.focus();
}
function setAccessMode(mode){
 accessMode=mode;selectedWallet=null;$('password').value='';$('repeat').value='';clearAccessError();resetPasswordVisibility();clearNotice();
 accessModes.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));
 $('label').closest('label').hidden=mode!=='create';$('repeat').closest('label').hidden=mode!=='create';$('repeat').required=mode==='create';
 $('create').hidden=true;$('restore').hidden=true;
 accessHelp.textContent={open:'Choose your wallet file first, then enter the password for the file shown below.',create:'Choose a name and a password of at least 12 characters. You will choose where to save the new file.',restore:'Choose your encrypted backup first, then enter its password. You will save a restored copy under a new filename.'}[mode];
 renderAccess();
}
setAccessMode('open');
$('access').onsubmit=e=>{e.preventDefault();run(()=>access(accessMode));};$('create').onclick=()=>run(()=>access('create'));$('restore').onclick=()=>run(()=>access('restore'));
$('lock').onclick=()=>run(async()=>{state=await call('lock');setAccessMode('open');render();await resumeLastWallet();message('Wallet locked.');});bridge.onLock?.(()=>run(async()=>{await refresh();if(state.locked){setAccessMode('open');await resumeLastWallet();}}));
$('theme').onclick=()=>{const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=theme;try{localStorage.setItem('sunphi-wallet-theme',theme);}catch{}$('theme').setAttribute('aria-label',`Switch to ${theme==='dark'?'light':'dark'} theme`);};
document.querySelectorAll('[data-tab]').forEach(n=>n.onclick=()=>selectTab(n.dataset.tab));document.querySelectorAll('[data-action]').forEach(n=>n.onclick=()=>run(()=>prepare({kind:n.dataset.action})));
for(const kind of ['issue','transfer','redeem'])$(`${kind}-form`).onsubmit=e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget));run(()=>prepare({kind,...data}));};
$('confirm').onclick=()=>run(async()=>{const id=reviewId;reviewId=null;$('confirm').disabled=true;try{const r=await call('confirm',{id});$('review').close();await refresh();message(r.signed?'Approval signed locally. Export the public approval to the institution workflow.':'Test instruction recorded.');}finally{$('confirm').disabled=false;}});
$('backup').onclick=()=>run(async()=>{if(await call('backup'))message('Encrypted backup saved. Keep its password separately.');});
$('statement').onclick=()=>run(async()=>{if(await call('statement'))message('Test statement exported.');});
$('trust').onclick=()=>run(async()=>{await call('import-trust',{fingerprint:$('fingerprint').value.trim()});await refresh();});
$('import-package').onclick=()=>run(async()=>{await call('import-package');await refresh();});
$('password-form').onsubmit=e=>{e.preventDefault();run(async()=>{const data=Object.fromEntries(new FormData(e.target));try{if(data.newPassword!==data.repeat)throw Error('New passwords do not match.');await call('password',{oldPassword:data.oldPassword,newPassword:data.newPassword});message('Password changed. Create a new backup; older backups retain their old password.');}finally{e.target.reset();resetPasswordVisibility();}});};
setInterval(()=>{if(!busy&&!state.locked)run(async()=>{try{if(state.procedural?.connected)await call('procedure',{action:'sync',input:{}});}finally{await refresh();}});},5000);
run(async()=>{await refresh();if(state.locked)await resumeLastWallet();});
