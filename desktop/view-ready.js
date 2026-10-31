// First paint waits for the restored entry state, shared chrome and offline fonts.
document.documentElement.dataset.viewPending='true';
window.sunphiViewReady=new Promise(resolve=>{
 window.addEventListener('sunphi:entry-ready',async()=>{
  await window.sunphiChromeReady;
  const footer=document.querySelector('body>footer');
  if(footer){
   const resources=footer.querySelector('[data-help="resources"]');
   if(resources){const legal=document.createElement('details'),title=document.createElement('summary'),text=document.createElement('p');title.textContent='About / Legal';text.textContent='Standard & technology · Obligations remain with identified obligors.';legal.append(title,text,resources);document.querySelector('#security')?.append(legal);}
   footer.replaceChildren();for(const text of ['sun(φ) · SUNPHI WALLET','Coin & Network · 0.18.13']){const span=document.createElement('span');span.textContent=text;footer.append(span);}
  }
  await document.fonts.ready;
  window.scrollTo(0,0);
  document.querySelector('main')?.scrollTo(0,0);
  // Readiness follows initialized state and fonts, not compositor scheduling.
  // An occluded/minimized window may receive no animation frames at all.
  delete document.documentElement.dataset.viewPending;resolve(true);
 },{once:true});
});
