// Public display metadata; financial identity always includes institution/programme/instrument.
export const families={
  Vi:{name:'Basket-referenced value',colour:'Violet',hex:'#A88BE8'},
  Pi:{name:'Tokenised deposits',colour:'Pink',hex:'#ED4B8E'},
  Go:{name:'Payment instruments',colour:'Gold',hex:'#D5A52B'},
  Ma:{name:'Guarantees & contingent obligations',colour:'Mauve',hex:'#D878BB'},
  Bl:{name:'Securities & fund interests',colour:'Blue',hex:'#599CD7'},
  Gr:{name:'Receivables & working capital',colour:'Green',hex:'#49AB83'}
};
export function formatUnits(value,precision=2){
  const n=String(value??'0').padStart(precision+1,'0');return precision?`${n.slice(0,-precision).replace(/\B(?=(\d{3})+(?!\d))/g,',')}.${n.slice(-precision)}`:n.replace(/\B(?=(\d{3})+(?!\d))/g,',');
}
export const institutions=[{id:'a',name:'Asterwell Test Bank',role:'Test issuer / servicing bank'},{id:'b',name:'Brookfield Test Institution',role:'Test issuer / securities & receivables service'}];
const base=(id,institutionId,profile,title,denomination,precision,right)=>({id,institutionId,profile,title,denomination,precision,right,network:'sunphi-procedure-lab-v1',programmeId:`${institutionId}-${profile}-test-01`,instrumentId:id==='a-pi-service'?'a-pi':id,termsVersion:'test-terms-1',authoritativeRegister:`${institutionId}-laboratory-register`,obligor:institutions.find(i=>i.id===institutionId).name,protection:'Fictional test right. No deposit protection or real financial claim.',available:'0',reserved:'0',pendingReceipt:'0',disputed:'0',retired:'0',income:'0',encumbered:'0'});
export function initialPositions(){return [
  {...base('a-pi','a','Pi','Treasury deposit','USD',2,'Deposit claim against Asterwell Test Bank'),available:'100000'},
  base('a-pi-service','a','Pi','Payments service deposit','USD',2,'Same deposit claim, same holder and bank; different service allocation'),
  base('b-pi','b','Pi','Receiving institution deposit','USD',2,'New deposit claim against Brookfield Test Institution'),
  {...base('a-vi','a','Vi','Basket-referenced claim','XDR reference',4,'Contractual basket-referenced issuer obligation; not IMF SDR ownership'),available:'1000000'},
  base('a-go','a','Go','Payment account','USD',2,'Payment claim under the admitted safeguarding programme'),
  {...base('b-bl','b','Bl','Test manufacturing fund units','fund units',4,'Units in a fictional identified fund; investment exposure'),available:'100000'},
  {...base('b-gr','b','Gr','Test machinery receivable','USD face',2,'Assigned fictional receivable; debtor and collection conditions retained'),available:'20000'},
  {...base('a-ma','a','Ma','Performance guarantee','USD maximum',2,'Contingent guarantee entitlement; not spendable money'),available:'500000'}
]}
export const routes=[
  {id:'pi-service',title:'Move to another service',source:'a-pi',destination:'a-pi-service',type:'same-claim service transfer',numerator:'1',denominator:'1'},
  {id:'pi-a-b',title:'Transfer to another institution',source:'a-pi',destination:'b-pi',type:'issuer replacement',numerator:'1',denominator:'1'},
  {id:'pi-go',title:'Use a payment product',source:'a-pi',destination:'a-go',type:'monetary product conversion',numerator:'1',denominator:'1'},
  {id:'vi-pi',title:'Convert a basket-referenced claim',source:'a-vi',destination:'a-pi',type:'monetary product conversion',numerator:'135',denominator:'10000'},
  {id:'pi-bl',title:'Acquire a tokenised fund interest',source:'a-pi',destination:'b-bl',type:'asset-for-payment',numerator:'4',denominator:'1'},
  {id:'pi-gr',title:'Acquire a receivable',source:'a-pi',destination:'b-gr',type:'asset-for-payment',numerator:'1',denominator:'1'}
].map(r=>({...r,version:1,status:'ACTIVE',direction:'source-to-destination only',scope:'fictional legal-entity laboratory',termsVersion:'test-route-1'}));
