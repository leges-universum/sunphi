(()=>{
 const coin=location.pathname.includes('/coin/'),base=coin?'../../':'';
 const apply=()=>{const header=document.querySelector('body>header');if(!header)return;
 const brand=header.querySelector('.brand,.wallet-brand');if(brand&&!brand.dataset.unified){brand.dataset.unified='true';brand.className='brand';brand.replaceChildren();const img=document.createElement('img');img.src=base+'node-brand.png';img.alt='';const word=document.createElement('span');word.className='brand-word';word.textContent='SunPhi';const sub=document.createElement('small');sub.textContent='WALLET';word.append(sub);brand.append(img,word);}
 if(header.querySelector('.wallet-directions'))return;
 const nav=document.createElement('div');nav.className='wallet-directions';nav.setAttribute('role','group');nav.setAttribute('aria-label','Wallet direction');
 const add=(name,direction)=>{const b=document.createElement('button');b.textContent=name;b.dataset.direction=direction;b.setAttribute('aria-pressed',String(direction===(coin?'coin':'network')));b.onclick=async()=>{if(direction===(coin?'coin':'network'))return;b.disabled=true;try{let r;for(let attempt=0;attempt<12;attempt++){r=await window.sunphiShell.request('direction',{direction});if(r.ok||!r.error?.startsWith('Wait for'))break;await new Promise(resolve=>setTimeout(resolve,100));}if(!r.ok){const n=document.getElementById('notice');n.hidden=false;n.textContent=r.error;}}finally{b.disabled=false;}};nav.append(b);};
 add('Coin','coin');add('Network','network');header.insertBefore(nav,header.querySelector('.header-actions'));
 window.sunphiShell?.request('edition').then(r=>{if(r.value)add('Back to node','node');}).catch(()=>{});
 };
 try{document.documentElement.dataset.theme=localStorage.getItem('sunphi-wallet-theme')==='light'?'light':'dark';}catch{}
 apply();new MutationObserver(apply).observe(document.body,{childList:true,subtree:true});
 let last=0;for(const event of ['pointerdown','keydown','wheel'])document.addEventListener(event,()=>{if(Date.now()-last<10000)return;last=Date.now();window.sunphiShell?.request('activity').catch(()=>{});},{passive:true});
})();
