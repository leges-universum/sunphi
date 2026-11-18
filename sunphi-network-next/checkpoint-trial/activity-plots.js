(()=>{
const formatValue=n=>Number.isFinite(n)?new Intl.NumberFormat('en-GB',{maximumFractionDigits:n>0&&n<1?3:1}).format(n):'—';
const sampleTime=t=>new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(t);
function drawChart(svg,points,fields,unit,label){
 const values=points.flatMap(p=>fields.map(f=>p[f])).filter(Number.isFinite);
 const traffic=fields[0]==='incoming',bars=fields[0]==='rate',peak=Math.max(traffic ? 0.1 : 1,...values,...(traffic?[]:points.map(p=>p.rate).filter(Number.isFinite)));
 const step=10**Math.floor(Math.log10(peak)),max=Math.ceil(peak/step)*step;
 const width=Math.max(200,svg.clientWidth),right=width-12;svg.setAttribute('viewBox',`0 0 ${width} 88`);
 const node=(name,attrs,text)=>{const e=document.createElementNS('http://www.w3.org/2000/svg',name);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));if(text!==undefined)e.textContent=text;return e;};
 svg.replaceChildren();
 for(const y of [12,42,72])svg.append(node('line',{x1:40,x2:right,y1:y,y2:y,class:'chart-grid'}));
 svg.append(node('text',{x:0,y:16,class:'chart-axis'},formatValue(max)),node('text',{x:0,y:76,class:'chart-axis'},'0'));
 const start=points.length?points[0].at-(points[0].elapsed||0):0,end=points.length?points.at(-1).at:start;
 const left=40,last=right-7;
 if(points.length){
  svg.append(node('text',{x:left,y:86,class:'chart-axis'},sampleTime(start)));
  if(end>start)svg.append(node('text',{x:last,y:86,'text-anchor':'end',class:'chart-axis'},sampleTime(end)));
 }
 for(const [index,field] of fields.entries()){
 const variant=index?' chart-secondary':'',barWidth=Math.min(14,(right-32)/Math.max(2,points.length)*.65);
 const inset=bars?barWidth/2:0;
 const marks=[],path=[];let previous=null;
 for(const p of points){
  if(!Number.isFinite(p[field])){previous=null;continue;}
  const x=end===start?last:left+(p.at-start)/(end-start)*(last-left),y=72-p[field]/max*60;
  if(!bars){
   if(!previous)path.push(`M${x} ${y}`);
   else if(traffic){
    // Horizontal tangents keep interpolation inside the measured range.
    const mid=(previous.x+x)/2;
    path.push(`C${mid} ${previous.y} ${mid} ${y} ${x} ${y}`);
   }else path.push(`L${x} ${y}`);
   previous={x,y};
  }
  let description=`${sampleTime(p.at)} · ${field}: ${formatValue(p[field])} ${unit}`;
  if(bars)description+=' · '+p.generations+' new blocks in '+formatValue(p.elapsed/1000)+' s';
  marks.push(bars?node('rect',{x:x-inset,y,width:barWidth,height:Math.max(1,72-y),class:'chart-point'}):node('circle',{cx:x,cy:y,r:2.5,class:'chart-point'+variant}));
  const target=node('circle',{cx:x,cy:y,r:8,class:'chart-target',tabindex:0,role:'img','aria-label':description});target.append(node('title',{},description));marks.push(target);
 }
 if(path.length)svg.append(node('path',{d:path.join(' '),class:'chart-line'+variant}));
 svg.append(...marks);
 }
 svg.setAttribute('aria-label',values.length?`${label}. ${points.length} observations. ${fields.map(f=>`${f}: ${formatValue(points.at(-1)?.[f])} ${unit}`).join('; ')}`:'Waiting for a measured sample');
}
globalThis.DueBytePlots={drawChart,formatValue,sampleTime};
})();
