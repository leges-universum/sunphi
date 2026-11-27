(()=>{
const formatValue=n=>Number.isFinite(n)?new Intl.NumberFormat('en-GB',{maximumFractionDigits:n>0&&n<1?3:1}).format(n):'—';
const sampleTime=t=>new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(t);
// Shape-preserving Hermite slope, in KiB/s per millisecond of observation time.
function trafficSlope(before,point,after,field){
 const left=Number.isFinite(before?.[field])?point.at-before.at:0;
 const right=Number.isFinite(after?.[field])?after.at-point.at:0;
 const risingFrom=left>0?(point[field]-before[field])/left:0;
 const risingTo=right>0?(after[field]-point[field])/right:0;
 if(left<=0)return risingTo;
 if(right<=0)return risingFrom;
 if(risingFrom*risingTo<=0)return 0;
 const w1=2*right+left,w2=right+2*left;
 return (w1+w2)/(w1/risingFrom+w2/risingTo);
}
function drawChart(svg,points,fields,unit,label){
 const values=points.flatMap(p=>fields.map(f=>p[f])).filter(Number.isFinite);
 const traffic=fields[0]==='incoming',bars=fields[0]==='rate',peak=Math.max(traffic ? 0.1 : 1,...values,...(traffic?[]:points.map(p=>p.rate).filter(Number.isFinite)));
 const step=10**Math.floor(Math.log10(peak)),max=Math.ceil(peak/step)*step;
 const width=Math.max(200,svg.clientWidth),right=width-12;svg.setAttribute('viewBox',`0 -16 ${width} 104`);
 const node=(name,attrs,text)=>{const e=document.createElementNS('http://www.w3.org/2000/svg',name);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));if(text!==undefined)e.textContent=text;return e;};
 svg.replaceChildren();
 svg.append(node('text',{x:0,y:-4,class:'chart-unit',fill:'var(--muted)','font-size':11},unit));
 for(const [y,value] of [[12,max],[42,max/2],[72,0]]){
  svg.append(node('line',{x1:40,x2:right,y1:y,y2:y,class:'chart-grid'}),node('text',{x:0,y:y+3,class:'chart-axis'},formatValue(value)));
 }
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
 for(const [i,p] of points.entries()){
  if(!Number.isFinite(p[field])){previous=null;continue;}
  const x=end===start?last:left+(p.at-start)/(end-start)*(last-left),y=72-p[field]/max*60;
  if(!bars){
   const slope=traffic?trafficSlope(points[i-1],p,points[i+1],field):0;
   if(!previous||p.at<=previous.at)path.push(`M${x} ${y}`);
   else if(traffic){
    const dx=(x-previous.x)/3,scale=(p.at-previous.at)/3*60/max;
    path.push(`C${previous.x+dx} ${previous.y-previous.slope*scale} ${x-dx} ${y+slope*scale} ${x} ${y}`);
   }else path.push(`L${x} ${y}`);
   previous={x,y,at:p.at,slope};
  }
  let description=`${sampleTime(p.at)} · ${field}: ${formatValue(p[field])} ${unit}`;
  if(bars)description+=' · '+p.generations+' new blocks in '+formatValue(p.elapsed/1000)+' s';
  marks.push(bars?node('rect',{x:x-inset,y,width:barWidth,height:Math.max(1,72-y),class:'chart-point'}):node('circle',{cx:x,cy:y,r:2.5,class:'chart-point'+variant}));
  const target=node('circle',{cx:x,cy:y,r:8,class:'chart-target',tabindex:0,role:'img','aria-label':description});target.append(node('title',{},description));marks.push(target);
 }
 if(path.length)svg.append(node('path',{d:path.join(' '),class:'chart-line'+variant}));
 svg.append(...marks);
 }
 const summary=values.length?`${points.length} observations. ${fields.map(f=>`${f}: ${formatValue(points.at(-1)?.[f])} ${unit}`).join('; ')}`:'Waiting for a measured sample';
 svg.setAttribute('aria-label',`${label}. Vertical axis: ${unit}. ${summary}`);
}
globalThis.DueBytePlots={drawChart,formatValue,sampleTime};
})();
