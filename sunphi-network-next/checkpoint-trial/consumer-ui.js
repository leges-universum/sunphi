import {consumerDashboard,NetworkActivity} from './consumer-view.mjs';
const $=id=>document.getElementById(id),api=window.sunphiNode;let busy=false,polling=false,current={},feedback='';
const setText=(id,text)=>{if($(id).textContent!==text)$(id).textContent=text;};
const activity=new NetworkActivity();let chartRevision=-1;
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
 activity.observe(s);$('network-activity').hidden=!activity.visible;
 if(chartRevision===activity.revision)return;chartRevision=activity.revision;
 const latest=activity.points.at(-1);$('activity-empty').hidden=!!latest;
 setText('rate-value',latest?`${formatValue(latest.rate)} / min`:'—');
 setText('interval-value',latest&&Number.isFinite(latest.interval)?`${formatValue(latest.interval)} s`:'—');
 drawChart('rate-chart',['rate'],'generations/min','Generation rate');drawChart('interval-chart',['interval'],'s/generation','Average time per generation');
 setText('traffic-value',latest?`${formatValue(latest.incoming)} ↓ / ${formatValue(latest.outgoing)} ↑ KiB/s`:'—');
 drawChart('traffic-chart',['incoming','outgoing'],'KiB/s','This node’s peer-to-peer traffic');
 setText('traffic-note',s.rpc?.traffic?'Incoming / outgoing rates on this device only. Wallet traffic and tunnel overhead are excluded.':'Traffic readings are unavailable. Reconnect the node to refresh its counters.');
 setText('activity-range',latest?`${sampleTime(activity.points[0].at)}–${sampleTime(latest.at)} · Local time. Catch-up excluded.`:'History synchronisation is excluded.');
}
function render(s){current=s;const v=consumerDashboard(s);setText('status',v.title);setText('message',v.message);$('indicator').className=v.connected?'connected':v.working?'working':'';
 renderActivity(s);
 setText('history-state',v.health);setText('work-title',v.workTitle);setText('work-message',v.workMessage);setText('action-title',v.actionTitle);setText('action-message',v.actionMessage);
 $('next-action').classList.toggle('waiting-notice',v.waiting);
 const history=s.rpc&&s.rpc.chain===s.network&&String(s.rpc.votingPower)==='0'&&!s.statusUnavailable&&!s.error?s.rpc:null;
 const date=history?new Date(history.time):null,valid=date&&Number.isFinite(date.getTime());
 setText('history-time',valid?new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'medium'}).format(date):'—');
 if(valid)$('history-time').dateTime=date.toISOString();else $('history-time').removeAttribute('datetime');
 $('history-time').title=valid?'Time of the latest verified generation, shown in your local time zone.':'';
 for(const stage of ['setup','review','connect']){$('step-'+stage).classList.toggle('active',stage===v.stage);}
 $('connect').hidden=v.active;$('connect').disabled=busy||s.configured===false||s.statusUnavailable;$('connect').textContent=v.button;$('stop').hidden=!v.active;$('stop').disabled=busy||s.progress==='stopping';
 $('wallet').disabled=busy||!s.walletReady||s.statusUnavailable;$('reference-box').hidden=!s.deviceId;$('reference').value=s.deviceId??'';
 setText('wallet-help',s.walletReady?'Your wallet checks balances and payments independently.':'Your wallet becomes available after its local service starts.');
 $('node-height').textContent=history?.height??'—';$('node-peers').textContent=history?.peers??'—';$('technical').textContent=(s.network??'')+' · Non-voting node';$('log').textContent=s.statusError||s.error||'';
 $('notice').textContent=feedback;$('notice').hidden=!feedback;$('auto').checked=!!s.autoStart;$('auto').disabled=busy;
}
async function refresh(){if(polling)return;polling=true;try{const r=await api.request('status');if(!r.ok)throw Error(r.error);render({...r.value,statusUnavailable:false,statusError:null});}catch(e){render({...current,statusUnavailable:true,statusError:e.message});}finally{polling=false;}}
async function run(action,args={}){if(busy)return;if(action==='wallet'){ $('wallet').disabled=true;try{const r=await api.request(action,args);if(!r.ok)throw Error(r.error);}catch(e){feedback=e.message;await refresh();}finally{$('wallet').disabled=false;}return;}busy=true;feedback='';render(current);try{const r=await api.request(action,args);if(!r.ok)throw Error(r.error);}catch(e){feedback=e.message;}finally{busy=false;await refresh();}}
$('connect').onclick=()=>run('connect');$('stop').onclick=()=>run('stop');$('wallet').onclick=()=>run('wallet');$('copy').onclick=()=>run('copy-request');$('auto').onchange=()=>run('auto-start',{enabled:$('auto').checked});
$('theme').onclick=()=>{const light=document.documentElement.dataset.theme!=='light';document.documentElement.dataset.theme=light?'light':'dark';const label=light?'Switch to dark theme':'Switch to light theme';$('theme').setAttribute('aria-label',label);$('theme').title=label;};
void refresh();setInterval(refresh,1500);
new ResizeObserver(()=>{chartRevision=-1;renderActivity(current);}).observe($('network-activity'));
