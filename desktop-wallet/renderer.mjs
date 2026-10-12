const $=id=>document.getElementById(id);
// The HTTP bridge exists only in the separate, loopback-only UI test harness.
const bridge=window.wallet??{request:async(method,args={})=>(await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json','X-SunPhi-Preview':'1'},body:JSON.stringify({method,args})})).json()};
let state={locked:true},reviewId=null,busy=false;
const money=n=>(n/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const labels={buyer:'Original depositor',seller:'Seller',supplier:'Supplier'};
function message(text,error=false){$('notice').textContent=text;$('notice').classList.toggle('error',error);}
async function call(method,args={}){const r=await bridge.request(method,args);if(!r.ok)throw Error(r.error);return r.value;}
async function run(fn){if(busy)return;busy=true;document.body.setAttribute('aria-busy','true');try{await fn();}catch(e){message(e.message,true);}finally{busy=false;document.body.removeAttribute('aria-busy');}}
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function action(text,input){const b=el('button',text);b.addEventListener('click',()=>run(()=>prepare(input)));return b;}
function empty(parent,text){parent.replaceChildren(el('p',text,'empty'));}
function row(title,subtitle){const n=el('article',undefined,'record');n.append(el('h3',title),el('p',subtitle));return n;}
function selectTab(id){document.querySelectorAll('.tab').forEach(n=>n.hidden=n.id!==id);document.querySelectorAll('[data-tab]').forEach(n=>{if(n.dataset.tab===id)n.setAttribute('aria-current','page');else n.removeAttribute('aria-current');});}
function render(){
  $('locked').hidden=!state.locked;$('workspace').hidden=state.locked;$('lock').hidden=state.locked;
  if(state.locked){$('review').close();reviewId=null;$('public-key').value='';$('address').value='';$('password-form').reset();for(const id of ['holdings','transfers','redemptions','history','packages','review-data'])$(id).replaceChildren();return;}
  $('profile-name').textContent=state.label;$('public-key').value=state.publicKey;$('address').value=state.address;
  $('trust-status').textContent=state.trust?`Pinned institution: ${state.trust.issuer.bankId} · Fingerprint ${state.trust.fingerprint}`:'No institution trust imported.';
  $('import-package').disabled=!state.trust;
  $('demo-start').hidden=!!state.demo;$('issue-panel').hidden=!state.demo;
  $('holdings').replaceChildren();
  if(state.demo){const d=state.demo,b=d.balances.buyer,p=el('div',undefined,'panel');p.append(el('p',`${d.issuer} / ${d.programme}`,'eyebrow'),el('h2','Rose sun(φ) · Test deposit holdings'));
    const grid=el('div',undefined,'metrics');for(const [name,value,hint] of [['Available',b.available,'Spendable test units'],['Reserved',b.reserved+b.redeeming,'Transfer or redemption pending'],['Income accrued',b.interestCents,'Test USD · not a spendable token balance']]){const box=el('div',undefined,'metric');box.append(el('small',name),el('strong',money(value)),el('span',hint));grid.append(box);}p.append(grid,el('p',`Income basis: ${money(b.interestPrincipal)} USD · Simulated day ${Math.floor(d.clock/86400000)}. Seller: ${money(d.balances.seller.available)} available; supplier: ${money(d.balances.supplier.available)} available.`, 'muted'));if(d.transfers.some(t=>t.deliveryStatus==='unknown'))p.append(el('div','Outcome unknown. The original instruction may have executed. Query it below; do not send another payment.','callout'));$('holdings').append(p);
  }
  for(const [formId,enabled] of [['issue-form',!!state.demo],['transfer-form',!!state.demo],['redeem-form',!!state.demo]])for(const n of $(formId).elements)n.disabled=!enabled;
  renderPayments();renderPackages();const history=$('history');history.replaceChildren();
  for(const item of state.demo?.history??[]){const n=row(`${item.type} · ${labels[item.actor]??'Test bank'}`,`Sequence ${item.sequence??'—'} · Test day ${Math.floor(item.at/86400000)}`);n.append(el('code',JSON.stringify(item)));history.append(n);}
  if(!history.children.length)empty(history,'No local test operations yet.');
}
function renderPayments(){const transfers=$('transfers'),redemptions=$('redemptions');transfers.replaceChildren();redemptions.replaceChildren();for(const t of state.demo?.transfers??[]){const n=row(`${money(t.amount)} Rose units → ${labels[t.recipient]}`,`Instruction ${t.id}`);n.append(el('p',t.deliveryStatus,'status'));const a=el('div',undefined,'actions');if(t.deliveryStatus==='unknown')a.append(action('Query original outcome',{kind:'reconcile',transferId:t.id}));else if(t.status==='reserved'){if(!t.receiptId)a.append(action('Test recipient: acknowledge receipt',{kind:'receive',transferId:t.id}));else a.append(action('Test bank: confirm settlement',{kind:'settle',transferId:t.id,loseReply:false}),action('Test bank: simulate lost reply',{kind:'settle',transferId:t.id,loseReply:true}));a.append(action('Test bank: cancel reservation',{kind:'cancel',transferId:t.id}));}n.append(a);transfers.append(n);}if(!transfers.children.length)empty(transfers,'No transfer instructions.');for(const r of state.demo?.redemptions??[]){const n=row(`${money(r.amount)} units · ${labels[r.owner]}`,`Redemption ${r.id}`);n.append(el('p',r.status,'status'));if(r.status==='pending')n.append(action('Test bank: confirm payout',{kind:'payout',redemptionId:r.id}));redemptions.append(n);}if(!redemptions.children.length)empty(redemptions,'No redemption requests.');}
function renderPackages(){const parent=$('packages');parent.replaceChildren();for(const p of state.packages){const n=el('div',undefined,'panel');n.append(el('h2',p.kind==='consent'?'Consent proposal':'Key enrolment challenge'),el('p',`Assigned actor: ${p.actorId}`),el('code',p.id));const a=el('div',undefined,'actions');a.append(action('Review & sign',{kind:'sign',packageId:p.id}));if(state.signed.some(s=>s.id===p.id)){const b=el('button','Export signed approval');b.onclick=()=>run(async()=>{if(await call('export-approval',{id:p.id}))message('Signed public approval exported. No private key was exported.');});a.append(b);}n.append(a);parent.append(n);}if(!parent.children.length)empty(parent,'No signing packages imported.');}
async function refresh(){state=await call('status');render();}
async function prepare(input){
  message('');const r=await call('prepare',input),d=r.details;reviewId=r.id;
  $('review-title').textContent=input.kind==='sign'?'Review signing authority':`Review ${input.kind}`;
  $('review-mode').textContent=d.environment;$('review-data').textContent=JSON.stringify(d,null,2);const summary=$('review-summary');summary.replaceChildren();
  if(d.kind==='issue')summary.append(el('p',`Principal: ${money(d.principalMinor)} USD · Fee: ${money(d.feeMinor)} USD · Total test payment: ${money(d.totalMinor)} USD`));
  if(d.amountMinor)summary.append(el('p',`Amount: ${money(d.amountMinor)} Rose units · ${d.recipient?'Recipient: '+labels[d.recipient]:'Holder: '+labels[d.owner]}`));
  if(d.transfer)summary.append(el('p',`Amount: ${money(d.transfer.amount)} Rose units · From ${labels[d.transfer.owner]} to ${labels[d.transfer.recipient]}`));
  if(d.redemption)summary.append(el('p',`Payout principal: ${money(d.redemption.amount)} USD · Holder: ${labels[d.redemption.owner]}`));
  if(d.kind==='sign'){const p=d.verified,s=p.snapshot;summary.append(el('p',`Assigned actor: ${d.actorId} · Institution: ${(s?.issuer??p.issuer).bankId}`));if(s){summary.append(el('p',`Amount: ${money(s.terms.amount)} ${s.terms.currency} · Case: ${s.terms.caseId}`));for(const c of s.terms.conditions)summary.append(el('p',`${c.label}: ${c.evidenceRequirement}`));}else summary.append(el('p',`Verify preassigned key for role: ${p.role} · Case: ${p.caseId}`));summary.append(el('p','Check the complete instruction and technical terms below before signing.'));$('review').querySelector('details').open=true;}
  else $('review').querySelector('details').open=false;
  $('review').showModal();
}
async function access(method){const password=$('password').value,label=$('label').value;if(password.length<12)throw Error('Enter a password of at least 12 characters.');if(method==='create'&&password!==$('repeat').value)throw Error('Passwords do not match.');try{const v=await call(method,{password,label});if(v){state=v;render();message(method==='create'?'Wallet created. Save a separate encrypted backup from Security & recovery.':'Wallet opened.');}}finally{$('password').value='';$('repeat').value='';}}
$('access').onsubmit=e=>{e.preventDefault();run(()=>access('open'));};$('create').onclick=()=>run(()=>access('create'));$('restore').onclick=()=>run(()=>access('restore'));
$('lock').onclick=()=>run(async()=>{state=await call('lock');render();message('Wallet locked.');});bridge.onLock?.(()=>run(refresh));
$('theme').onclick=()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';};
document.querySelectorAll('[data-tab]').forEach(n=>n.onclick=()=>selectTab(n.dataset.tab));document.querySelectorAll('[data-action]').forEach(n=>n.onclick=()=>run(()=>prepare({kind:n.dataset.action})));
for(const kind of ['issue','transfer','redeem'])$(`${kind}-form`).onsubmit=e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget));run(()=>prepare({kind,...data}));};
$('confirm').onclick=()=>run(async()=>{const id=reviewId;reviewId=null;$('confirm').disabled=true;try{const r=await call('confirm',{id});state=r.view;$('review').close();render();message(r.signed?'Approval signed locally. Export the public approval to the institution workflow.':'Test instruction recorded.');}finally{$('confirm').disabled=false;}});
$('backup').onclick=()=>run(async()=>{if(await call('backup'))message('Encrypted backup saved. Keep its password separately.');});
$('statement').onclick=()=>run(async()=>{if(await call('statement'))message('Test statement exported.');});
$('trust').onclick=()=>run(async()=>{await call('import-trust',{fingerprint:$('fingerprint').value.trim()});await refresh();});
$('import-package').onclick=()=>run(async()=>{await call('import-package');await refresh();});
$('password-form').onsubmit=e=>{e.preventDefault();run(async()=>{const data=Object.fromEntries(new FormData(e.target));try{if(data.newPassword!==data.repeat)throw Error('New passwords do not match.');await call('password',{oldPassword:data.oldPassword,newPassword:data.newPassword});message('Password changed. Create a new backup; older backups retain their old password.');}finally{e.target.reset();}});};
setInterval(()=>{if(!busy&&!state.locked)run(refresh);},10000);
run(refresh);
