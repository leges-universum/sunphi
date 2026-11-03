import {consumerView} from './consumer-view.mjs';
const $=id=>document.getElementById(id),api=window.sunphiNode;let busy=false,polling=false,current={},feedback='';
function render(s){current=s;const v=consumerView(s);$('status').textContent=v.title;$('message').textContent=v.message;$('indicator').className=v.connected?'connected':v.working?'working':'';
 for(const stage of ['setup','review','connect']){$('step-'+stage).classList.toggle('active',stage===v.stage);}
 $('connect').hidden=v.active;$('connect').disabled=busy||s.configured===false;$('connect').textContent=v.button;$('stop').hidden=!v.active;$('stop').disabled=busy||s.progress==='stopping';
 $('wallet').disabled=busy||!s.walletReady;$('reference-box').hidden=!s.deviceId;$('reference').value=s.deviceId??'';
 $('node-height').textContent=s.rpc?.height??'—';$('node-peers').textContent=s.rpc?.peers??'—';$('technical').textContent=(s.network??'')+' · Non-voting node';$('log').textContent=s.error||'';
 $('notice').textContent=feedback;$('notice').hidden=!feedback;$('auto').checked=!!s.autoStart;$('auto').disabled=busy;
}
async function refresh(){if(polling)return;polling=true;try{const r=await api.request('status');if(!r.ok)throw Error(r.error);render(r.value);}catch(e){feedback=e.message;render(current);}finally{polling=false;}}
async function run(action,args={}){if(busy)return;busy=true;feedback='';render(current);try{const r=await api.request(action,args);if(!r.ok)throw Error(r.error);}catch(e){feedback=e.message;}finally{busy=false;await refresh();}}
$('connect').onclick=()=>run('connect');$('stop').onclick=()=>run('stop');$('wallet').onclick=()=>run('wallet');$('copy').onclick=()=>run('copy-request');$('auto').onchange=()=>run('auto-start',{enabled:$('auto').checked});
$('theme').onclick=()=>{const light=document.documentElement.dataset.theme!=='light';document.documentElement.dataset.theme=light?'light':'dark';$('theme').textContent=light?'Dark theme':'Light theme';};
void refresh();setInterval(refresh,1500);
