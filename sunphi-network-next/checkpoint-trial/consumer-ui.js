import {consumerDashboard,NetworkActivity} from './consumer-view.mjs';
const $=id=>document.getElementById(id),api=window.sunphiNode;let busy=false,polling=false,current={},feedback='',stateRevision=0;
const setText=(id,text)=>{if($(id).textContent!==text)$(id).textContent=text;};
// Reuse the wallet's solid coin; set facet geometry through CSSOM under the CSP.
for(let facet=0;facet<32;facet++){const rim=document.createElement('i');rim.className='duebyte-coin-rim';rim.style.setProperty('--facet',String(facet));$('connection-coin').firstElementChild.append(rim);}
const activity=new NetworkActivity();let chartRevision=-1,activityShown=false,paintedSamples=false;
const formatValue=n=>Number.isFinite(n)?new Intl.NumberFormat('en-GB',{maximumFractionDigits:1}).format(n):'—';
const sampleTime=t=>new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(t);
function drawChart(id,fields,unit,label){
 const svg=$(id),points=activity.points,values=points.flatMap(p=>fields.map(f=>p[f])).filter(Number.isFinite),max=Math.max(fields[0]==='rate'?1:.1,...values);
 const width=Math.max(200,svg.clientWidth),right=width-10;svg.setAttribute('viewBox',`0 0 ${width} 88`);
 const node=(name,attrs,text)=>{const e=document.createElementNS('http://www.w3.org/2000/svg',name);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));if(text!==undefined)e.textContent=text;return e;};
 svg.replaceChildren();
 for(const y of [12,42,72])svg.append(node('line',{x1:32,x2:right,y1:y,y2:y,class:'chart-grid'}));
 svg.append(node('text',{x:0,y:16,class:'chart-axis'},formatValue(max)),node('text',{x:0,y:76,class:'chart-axis'},'0'));
 const start=points.length?points[0].at:0,end=points.length>1?points.at(-1).at:start;
 for(const [index,field] of fields.entries()){
 let segment=[];const variant=index?' chart-secondary':'';
 const flush=()=>{if(segment.length>1)svg.append(node('polyline',{points:segment.join(' '),class:'chart-line'+variant}));segment=[];};
 for(const p of points){if(!Number.isFinite(p[field])){flush();continue;}const x=end===start?right:32+(p.at-start)/(end-start)*(right-32),y=72-p[field]/max*60;segment.push(`${x},${y}`);}
 flush();
 for(const p of points){if(!Number.isFinite(p[field]))continue;const x=end===start?right:32+(p.at-start)/(end-start)*(right-32),y=72-p[field]/max*60;
  const description=`${sampleTime(p.at)} · ${field}: ${formatValue(p[field])} ${unit}`;
  const dot=node('circle',{cx:x,cy:y,r:2.5,class:'chart-point'+variant});svg.append(dot);
  const target=node('circle',{cx:x,cy:y,r:8,class:'chart-target',tabindex:0,role:'img','aria-label':description});target.append(node('title',{},description));svg.append(target);
 }
 }
 svg.setAttribute('aria-label',values.length?`${label}. ${points.length} observations. ${fields.map(f=>`${f}: ${formatValue(points.at(-1)?.[f])} ${unit}`).join('; ')}`:'Waiting for a measured sample');
}
function renderActivity(s){
 activity.observe(s);activityShown=activityShown||activity.visible||consumerDashboard(s).active;
 $('network-activity').hidden=!activityShown;
 $('activity-empty').hidden=false;
 if(!activity.visible){setText('activity-empty',paintedSamples?'Measurements paused. The charts show the last verified samples.':'Waiting for current network data before measuring activity.');return;}
 setText('activity-empty',activity.points.length?'Live measurements · refreshed every 15 seconds.':paintedSamples?'Collecting fresh samples. Previous measurements remain visible.':'Collecting live samples. The first reading takes about 15 seconds.');
 if(!activity.points.length&&paintedSamples)return;
 if(chartRevision===activity.revision)return;chartRevision=activity.revision;
 const latest=activity.points.at(-1);paintedSamples=!!latest;
 setText('rate-value',latest?`${formatValue(latest.rate)} / min`:'—');
 setText('interval-value',latest&&Number.isFinite(latest.interval)?`${formatValue(latest.interval)} s`:'—');
 drawChart('rate-chart',['rate'],'generations/min','Generation rate');drawChart('interval-chart',['interval'],'s/generation','Average time per generation');
 setText('traffic-value',latest?`${formatValue(latest.incoming)} ↓ / ${formatValue(latest.outgoing)} ↑ KiB/s`:'—');
 drawChart('traffic-chart',['incoming','outgoing'],'KiB/s','This node’s peer-to-peer traffic');
 setText('traffic-note',s.rpc?.traffic?'Incoming / outgoing rates on this device only. Wallet traffic and tunnel overhead are excluded.':'Traffic readings are unavailable. Reconnect the node to refresh its counters.');
 setText('activity-range',latest?`${sampleTime(activity.points[0].at)}–${sampleTime(latest.at)} · Local time. Catch-up excluded.`:'History synchronisation is excluded.');
}
let rewardWalletVersion='',rewardSelectionDirty=false;
function rewardSelectionSummary(){
 const rows=[...$('reward-wallet-list').querySelectorAll('.reward-wallet-row')],count=rows.filter(row=>row.querySelector('input').checked).length;
 for(const row of rows){const checked=row.querySelector('input').checked;row.classList.toggle('selected',checked);row.querySelector('.reward-share').textContent=checked?(count===1?'100%':count===2?'50%':count===4?'25%':`1/${count}`):'—';}
 setText('reward-selection-summary',count?`${count} wallet${count===1?'':'s'} selected${count>1?' · equal shares':''}`:rows.length?'Select at least one wallet.':'Your first wallet will be selected automatically.');
 $('save-reward-wallets').disabled=busy||!current.walletReady||!rewardSelectionDirty||count===0;
}
function renderRewardWallets(s){
 const wallets=s.rewardWallets??[],version=JSON.stringify(wallets),r=s.rewards;
 setText('reward-status',r?.message??'Earnings stay with this node until you create a wallet.');
 setText('node-earnings',r?.available?`Earned ${r.accrued} DUBYT · Awaiting payment ${r.pending} · Paid ${r.paid}`:'Waiting for verified reward accounting.');
 if(version!==rewardWalletVersion&&!rewardSelectionDirty){rewardWalletVersion=version;const list=$('reward-wallet-list');list.replaceChildren();for(const wallet of wallets){
  const label=document.createElement('label');label.className='reward-wallet-row';const box=document.createElement('input');box.type='checkbox';box.value=wallet.id;box.checked=wallet.rewardsSelected;box.disabled=!wallet.rewardsReady;box.setAttribute('aria-label',`Pay rewards to ${wallet.name}`);box.onchange=()=>{rewardSelectionDirty=true;rewardSelectionSummary();};
  const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('aria-hidden','true');icon.classList.add('reward-wallet-icon');const path=document.createElementNS(icon.namespaceURI,'path');path.setAttribute('d','M20 8V5H5a3 3 0 0 0 0 6h15v9H5a3 3 0 0 1-3-3V8 M20 11h-5v5h7v-5h-2Z');icon.append(path);
  const copy=document.createElement('span');copy.className='reward-wallet-copy';const name=document.createElement('strong');name.textContent=wallet.name;const address=document.createElement('span');address.textContent=wallet.rewardsReady?`${wallet.owner.slice(0,7)}…${wallet.owner.slice(-5)}`:'Open once to enable rewards';copy.append(name,address);const share=document.createElement('span');share.className='reward-share';label.append(box,icon,copy,share);list.append(label);
 }if(!wallets.length){const empty=document.createElement('p');empty.className='reward-empty';empty.textContent='Create a wallet to receive all earnings saved by this node.';list.append(empty);}}
 $('save-reward-wallets').hidden=wallets.length<2;rewardSelectionSummary();
}
function render(s){current=s;const v=consumerDashboard(s);setText('status',v.title);setText('message',v.message);$('indicator').className=v.connected?'connected':v.working?'working':'';
 renderRewardWallets(s);
 renderActivity(s);
 setText('history-state',v.health);setText('action-title',v.waiting?'Connecting — please wait':v.actionTitle);setText('action-message',v.actionMessage);
 const showGeneration=v.waiting||v.connected;
 $('next-action').classList.toggle('waiting-notice',showGeneration);
 $('connection-coin').hidden=false;$('connection-coin').dataset.animated=String(showGeneration);
 $('connection-generation').hidden=!showGeneration;$('action-message').hidden=showGeneration;
 const history=s.rpc&&s.rpc.chain===s.network&&String(s.rpc.votingPower)==='0'&&!s.statusUnavailable&&!s.error?s.rpc:null;
 const height=history&&/^\d+$/.test(String(history.height))?Number(history.height):NaN;
 setText('connection-height',Number.isSafeInteger(height)&&height>=0?new Intl.NumberFormat('en-GB').format(height):'—');
 const date=history?new Date(history.time):null,valid=date&&Number.isFinite(date.getTime());
 setText('history-time',valid?new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'medium'}).format(date):'—');
 if(valid)$('history-time').dateTime=date.toISOString();else $('history-time').removeAttribute('datetime');
 $('history-time').title=valid?'Time of the latest verified generation, shown in your local time zone.':'';
 for(const stage of ['setup','review','connect']){$('step-'+stage).classList.toggle('active',stage===v.stage);}
 $('connect').hidden=v.active;$('connect').disabled=busy||s.configured===false||s.statusUnavailable;$('connect').textContent=v.button;$('stop').hidden=!v.active;$('stop').disabled=busy||s.progress==='stopping';
 $('wallet').disabled=busy||!s.walletReady||s.statusUnavailable;$('reference-box').hidden=!s.deviceId;$('reference').value=s.deviceId??'';
 $('node-height').textContent=history?.height??'—';$('node-peers').textContent=history?.peers??'—';$('technical').textContent=(s.network??'')+' · Non-voting node';$('log').textContent=s.statusError||s.error||'';
 $('notice').textContent=feedback;$('notice').hidden=!feedback;$('auto').checked=!!s.autoStart;$('auto').disabled=busy||s.autoStartAvailable===false;
 const update=s.updates;setText('update-status',update?.message??'Checking update settings…');setText('update-version',update?.available?'Version '+update.available+' available':'Home edition · '+(update?.current??'—'));$('automatic-updates').checked=update?.automatic!==false;$('automatic-updates').disabled=busy||!update;$('check-updates').disabled=busy||!update||['checking','downloading','installing'].includes(update.phase);
}
async function refresh(){if(polling||busy)return;polling=true;const revision=stateRevision;try{const r=await api.request('status');if(revision!==stateRevision)return;if(!r.ok)throw Error(r.error);render({...r.value,statusUnavailable:false,statusError:null});}catch(e){if(revision===stateRevision)render({...current,statusUnavailable:true,statusError:e.message});}finally{polling=false;}}
async function run(action,args={}){if(busy)return;if(action==='wallet'){ $('wallet').disabled=true;try{const r=await api.request(action,args);if(!r.ok)throw Error(r.error);}catch(e){feedback=e.message;await refresh();}finally{$('wallet').disabled=false;}return;}busy=true;stateRevision++;feedback='';if(action==='connect')current={...current,progress:'connecting',rpc:null,error:null,statusUnavailable:false};if(action==='auto-start')current={...current,autoStart:args.enabled};render(current);try{const r=await api.request(action,args);if(!r.ok)throw Error(r.error);if(r.value)current={...current,...r.value};}catch(e){feedback=e.message;}finally{busy=false;render(current);await refresh();}}
$('connect').onclick=()=>run('connect');$('stop').onclick=()=>run('stop');$('wallet').onclick=()=>run('wallet');$('copy').onclick=()=>run('copy-request');$('auto').onchange=()=>run('auto-start',{enabled:$('auto').checked});
$('automatic-updates').onchange=()=>run('automatic-updates',{enabled:$('automatic-updates').checked});$('check-updates').onclick=()=>run('check-updates');
$('save-reward-wallets').onclick=async()=>{const ids=[...$('reward-wallet-list').querySelectorAll('input:checked')].map(e=>e.value);await run('reward-wallets',{ids});if(!feedback){rewardSelectionDirty=false;rewardWalletVersion='';await refresh();}};
$('theme').onclick=()=>{const light=document.documentElement.dataset.theme!=='light';document.documentElement.dataset.theme=light?'light':'dark';const label=light?'Switch to dark theme':'Switch to light theme';$('theme').setAttribute('aria-label',label);$('theme').title=label;};
void refresh();setInterval(refresh,1500);
new ResizeObserver(()=>{chartRevision=-1;renderActivity(current);}).observe($('network-activity'));
