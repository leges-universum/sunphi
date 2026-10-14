// Independently persisted fictional institution adapter. NEVER a production connector.
// Its private test keys remain outside the encrypted holder wallet and renderer.
import {readFile,open,rename,mkdir,unlink,stat,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {newKey,identity,importSecret,digest,publicKey,addressOf,ADDRESS} from '../wallet/crypto.mjs';
import {ENVIRONMENT,STANDARD,MAX_UNITS,units,signEvidence,checkProposal,verifyConsent,verifySnapshot} from './procedure-contract.mjs';
import {serialDirectory,recoverPair,commitPair} from './recipient-journal.mjs';
import {TOKEN_MODEL,tokenisePosition,validateToken} from './token-units.mjs';
import {initialPositions,routes,institutions} from './procedure-products.mjs';
import {initialiseIncome,accrueIncome,projectIncome,principalTerms} from './income-accounting.mjs';
import {initialisePolicy,configurationHash,policyReasons,precheckOperation,requirePrecheck} from './operation-policy.mjs';
const clone=structuredClone;
function requireCapacity(position,quantity){
  const total=['available','reserved','pendingReceipt','frozen'].reduce((sum,f)=>sum+BigInt(position[f]||'0'),0n);
  if(total+BigInt(quantity)>MAX_UNITS)throw Error('Destination quantity exceeds the supported instrument limit');
}
export class LaboratoryAdapter {
  #directory;#now;#failpoint;#confirmationAvailable;
  constructor(directory,{now=Date.now,failpoint=()=>{},confirmationAvailable=()=>true}={}){this.#directory=resolve(directory);this.#now=now;this.#failpoint=failpoint;this.#confirmationAvailable=confirmationAvailable;}
  async #load(holder){
    publicKey(holder);await mkdir(this.#directory,{recursive:true});const path=join(this.#directory,digest({holder})+'.json');
    try{if((await stat(path)).size>16*1024*1024)throw Error('Laboratory journal is full');const s=JSON.parse(await readFile(path,'utf8'));if(s.holder!==holder||s.version!==1)throw Error('Invalid adapter store');
      if(s.tokenModel!==TOKEN_MODEL){
        const before=digest(s.positions);s.positions=s.positions.map(tokenisePosition);s.tokenModel=TOKEN_MODEL;s.sequence++;
        s.unitDefinition=this.#record(s,'platform','token-unit-definition','',{model:TOKEN_MODEL,beforeDigest:before,afterDigest:digest(s.positions),rule:'One token represents one whole original contractual unit; balances, scale, rights and historical evidence unchanged.',definition:'laboratory-unit-definition-1'});
        await this.#save(path,s);
      }
      if(!s.standardMigration){
        // Preserve signed history and the original adapter store. No retroactive interest.
        const backup=await open(path+'.before-2.2.json','wx',0o600).catch(e=>{if(e.code!=='EEXIST')throw e;return null;});
        if(backup){try{await backup.writeFile(JSON.stringify(s));await backup.sync();}finally{await backup.close();}}
        this.#initialise22(s);s.sequence++;await this.#save(path,s);
      }
      return {s,path};}
    catch(e){if(e.code!=='ENOENT')throw e;
      const keys=Object.fromEntries(['a','b','platform'].map(k=>[k,newKey().export({format:'der',type:'pkcs8'}).toString('base64')]));
      const s={version:1,holder,keys,sequence:0,positions:initialPositions().map(tokenisePosition),tokenModel:TOKEN_MODEL,transactions:[],routes:clone(routes)};
      this.#initialise22(s);
      const h=await open(path,'wx',0o600);try{await h.writeFile(JSON.stringify(s));await h.sync();}finally{await h.close();}return {s,path};}
  }
  #initialise22(s){
    const at=this.#now();initialisePolicy(s,at);
    for(const p of s.positions){p.seriesId=p.instrumentId+'-series-1';p.interfaceProfile='SUNPHI_LOCAL_NATIVE';p.frozen??='0';initialiseIncome(p,s.holderId,at);}
    s.standardMigration={edition:'2.2',at,previousHistoryPreserved:true,incomeReconstructed:false};
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
  #snapshot(s){const now=this.#now();return this.#record(s,'platform','snapshot','',{environment:ENVIRONMENT,standard:STANDARD,holder:s.holder,holderId:s.holderId,sequence:s.sequence,asOf:now,expiresAt:now+300000,institutions,tokenModel:TOKEN_MODEL,unitDefinition:s.unitDefinition||null,positions:s.positions.map(p=>projectIncome(p,now)),transactions:s.transactions,routes:s.routes,incoming:s.incoming||[],policy:s.policy,identityBinding:s.identityBinding,configurationHash:configurationHash(s),standardMigration:s.standardMigration,actionRestrictions:Object.fromEntries(s.positions.map(p=>[p.id,policyReasons(s,p,now)])),finalityBasis:'LOCAL LABORATORY ONLY — no external settlement or legal effect',production:false});}
  async #serial(fn){return serialDirectory(this.#directory,async()=>{await recoverPair(this.#directory,(path,s)=>this.#save(path,s));return fn();});}
  async connect(holder,{label='Test wallet'}={}){return this.#serial(async()=>{const {s,path}=await this.#load(holder);if(!s.label){s.label=String(label).trim().slice(0,80)||'Test wallet';await this.#save(path,s);}return {trust:this.#trust(s),snapshot:this.#snapshot(s)};});}
  async query(holder){return this.#serial(async()=>{await this.#advanceRecipientTransfers(holder);const {s}=await this.#load(holder);return this.#snapshot(s);});}
  async getAvailableActions(holder){return this.#serial(async()=>{
    const {s}=await this.#load(holder),at=this.#now();
    return s.positions.map(p=>({assetId:p.id,actions:[
      ...s.routes.filter(r=>r.source===p.id).map(r=>({routeId:r.id,...precheckOperation(s,{sourceId:p.id,destinationId:r.destination,routeId:r.id},at)})),
      {routeId:null,...precheckOperation(s,{sourceId:p.id,operation:'recipient-transfer'},at)}
    ]}));
  });}
  async precheck(holder,input){
    return this.#serial(async()=>{
      const {s}=await this.#load(holder),route=s.routes.find(r=>r.id===input.routeId);
      const recipient=input.address?await this.#findRecipient(input.address):null;
      const sourceId=input.address?input.sourceId:route?.source;
      const source=s.positions.find(p=>p.id===sourceId);let quantityMinor='invalid';
      try{quantityMinor=units(input.amount,source?.precision);}catch{/* A failed precheck is a structured restriction, never a reservation. */}
      const result=precheckOperation(s,{sourceId,destinationId:input.address?input.destinationId:route?.destination,
        routeId:input.routeId,operation:input.address?'recipient-transfer':'own-product',quantityMinor},this.#now(),recipient);
      const deny=(code,text)=>{result.permitted_actions=[];result.reason_codes.push(code);result.user_next_steps.push(text);};
      if(input.address){
        if(recipient.holder===holder)deny('SELF_TRANSFER','Choose another holder or use Between my products.');
        try{if(!this.#recipientChoices(s,recipient,sourceId).destinations.some(p=>p.id===input.destinationId))throw Error();}
        catch{deny('RECEIVING_PRODUCT_UNAVAILABLE','Choose an eligible receiving product for this instrument.');}
      }else if(route&&/^\d+$/.test(quantityMinor)&&BigInt(quantityMinor)*BigInt(route.numerator)%BigInt(route.denominator)!==0n){
        deny('QUANTITY_NOT_REPRESENTABLE','Choose a quantity that produces exact destination token units.');
      }
      return result;
    });
  }
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
    requireCapacity(destination,result);
    const now=this.#now(),id=randomUUID();
    const precheck=requirePrecheck(precheckOperation(s,{sourceId:source.id,destinationId:destination.id,routeId,quantityMinor:quantity},now));
    return this.#record(s,'platform','proposal',id,{environment:ENVIRONMENT,standard:STANDARD,precheck,routeId,routeVersion:route.version,termsVersion:route.termsVersion,sequence:s.sequence,type:route.type,createdAt:now,expiresAt:precheck.valid_until,reservationDeadline:now+180000,escalationDeadline:now+300000,holder,quantityUnit:'tokens',source:projectIncome(source,now),destination:projectIncome(destination,now),sourceUnits:quantity,destinationUnits:result.toString(),feeUnits:'0',taxUnits:'0',delivery,
      legalGates:[{id:'route-authority',satisfied:true,evidence:'fictional route schedule v1'},{id:'holder-eligibility',satisfied:true,evidence:'laboratory holder only'},{id:'destination-register',satisfied:true,evidence:'fictional instrument register; no country admission'}],
      disclosures:['Fictional funds and simulated institutional approvals only.','The destination right and obligor shown here replace or supplement the source as specified.','No real deposit protection, investment, guarantee, payment or legal title is created.'],
      bindingEvent:'Laboratory execution decision after consent and fresh route checks',cancellation:'Before the execution decision only; after partial execution use controlled recovery.',valuation:routeId==='vi-pi'?'Fixed test exchange: 1 sun(φ) Vi = 1.35 sun(φ) Pi. Basket valuation is separate.':routeId==='pi-bl'?'Fixed test exchange: 25 sun(φ) Pi = 1 sun(φ) Bl. Basket valuation is separate.':'Fixed test token exchange ratio; separate XDR basket valuation is indicative.',
      recovery:'Source entitlement stays reserved until the missing destination leg is evidenced; no automatic repeat or release.',terms:{version:'test-terms-1',law:'No real legal rights; laboratory contract fixtures',issuerBefore:source.obligor,issuerAfter:destination.obligor,protectionBefore:source.protection,protectionAfter:destination.protection},legs:[{id:id+':source',authority:'a',effect:'Reserve and deliver source entitlement'},{id:id+':destination',authority:destination.institutionId,effect:'Register destination entitlement'}]});
  });}
  #complete(s,t){
    const p=t.proposal.payload.body,source=s.positions.find(x=>x.id===p.source.id),dest=s.positions.find(x=>x.id===p.destination.id);
    if(policyReasons(s,source,this.#now()).length||policyReasons(s,dest,this.#now()).length||configurationHash(s)!==p.precheck?.configuration_hash)throw Error('Execution checks changed. Preserve the original reservation and request institutional review');
    const effectiveAt=this.#now();
    accrueIncome(source,effectiveAt,t.id+':source');accrueIncome(dest,effectiveAt,t.id+':destination');
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
    if(p.recipient)return this.#executeRecipient(s,proposal,authority,p);
    if(s.transactions.some(t=>t.state==='RECOVERY_REQUIRED'))throw Error('Resolve the original pending recovery before another instruction');
    const route=s.routes.find(r=>r.id===p.routeId);
    if(!route||route.status!=='ACTIVE'||route.version!==p.routeVersion||s.sequence!==p.sequence||route.source!==p.source.id||route.destination!==p.destination.id)throw Error('Route or balance changed; refresh and review a new proposal');
    const source=s.positions.find(x=>x.id===p.source.id),dest=s.positions.find(x=>x.id===p.destination.id);
    if(digest(principalTerms(source))!==digest(principalTerms(p.source))||digest(principalTerms(dest))!==digest(principalTerms(p.destination)))throw Error('Token definition or valuation changed; review a new proposal');
    const current=requirePrecheck(precheckOperation(s,{sourceId:source.id,destinationId:dest.id,routeId:route.id,quantityMinor:p.sourceUnits},this.#now()));
    if(current.configuration_hash!==p.precheck.configuration_hash||current.state_version!==p.precheck.state_version)throw Error('Precheck configuration or state changed; review again');
    if(route.type!==p.type||route.termsVersion!==p.termsVersion||BigInt(p.sourceUnits)*BigInt(route.numerator)!==BigInt(p.destinationUnits)*BigInt(route.denominator))throw Error('Route terms or exact destination quantity changed');
    requireCapacity(dest,p.destinationUnits);
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
  async recover(holder,id){return this.#serial(async()=>{const {s,path}=await this.#load(holder),t=s.transactions.find(t=>t.id===id);if(!t)throw Error('Original transaction not found');if(t.proposal.payload.body.recipient)throw Error('Recipient transfers require verified confirmation; manual completion is unavailable');if(t.state==='RECOVERY_REQUIRED'){this.#complete(s,t);s.sequence++;await this.#save(path,s);}return this.#snapshot(s);});}
  async #findRecipient(address){
    if(typeof address!=='string'||!ADDRESS.test(address))throw Error('Enter a valid SunPhi laboratory wallet address');
    const names=(await readdir(this.#directory)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n));
    if(names.length>500)throw Error('Local recipient directory limit reached');
    for(const name of names){
      const path=join(this.#directory,name);
      if((await stat(path)).size>16*1024*1024)throw Error('Laboratory journal is full');
      const s=JSON.parse(await readFile(path,'utf8'));
      if(s.version!==1||name!==digest({holder:s.holder})+'.json')throw Error('Invalid local recipient record');
      if(addressOf(s.holder)===address)return (await this.#load(s.holder)).s;
    }
    throw Error('Recipient not found. Open that wallet on this computer and start its demonstration first. Remote and real wallets are not connected.');
  }
  #recipientChoices(s,recipient,sourceId){
    const source=s.positions.find(p=>p.id===sourceId);
    if(!source||!['Vi','Pi','Go','Bl','Gr'].includes(source.profile))throw Error('This asset does not support transfers to another holder');
    const destinations=recipient.positions.filter(p=>{
      const same=p.instrumentId===source.instrumentId&&p.institutionId===source.institutionId&&p.programmeId===source.programmeId&&p.seriesId===source.seriesId&&digest(p.token)===digest(source.token)&&p.denomination===source.denomination&&p.precision===source.precision&&p.termsVersion===source.termsVersion;
      const replacement=source.id==='a-pi'&&p.id==='b-pi'&&s.routes.some(r=>r.id==='pi-a-b'&&r.status==='ACTIVE');
      return same||replacement;
    });
    if(!destinations.length)throw Error('The recipient has no compatible receiving product for this asset');
    return {source,destinations};
  }
  async resolveRecipient(holder,{address,sourceId}){
    return this.#serial(async()=>{
      const {s}=await this.#load(holder),recipient=await this.#findRecipient(address);
      if(recipient.holder===holder)throw Error('This is your own wallet. Choose Between my products instead.');
      const {destinations}=this.#recipientChoices(s,recipient,sourceId);
      return {address,holder:recipient.holder,label:recipient.label||'Test wallet',labelStatus:'Self-provided wallet label; not verified legal identity',environment:ENVIRONMENT,destinations:clone(destinations)};
    });
  }
  async quoteRecipient(holder,{address,sourceId,destinationId,amount,purpose='',delivery='normal'}){
    return this.#serial(async()=>{
      if(!['normal','lost-reply'].includes(delivery))throw Error('Unsupported recipient delivery mode');
      if(typeof purpose!=='string'||purpose.length>280||/[\u0000-\u001f\u007f]/.test(purpose))throw Error('Payment purpose must be at most 280 characters on one line');
      const {s}=await this.#load(holder),recipient=await this.#findRecipient(address);
      if(recipient.holder===holder)throw Error('Choose another recipient wallet');
      if(s.transactions.some(t=>t.state==='RECOVERY_REQUIRED'))throw Error('Resolve the original pending recovery first');
      const {source,destinations}=this.#recipientChoices(s,recipient,sourceId),destination=destinations.find(p=>p.id===destinationId);
      if(!destination)throw Error('Choose a compatible receiving product');
      validateToken(source);validateToken(destination);
      const quantity=units(amount,source.precision);
      requireCapacity(destination,quantity);
      if(BigInt(quantity)>BigInt(source.available))throw Error('Insufficient available source entitlement');
      const now=this.#now(),id=randomUUID(),replacement=source.institutionId!==destination.institutionId;
      const precheck=requirePrecheck(precheckOperation(s,{sourceId,destinationId,operation:'recipient-transfer',quantityMinor:quantity},now,recipient));
      const routeVersion=replacement?s.routes.find(r=>r.id==='pi-a-b').version:1;
      return this.#record(s,'platform','proposal',id,{
        environment:ENVIRONMENT,standard:STANDARD,precheck,holder,routeId:'recipient-transfer',routeVersion,termsVersion:'recipient-test-1',sequence:s.sequence,
        type:replacement?'recipient transfer with issuer replacement':'recipient transfer of the same instrument',
        quantityUnit:'tokens',source:projectIncome(source,now),destination:projectIncome(destination,now),sourceUnits:quantity,destinationUnits:quantity,feeUnits:'0',taxUnits:'0',delivery,
        recipient:{holder:recipient.holder,address,label:recipient.label||'Test wallet',sequence:recipient.sequence,labelStatus:'Self-provided test label'},
        senderAddress:addressOf(holder),senderLabel:s.label||'Test wallet',purpose:purpose.trim(),
        createdAt:now,expiresAt:precheck.valid_until,reservationDeadline:now+180000,escalationDeadline:now+300000,
        legalGates:[{id:'recipient-directory',satisfied:true,evidence:'Registered in the same local demonstration directory'},{id:'instrument-eligibility',satisfied:true,evidence:'Fictional transfer admission only; no production or country qualification'}],
        disclosures:['Two local test wallets only. No real financial effect.','Recipient label is self-provided, not verified legal identity.'],
        valuation:'1 source token = 1 receiving token under the admitted test route. Separate basket valuation does not change token quantity.',
        confirmationPolicy:{mode:'LOCAL_SIGNED_CONFIRMATION',production:false},
        bindingEvent:'Verified institutional and local finality evidence, followed by durable two-holder commit',
        cancellation:'Before confirmation only; completed transfers are not undone by restoring a wallet backup.',
        recovery:'Query the original instruction. A durable recovery record completes both holder journals without a second debit.',
        terms:{version:'recipient-test-1',law:'Local demonstration only',issuerBefore:source.obligor,issuerAfter:destination.obligor},
        legs:[{id:id+':source',authority:source.institutionId,effect:'Debit sender entitlement'},{id:id+':destination',authority:destination.institutionId,effect:'Credit the identified recipient'}]
      });
    });
  }
  async #executeRecipient(s,proposal,authority,p){
    const recipient=await this.#findRecipient(p.recipient.address);
    if(recipient.holder!==p.recipient.holder||recipient.holder===s.holder||recipient.sequence!==p.recipient.sequence||s.sequence!==p.sequence)throw Error('Sender or recipient state changed; refresh and review again');
    const {source,destinations}=this.#recipientChoices(s,recipient,p.source.id),dest=destinations.find(x=>x.id===p.destination.id);
    if(!dest||digest(principalTerms(source))!==digest(principalTerms(p.source))||digest(principalTerms(dest))!==digest(principalTerms(p.destination))||p.sourceUnits!==p.destinationUnits)throw Error('Instrument or recipient terms changed');
    const current=requirePrecheck(precheckOperation(s,{sourceId:source.id,destinationId:dest.id,operation:'recipient-transfer',quantityMinor:p.sourceUnits},this.#now(),recipient));
    if(current.configuration_hash!==p.precheck.configuration_hash||current.recipient_configuration_hash!==p.precheck.recipient_configuration_hash||current.state_version!==p.precheck.state_version||current.recipient_state_version!==p.precheck.recipient_state_version)throw Error('Precheck configuration or state changed; review again');
    requireCapacity(dest,p.destinationUnits);
    if(source.institutionId!==dest.institutionId&&s.routes.find(r=>r.id==='pi-a-b')?.version!==p.routeVersion)throw Error('Recipient route changed');
    if(BigInt(source.available)<BigInt(p.sourceUnits))throw Error('Insufficient entitlement at execution');
    if(s.transactions.length>=150||(recipient.incoming||[]).length>=150)throw Error('Laboratory transaction limit reached');
    const id=proposal.payload.transitionId,proposalDigest=digest(proposal);
    source.available=(BigInt(source.available)-BigInt(p.sourceUnits)).toString();
    source.reserved=(BigInt(source.reserved)+BigInt(p.sourceUnits)).toString();
    dest.pendingReceipt=(BigInt(dest.pendingReceipt)+BigInt(p.destinationUnits)).toString();
    const t={id,proposal,authority,state:'PENDING_CONFIRMATION',claim:'Awaiting verified confirmation. Recipient can see the amount but cannot spend it.',caseOwner:dest.obligor,records:[]};
    for(const key of new Set([source.institutionId,dest.institutionId]))t.records.push(this.#record(s,key,'institutional-acceptance',id,{proposalDigest,decision:'ACCEPT',scope:'LOCAL RECIPIENT TEST',expiresAt:p.expiresAt}));
    t.records.push(this.#record(s,source.institutionId,'reservation',id,{proposalDigest,quantity:p.sourceUnits,exclusive:true}));
    t.records.push(this.#record(s,'platform','execution-decision',id,{proposalDigest,state:'EXECUTING',recipient:p.recipient.address}));
    s.transactions.push(t);s.sequence++;recipient.sequence++;
    const incoming={id,sourceHolder:s.holder,senderAddress:p.senderAddress,senderLabel:p.senderLabel,recipientAddress:p.recipient.address,positionId:dest.id,instrumentId:dest.instrumentId,institutionId:dest.institutionId,profile:dest.profile,token:clone(dest.token),basketValuation:clone(dest.basketValuation),quantityUnit:'tokens',denomination:dest.denomination,precision:dest.precision,quantity:p.destinationUnits,purpose:p.purpose,proposalDigest,authorityDigest:digest(authority),receivedAt:this.#now(),state:'PENDING_CONFIRMATION'};
    recipient.incoming??=[];recipient.incoming.push(this.#record(recipient,dest.institutionId,'incoming-transfer',id,incoming));
    await commitPair(this.#directory,[s,recipient],(path,value)=>this.#save(path,value),this.#failpoint);
    if(p.delivery==='lost-reply'){const e=Error('Recipient acknowledgement lost after execution');e.code='OUTCOME_UNKNOWN';throw e;}
    return this.#snapshot(s);
  }
  async #advanceRecipientTransfers(holder){
    let {s:current}=await this.#load(holder);
    const candidates=[...current.transactions.filter(t=>t.proposal.payload.body.recipient&&t.state==='PENDING_CONFIRMATION').map(t=>({holder,id:t.id})),
      ...(current.incoming||[]).filter(r=>r.payload.body.state==='PENDING_CONFIRMATION').map(r=>({holder:r.payload.body.sourceHolder,id:r.payload.body.id}))];
    for(const candidate of candidates){
      const {s}=await this.#load(candidate.holder),t=s.transactions.find(t=>t.id===candidate.id);
      if(!t||t.state!=='PENDING_CONFIRMATION')continue;
      const p=t.proposal.payload.body;
      // Confirmation is evidence-driven; no mandatory waiting period.
      if(!await this.#confirmationAvailable(t.id))continue;
      const recipient=await this.#findRecipient(p.recipient.address);
      verifySnapshot(this.#snapshot(s),this.#trust(s),s.holder,this.#now());
      verifySnapshot(this.#snapshot(recipient),this.#trust(recipient),recipient.holder,this.#now());
      const incomingIndex=(recipient.incoming||[]).findIndex(r=>r.payload.body.id===t.id);
      const incoming=recipient.incoming?.[incomingIndex]?.payload.body;
      if(!incoming||incoming.state!=='PENDING_CONFIRMATION'||incoming.proposalDigest!==digest(t.proposal)||incoming.authorityDigest!==digest(t.authority)||incoming.sourceHolder!==s.holder||incoming.quantity!==p.destinationUnits)throw Error('Recipient reservation evidence does not match the original instruction');
      const source=s.positions.find(x=>x.id===p.source.id),dest=recipient.positions.find(x=>x.id===p.destination.id);
      const fields=['id','instrumentId','institutionId','denomination','precision','termsVersion','right','authoritativeRegister'];
      let valid=source&&dest&&recipient.holder===p.recipient.holder&&fields.every(k=>source[k]===p.source[k]&&dest[k]===p.destination[k])&&BigInt(source.reserved)>=BigInt(p.sourceUnits)&&BigInt(dest.pendingReceipt)>=BigInt(p.destinationUnits);
      valid&&=policyReasons(s,source,this.#now()).length===0&&policyReasons(recipient,dest,this.#now()).length===0&&configurationHash(s)===p.precheck?.configuration_hash&&configurationHash(recipient)===p.precheck?.recipient_configuration_hash;
      if(source?.institutionId!==dest?.institutionId)valid&&=s.routes.some(r=>r.id==='pi-a-b'&&r.status==='ACTIVE'&&r.version===p.routeVersion);
      if(!valid){
        t.state='RECOVERY_REQUIRED';t.claim='Confirmation checks changed. Funds remain reserved; the receiving amount is not spendable.';
        t.records.push(this.#record(s,'platform','recovery-record',t.id,{missingLeg:p.legs[1].id,claim:t.claim,caseOwner:t.caseOwner,dueAt:p.escalationDeadline}));
        recipient.incoming[incomingIndex]=this.#record(recipient,incoming.institutionId,'incoming-transfer',t.id,{...incoming,state:'RECOVERY_REQUIRED'});
      }else{
        for(const [index,leg] of p.legs.entries())t.records.push(this.#record(s,leg.authority,'leg-confirmation',t.id,{legId:leg.id,state:'FINAL_TEST',quantity:index?p.destinationUnits:p.sourceUnits,recipient:p.recipient.address,providerReference:leg.id,finalityBasis:'LOCAL TWO-HOLDER TEST ONLY'}));
        const finality=this.#record(s,'platform','laboratory-finality',t.id,{proposalDigest:digest(t.proposal),authorityDigest:digest(t.authority),recipient:p.recipient.address,sourceUnits:p.sourceUnits,destinationUnits:p.destinationUnits,legDigests:t.records.filter(r=>r.payload.kind==='leg-confirmation').map(digest),production:false,basis:'LOCAL_SIMULATION_NOT_BFT'});
        t.records.push(finality);
        t.records.push(this.#record(s,'platform','completion-receipt',t.id,{proposalDigest:digest(t.proposal),recipient:p.recipient.address,sourceUnits:p.sourceUnits,destinationUnits:p.destinationUnits,purpose:p.purpose,finalityDigest:digest(finality)}));
        t.state='COMPLETED';t.claim='Confirmed and credited to the recipient test wallet. No real financial effect.';
        // Verify all required evidence BEFORE making the incoming amount spendable.
        verifySnapshot(this.#snapshot(s),this.#trust(s),s.holder,this.#now());
        const effectiveAt=this.#now();accrueIncome(source,effectiveAt,t.id+':source');accrueIncome(dest,effectiveAt,t.id+':destination');
        source.reserved=(BigInt(source.reserved)-BigInt(p.sourceUnits)).toString();
        if(source.institutionId!==dest.institutionId)source.retired=(BigInt(source.retired)+BigInt(p.sourceUnits)).toString();
        dest.pendingReceipt=(BigInt(dest.pendingReceipt)-BigInt(p.destinationUnits)).toString();
        dest.available=(BigInt(dest.available)+BigInt(p.destinationUnits)).toString();
        recipient.incoming[incomingIndex]=this.#record(recipient,dest.institutionId,'incoming-transfer',t.id,{...incoming,state:'COMPLETED',confirmedAt:this.#now(),finalityDigest:digest(finality),finalityBasis:'LOCAL_SIMULATION_NOT_BFT'});
      }
      s.sequence++;recipient.sequence++;
      await commitPair(this.#directory,[s,recipient],(path,value)=>this.#save(path,value),this.#failpoint);
    }
  }
  // Test harness only: models an independently authorised route suspension.
  async restrictRoute(holder,id,status){return this.#serial(async()=>{if(!['ACTIVE','SUSPENDED'].includes(status))throw Error('Invalid route status');const {s,path}=await this.#load(holder),r=s.routes.find(r=>r.id===id);if(!r)throw Error('Route not found');r.status=status;r.version++;s.sequence++;await this.#save(path,s);return this.#snapshot(s);});}
}
