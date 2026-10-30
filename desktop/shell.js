(()=>{
 const coin=location.pathname.includes('/coin/'),base=coin?'../../':'';
 let changing=false;
 const statusArea=header=>{
  if(document.getElementById('wallet-status'))return;
  const notice=document.getElementById('notice');if(!notice)return;
  const area=document.createElement('section');area.id='wallet-status';area.setAttribute('aria-label','Wallet notifications');
  const lane=document.createElement('div');lane.className='status-content';
  const navigation=document.createElement('div');navigation.id='navigation-notice';navigation.hidden=true;
  const message=document.createElement('span');message.id='navigation-message';message.setAttribute('role','status');message.setAttribute('aria-live','polite');
  const cancel=document.createElement('button');cancel.id='cancel-navigation';cancel.textContent='Cancel switch';cancel.hidden=true;
  cancel.onclick=()=>window.sunphiShell.request('cancel-navigation');navigation.append(message,cancel);
  notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');notice.tabIndex=0;
  lane.append(notice,navigation);area.append(lane);header.after(area);
 };
 const change=async direction=>{
  if(changing||direction===(coin?'coin':'network'))return;
  changing=true;window.sunphiNavigationPending=true;
  const area=document.getElementById('wallet-status'),nav=document.getElementById('navigation-notice'),message=document.getElementById('navigation-message'),cancel=document.getElementById('cancel-navigation'),main=document.querySelector('main');
  area.dataset.navigation='true';nav.hidden=false;message.textContent='Preparing to switch…';main.inert=true;
  const poll=async()=>{try{const r=await window.sunphiShell.request('navigation-status');if(changing&&r.ok&&r.value.pending){message.textContent=r.value.message;cancel.hidden=!r.value.cancellable;}}catch{}};
  const timer=setInterval(poll,250);const cleanup=()=>clearInterval(timer);window.addEventListener('pagehide',cleanup,{once:true});
  try{const r=await window.sunphiShell.request('direction',{direction});if(!r.ok&&!r.cancelled){const n=document.getElementById('notice');n.hidden=false;n.classList.remove('history-check');n.classList.add('error');n.textContent=r.error;}}
  catch{const n=document.getElementById('notice');n.hidden=false;n.classList.add('error');n.textContent='The screen could not be opened. Please try again.';}
  finally{cleanup();window.removeEventListener('pagehide',cleanup);changing=false;window.sunphiNavigationPending=false;main.inert=false;delete area.dataset.navigation;nav.hidden=true;cancel.hidden=true;}
 };
 const apply=()=>{const header=document.querySelector('body>header');if(!header)return;
 statusArea(header);
 const brand=header.querySelector('.brand,.wallet-brand');if(brand&&!brand.dataset.unified){brand.dataset.unified='true';brand.className='brand';brand.replaceChildren();const img=document.createElement('img');img.src=base+'node-brand.png';img.alt='';const word=document.createElement('span');word.className='brand-word';word.textContent='SunPhi';const sub=document.createElement('small');sub.textContent='WALLET';word.append(sub);brand.append(img,word);}
 if(header.querySelector('.wallet-directions'))return;
 const nav=document.createElement('div');nav.className='wallet-directions';nav.setAttribute('role','group');nav.setAttribute('aria-label','Wallet direction');
 const add=(name,direction)=>{const b=document.createElement('button');b.textContent=name;b.dataset.direction=direction;b.setAttribute('aria-pressed',String(direction===(coin?'coin':'network')));b.onclick=()=>change(direction);nav.append(b);};
 add('Coin','coin');add('Network','network');header.insertBefore(nav,header.querySelector('.header-actions'));
 window.sunphiChromeReady=window.sunphiShell?.request('edition').then(r=>{if(r.value)add('Back to node','node');}).catch(()=>{});
 };
 try{document.documentElement.dataset.theme=localStorage.getItem('sunphi-wallet-theme')==='light'?'light':'dark';}catch{}
 apply();new MutationObserver(apply).observe(document.body,{childList:true,subtree:true});
 let last=0;for(const event of ['pointerdown','keydown','wheel'])document.addEventListener(event,()=>{if(Date.now()-last<10000)return;last=Date.now();window.sunphiShell?.request('activity').catch(()=>{});},{passive:true});
})();
