import {nodeView} from './node-view.mjs';
const $=id=>document.getElementById(id),api=window.sunphiNode;let busy=false,polling=false,current={phase:'idle'},feedback='',mode='network';
function render(s){current=s;const v=nodeView(s);$('status').textContent=v.title;$('message').textContent=v.message;$('indicator').className=v.connected?'connected':v.working?'working':'';
 for(const stage of ['setup','review','connect']){const e=$('step-'+stage);e.classList.toggle('active',stage===v.stage);if(stage===v.stage)e.setAttribute('aria-current','step');else e.removeAttribute('aria-current');}
 $('connect').hidden=v.active;$('connect').disabled=busy;$('connect').textContent=v.button;$('stop').hidden=!v.active;$('stop').disabled=busy||s.phase==='stopping';
 $('connection-request').hidden=s.access==='automatic-follower'||!s.deviceId||v.connected;$('connection-request').disabled=busy;
 $('reference-box').hidden=!s.deviceId;$('reference').value=s.deviceId??'';
 $('notice').hidden=!feedback;$('notice').textContent=feedback;$('log').textContent=s.log||'No connection errors recorded.';
 $('rpc').hidden=!s.rpc;$('rpc').textContent=s.rpc?'Verified local block: '+s.rpc.height+' · Network peers: '+(s.rpc.peers??0):'';
 $('technical').textContent=s.phase+' · '+(s.role??'not running')+(s.rpc?' · '+s.rpc.chain+' · voting power '+s.rpc.votingPower:'')+'. Connection status is separate from the wallet’s payment checks.';
 if(typeof s.autoStart==='boolean')$('auto').checked=s.autoStart;$('auto').disabled=busy;
 $('background-status').textContent=v.active?'Your Network node continues running independently.':'';
}
function selectMode(next){mode=next;const coin=mode==='coin';$('network-panel').hidden=coin;$('coin-panel').hidden=!coin;
 $('mode-coin').setAttribute('aria-pressed',String(coin));$('mode-network').setAttribute('aria-pressed',String(!coin));
 $('heading').textContent=coin?'Connect to an institution':'Connect to Network';
 $('intro').textContent=coin?'Join the network selected by your institution. Each connection keeps its own identity, admission status and permissions.':'Your computer verifies and stores network history. Connect automatically with a key created on this device.';
 $('role-copy').textContent=coin?'Node admission and permission to use financial services are separate decisions.':'Ordinary nodes follow the network. Connecting does not grant permission to sign witness confirmations.';
 $('wallet').textContent=coin?'Open Coin wallet →':'Open Network wallet →';feedback='';render(current);}
async function run(action,args={}){if(busy)return;busy=true;feedback='';render(current);
 if(action==='connect'){$('status').textContent='Connecting';$('message').textContent='Opening secure network connections. No administrator approval is required.';}
 try{const r=await api.request(action,args);if(!r.ok)throw Error(r.error);if(action==='connection-request')feedback=r.saved?'Public request saved. Send that JSON file to the SunPhi operator. Your private key stays here.':'Saving cancelled. Your device key is retained.';if(r.value)render(r.value);}catch(e){feedback=e.message;}finally{busy=false;await refresh();render(current);}}
async function refresh(){if(polling)return;polling=true;try{const r=await api.request('status');if(!r.ok)throw Error(r.error);render(r.value);}catch(e){feedback='Unable to read node status: '+e.message;$('notice').hidden=false;$('notice').textContent=feedback;}finally{polling=false;}}
$('mode-coin').onclick=()=>selectMode('coin');$('mode-network').onclick=()=>selectMode('network');
$('connect').onclick=()=>run('connect',{mode:'network'});$('stop').onclick=()=>run('stop');$('connection-request').onclick=()=>run('connection-request');$('wallet').onclick=()=>run('wallet',{direction:mode});$('copy').onclick=async()=>{const r=await api.request('copy-request');if(r.ok){$('copy').textContent='Copied';setTimeout(()=>$('copy').textContent='Copy',2000);}else{feedback=r.error;render(current);}};
$('auto').onchange=()=>run('auto-start',{enabled:$('auto').checked});$('theme').onclick=()=>{const light=document.documentElement.dataset.theme!=='light';document.documentElement.dataset.theme=light?'light':'dark';$('theme').textContent=light?'Dark theme':'Light theme';};
refresh();setInterval(refresh,1500);
