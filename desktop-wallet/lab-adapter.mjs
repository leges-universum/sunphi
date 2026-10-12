// Independently persisted fictional institution adapter. NEVER a production connector.
// Its private test keys remain outside the encrypted holder wallet and renderer.
import {readFile,open,rename,mkdir,unlink,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {newKey,identity,importSecret,digest,publicKey} from '../wallet/crypto.mjs';
import {ENVIRONMENT,STANDARD,units,signEvidence,checkProposal,verifyConsent} from './procedure-contract.mjs';
import {initialPositions,routes,institutions} from './procedure-products.mjs';
const clone=structuredClone;
export class LaboratoryAdapter {
  #directory;#now;#busy=false;
  constructor(directory,{now=Date.now}={}){this.#directory=directory;this.#now=now;}
  async #load(holder){
    publicKey(holder);await mkdir(this.#directory,{recursive:true});const path=join(this.#directory,digest({holder})+'.json');
    try{if((await stat(path)).size>16*1024*1024)throw Error('Laboratory journal is full');const s=JSON.parse(await readFile(path,'utf8'));if(s.holder!==holder||s.version!==1)throw Error('Invalid adapter store');return {s,path};}
    catch(e){if(e.code!=='ENOENT')throw e;
      const keys=Object.fromEntries(['a','b','platform'].map(k=>[k,newKey().export({format:'der',type:'pkcs8'}).toString('base64')]));
      const s={version:1,holder,keys,sequence:0,positions:initialPositions(),transactions:[],routes:clone(routes)};
      const h=await open(path,'wx',0o600);try{await h.writeFile(JSON.stringify(s));await h.sync();}finally{await h.close();}return {s,path};}
  }
  async #save(path,s){
    const bytes=JSON.stringify(s);if(bytes.length>16*1024*1024)throw Error('Laboratory journal capacity reached');
    const tmp=path+'.'+randomUUID()+'.tmp',h=await open(tmp,'wx',0o600);
    try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}
    try{await rename(tmp,path);}catch(e){await unlink(tmp).catch(()=>{});throw e;}
  }
  #key(s,id){return importSecret(Buffer.from(s.keys[id],'base64'));}
  #trust(s){return Object.fromEntries(Object.keys(s.keys).map(id=>[id,identity(this.#key(s,id)).publicKey]));}
  #record(s,key,kind,id,body){return signEvidence(this.#key(s,key),key,kind,s.holder,id,body,this.#now());}
  #snapshot(s){const now=this.#now();return this.#record(s,'platform','snapshot','',{environment:ENVIRONMENT,standard:STANDARD,holder:s.holder,sequence:s.sequence,asOf:now,expiresAt:now+300000,institutions,positions:s.positions,transactions:s.transactions,routes:s.routes,finalityBasis:'LOCAL LABORATORY ONLY — no external settlement or legal effect',production:false});}
  async #serial(fn){if(this.#busy)throw Error('Adapter operation in progress');this.#busy=true;try{return await fn();}finally{this.#busy=false;}}
  async connect(holder){return this.#serial(async()=>{const {s}=await this.#load(holder);return {trust:this.#trust(s),snapshot:this.#snapshot(s)};});}
  async query(holder){return this.#serial(async()=>{const {s}=await this.#load(holder);return this.#snapshot(s);});}
  async quote(holder,{routeId,amount,delivery='normal'}){return this.#serial(async()=>{
    if(!['normal','lost-reply','partial'].includes(delivery))throw Error('Unsupported laboratory delivery mode');
    const {s}=await this.#load(holder),route=s.routes.find(r=>r.id===routeId);
    if(s.transactions.some(t=>t.state==='RECOVERY_REQUIRED'))throw Error('Resolve the original pending recovery before another instruction');
    if(!route||route.status!=='ACTIVE')throw Error('No active directional route for this operation');
    const source=s.positions.find(p=>p.id===route.source),destination=s.positions.find(p=>p.id===route.destination),quantity=units(amount,source.precision);
    if(BigInt(quantity)>BigInt(source.available))throw Error('Insufficient available source entitlement');
    const scaled=BigInt(quantity)*BigInt(route.numerator),divisor=BigInt(route.denominator);
    if(scaled%divisor!==0n)throw Error('Amount does not produce exact destination units; choose another amount');
    const result=scaled/divisor;if(result<=0n)throw Error('Destination amount is below its smallest unit');
    const now=this.#now(),id=randomUUID();
    return this.#record(s,'platform','proposal',id,{environment:ENVIRONMENT,standard:STANDARD,routeId,routeVersion:route.version,termsVersion:route.termsVersion,sequence:s.sequence,type:route.type,createdAt:now,expiresAt:now+120000,reservationDeadline:now+180000,escalationDeadline:now+300000,holder,source:clone(source),destination:clone(destination),sourceUnits:quantity,destinationUnits:result.toString(),feeUnits:'0',taxUnits:'0',delivery,
      legalGates:[{id:'route-authority',satisfied:true,evidence:'fictional route schedule v1'},{id:'holder-eligibility',satisfied:true,evidence:'laboratory holder only'},{id:'destination-register',satisfied:true,evidence:'fictional instrument register; no country admission'}],
      disclosures:['Fictional funds and simulated institutional approvals only.','The destination right and obligor shown here replace or supplement the source as specified.','No real deposit protection, investment, guarantee, payment or legal title is created.'],
      bindingEvent:'Laboratory execution decision after consent and fresh route checks',cancellation:'Before the execution decision only; after partial execution use controlled recovery.',valuation:routeId==='vi-pi'?'Fixed test quote: 1 XDR reference = 1.35 USD; not a live FX quote.':routeId==='pi-bl'?'Fixed test quote: 25 USD per fictional fund unit.':'Fixed test ratio; no market price representation.',
      recovery:'Source entitlement stays reserved until the missing destination leg is evidenced; no automatic repeat or release.',terms:{version:'test-terms-1',law:'No real legal rights; laboratory contract fixtures',issuerBefore:source.obligor,issuerAfter:destination.obligor,protectionBefore:source.protection,protectionAfter:destination.protection},legs:[{id:id+':source',authority:'a',effect:'Reserve and deliver source entitlement'},{id:id+':destination',authority:destination.institutionId,effect:'Register destination entitlement'}]});
  });}
  #complete(s,t){
    const p=t.proposal.payload.body,source=s.positions.find(x=>x.id===p.source.id),dest=s.positions.find(x=>x.id===p.destination.id);
    source.reserved=(BigInt(source.reserved)-BigInt(p.sourceUnits)).toString();
    if(p.type!=='same-claim service transfer')source.retired=(BigInt(source.retired)+BigInt(p.sourceUnits)).toString();
    dest.pendingReceipt=(BigInt(dest.pendingReceipt)-BigInt(p.destinationUnits)).toString();dest.available=(BigInt(dest.available)+BigInt(p.destinationUnits)).toString();
    t.records.push(this.#record(s,p.destination.institutionId,'leg-confirmation',t.id,{legId:p.legs[1].id,state:'FINAL_TEST',providerReference:t.id+':destination',finalityBasis:'SIMULATED REGISTER ONLY',effectiveAt:this.#now(),quantity:p.destinationUnits,instrumentId:dest.instrumentId}));
    t.state='COMPLETED';t.claim='Destination test entitlement recorded. No real financial effect.';
    t.records.push(this.#record(s,'platform','completion-receipt',t.id,{proposalDigest:digest(t.proposal),sourceRight:p.source.right,destinationRight:p.destination.right,obligorBefore:p.source.obligor,obligorAfter:p.destination.obligor,sourceUnits:p.sourceUnits,destinationUnits:p.destinationUnits,feeUnits:'0',register:dest.authoritativeRegister,legs:p.legs.map(l=>l.id),finalityBasis:'LABORATORY ONLY',support:'Local laboratory: no external case submitted'}));
  }
  async execute(holder,proposal,authority){return this.#serial(async()=>{
    const {s,path}=await this.#load(holder),id=proposal?.payload?.transitionId,old=s.transactions.find(t=>t.id===id);
    if(old){if(digest(old.proposal)!==digest(proposal)||digest(old.authority)!==digest(authority))throw Error('Identifier reused with different payload');return this.#snapshot(s);}
    const p=checkProposal(proposal,this.#trust(s),holder,this.#now());verifyConsent(authority,proposal,this.#now());
    if(s.transactions.some(t=>t.state==='RECOVERY_REQUIRED'))throw Error('Resolve the original pending recovery before another instruction');
    const route=s.routes.find(r=>r.id===p.routeId);
    if(!route||route.status!=='ACTIVE'||route.version!==p.routeVersion||s.sequence!==p.sequence||route.source!==p.source.id||route.destination!==p.destination.id)throw Error('Route or balance changed; refresh and review a new proposal');
    const source=s.positions.find(x=>x.id===p.source.id),dest=s.positions.find(x=>x.id===p.destination.id);
    if(BigInt(source.available)<BigInt(p.sourceUnits))throw Error('Insufficient entitlement at execution');
    if(s.transactions.length>=150)throw Error('Laboratory transaction limit reached; export history and use a new test workspace');
    source.available=(BigInt(source.available)-BigInt(p.sourceUnits)).toString();source.reserved=(BigInt(source.reserved)+BigInt(p.sourceUnits)).toString();dest.pendingReceipt=(BigInt(dest.pendingReceipt)+BigInt(p.destinationUnits)).toString();
    const t={id,proposal,authority,state:'RECOVERY_REQUIRED',claim:`Reserved source claim against ${source.obligor}; destination is not available.`,caseOwner:p.destination.obligor,records:[]};
    for(const key of new Set(['a',dest.institutionId]))t.records.push(this.#record(s,key,'institutional-acceptance',id,{proposalDigest:digest(proposal),decision:'ACCEPT',scope:'FICTIONAL TEST',expiresAt:p.expiresAt}));
    t.records.push(this.#record(s,'a','reservation',id,{proposalDigest:digest(proposal),sourceUnits:p.sourceUnits,destinationUnits:p.destinationUnits,exclusive:true,releaseRule:'Authenticated non-execution or authorised recovery only'}));
    t.records.push(this.#record(s,'platform','execution-decision',id,{proposalDigest:digest(proposal),epoch:1,conditions:'all laboratory gates revalidated',state:'EXECUTING'}));
    t.records.push(this.#record(s,'a','leg-confirmation',id,{legId:p.legs[0].id,state:'FINAL_TEST',providerReference:id+':source',finalityBasis:'SIMULATED SETTLEMENT ONLY',effectiveAt:this.#now(),quantity:p.sourceUnits}));
    if(p.delivery==='partial')t.records.push(this.#record(s,'platform','recovery-record',id,{missingLeg:p.legs[1].id,caseOwner:t.caseOwner,claim:t.claim,dueAt:p.escalationDeadline,remedy:'Explicit test adapter completion; no automatic source release'}));
    else this.#complete(s,t);
    s.transactions.push(t);s.sequence++;await this.#save(path,s);
    if(p.delivery==='lost-reply'){const e=Error('Laboratory acknowledgement lost after execution');e.code='OUTCOME_UNKNOWN';throw e;}
    return this.#snapshot(s);
  });}
  async recover(holder,id){return this.#serial(async()=>{const {s,path}=await this.#load(holder),t=s.transactions.find(t=>t.id===id);if(!t)throw Error('Original transaction not found');if(t.state==='RECOVERY_REQUIRED'){this.#complete(s,t);s.sequence++;await this.#save(path,s);}return this.#snapshot(s);});}
  // Test harness only: models an independently authorised route suspension.
  async restrictRoute(holder,id,status){return this.#serial(async()=>{if(!['ACTIVE','SUSPENDED'].includes(status))throw Error('Invalid route status');const {s,path}=await this.#load(holder),r=s.routes.find(r=>r.id===id);if(!r)throw Error('Route not found');r.status=status;r.version++;s.sequence++;await this.#save(path,s);return this.#snapshot(s);});}
}
