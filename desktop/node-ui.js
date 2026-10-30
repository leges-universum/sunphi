const $=id=>document.getElementById(id),api=window.sunphiNode;let busy=false,polling=false,portRestored=false;
function render(s){const active=['starting','running','stopping'].includes(s.phase);$('verify').disabled=busy||active;$('start').disabled=busy||active;$('stop').disabled=busy||!active||s.role!=='full-node';$('status').textContent=`${s.phase} · ${s.role??'no active role'}`;$('log').textContent=s.log;
 if(!portRestored&&s.port){$('base').value=String(s.port-1);portRestored=true;}
 $('rpc').textContent=s.rpc?`Local RPC responds · ${s.rpc.chain} · height ${s.rpc.height} · voting power ${s.rpc.votingPower}. This is not proof of a fresh spendable balance.`:active&&s.role==='full-node'?'Waiting for local RPC. No verified network readiness yet.':'No live connectivity established by this operation.';
 $('verified').textContent=s.result?`Verified historical replica: ${JSON.stringify(s.result)}`:'';
 if(s.phase==='completed')$('notice').textContent='Archive verification completed. This is historical evidence, not live network freshness.';
 if(s.phase==='failed')$('notice').textContent='The operation failed. Review the log; no success is assumed.';
}
async function run(action,args={}){if(busy)return;busy=true;try{const r=await api.request(action,args);if(!r.ok)throw Error(r.error);if(r.value)render(r.value);if(['verify','start'].includes(action)&&r.value)$('notice').textContent='Operation started. Keep this application open.';}catch(e){$('notice').textContent=e.message;}finally{busy=false;await refresh();}}
async function refresh(){if(polling)return;polling=true;try{const r=await api.request('status');if(r.ok)render(r.value);}catch{}finally{polling=false;}}
$('verify').onclick=()=>run('verify');$('start').onclick=()=>run('start',{base:Number($('base').value)});$('stop').onclick=()=>run('stop');$('wallet').onclick=()=>api.request('wallet');$('theme').onclick=()=>document.documentElement.dataset.theme=document.documentElement.dataset.theme==='light'?'dark':'light';
refresh();setInterval(refresh,1500);
