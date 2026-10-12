import {sign, verify} from 'node:crypto';
import {canonical, digest, identity, publicKey, decode64, exact, addressOf} from '../wallet/crypto.mjs';

export const ENVIRONMENT='sunphi-procedure-lab-v1';
export const STANDARD='SPHI STD 001 1.1 RC3';
const supportedStandards=[STANDARD,'SPHI STD 001 1.1 RC2'];
export const MAX_UNITS=10n**24n;
export function units(value,precision){
  if(!Number.isInteger(precision)||precision<0||precision>12||typeof value!=='string'||!/^\d{1,24}(?:\.\d{1,12})?$/.test(value))throw Error('Enter a positive decimal amount without separators or exponent notation');
  const [whole,fraction='']=value.split('.');if(fraction.length>precision)throw Error(`This instrument allows ${precision} decimal places`);
  const n=BigInt(whole)*10n**BigInt(precision)+BigInt(fraction.padEnd(precision,'0')||'0');
  if(n<=0n||n>MAX_UNITS)throw Error('Amount is outside the supported limit');return n.toString();
}
export function signEvidence(key,keyId,kind,holder,transitionId,body,at){
  const payload={domain:ENVIRONMENT,kind,holder,transitionId,at,body};
  return {keyId,payload,signature:sign(null,Buffer.from(canonical(payload)),key).toString('base64')};
}
export function checkEvidence(record,trust,{kind,holder,transitionId,keyId}={}){
  exact(record,['keyId','payload','signature']);const p=record.payload;
  exact(p,['domain','kind','holder','transitionId','at','body']);
  if(p.domain!==ENVIRONMENT||!Number.isSafeInteger(p.at)||p.at<0||!trust[record.keyId]||(kind&&p.kind!==kind)||(holder&&p.holder!==holder)||(transitionId&&p.transitionId!==transitionId)||(keyId&&record.keyId!==keyId)||!verify(null,Buffer.from(canonical(p)),publicKey(trust[record.keyId]),decode64(record.signature,64)))throw Error('Untrusted procedure evidence or wrong signing context');
  return p.body;
}
export function consent(key,proposal,at){
  const holder=identity(key).publicKey;
  if(proposal.payload.holder!==holder)throw Error('Proposal belongs to another holder');
  return signEvidence(key,'holder','holder-authority',holder,proposal.payload.transitionId,{proposalDigest:digest(proposal),termsVersion:proposal.payload.body.termsVersion,expiresAt:proposal.payload.body.expiresAt,scope:'single exact proposal'},at);
}
export function verifyConsent(record,proposal,now){
  const holder=proposal.payload.holder,b=checkEvidence(record,{holder},{kind:'holder-authority',holder,transitionId:proposal.payload.transitionId,keyId:'holder'});
  if(b.proposalDigest!==digest(proposal)||b.expiresAt!==proposal.payload.body.expiresAt||b.termsVersion!==proposal.payload.body.termsVersion||b.scope!=='single exact proposal'||b.expiresAt<=now)throw Error('Consent changed or expired');return b;
}
export function checkProposal(record,trust,holder,now){
  const p=checkEvidence(record,trust,{kind:'proposal',holder,keyId:'platform'});
  if(p.environment!==ENVIRONMENT||!supportedStandards.includes(p.standard)||p.expiresAt<=now||p.createdAt>now+5000||p.createdAt>p.expiresAt||!p.routeId||!p.source||!p.destination||!Array.isArray(p.legalGates)||p.legalGates.some(g=>g.satisfied!==true))throw Error('Proposal expired or legal conditions not satisfied');
  if(!/^[1-9]\d*$/.test(p.sourceUnits)||!/^[1-9]\d*$/.test(p.destinationUnits))throw Error('Invalid proposal quantities');
  if(p.recipient){if(p.recipient.holder===holder||p.recipient.address!==addressOf(p.recipient.holder)||p.senderAddress!==addressOf(holder)||typeof p.purpose!=='string'||p.purpose.length>280)throw Error('Invalid recipient binding');}
  return p;
}
export function verifySnapshot(record,trust,holder,now,{allowStale=false,minSequence=0}={}){
  const s=checkEvidence(record,trust,{kind:'snapshot',holder,keyId:'platform'});
  if(s.environment!==ENVIRONMENT||!supportedStandards.includes(s.standard)||s.holder!==holder||!Number.isSafeInteger(s.sequence)||s.sequence<minSequence||s.asOf>now+5000||s.expiresAt<=s.asOf||(!allowStale&&s.expiresAt<=now)||!Array.isArray(s.positions)||!Array.isArray(s.transactions)||!Array.isArray(s.routes))throw Error('Stale, rolled-back or invalid institution snapshot');
  if(new Set(s.positions.map(p=>p.id)).size!==s.positions.length||new Set(s.transactions.map(t=>t.id)).size!==s.transactions.length)throw Error('Duplicate positions or instructions');
  for(const p of s.positions)for(const field of ['available','reserved','pendingReceipt','retired']){
    if(typeof p[field]!=='string'||!/^\d+$/.test(p[field])||BigInt(p[field])>MAX_UNITS)throw Error('Invalid position quantity');
  }
  for(const t of s.transactions){
    const p=checkEvidence(t.proposal,trust,{kind:'proposal',holder,transitionId:t.id,keyId:'platform'});
    checkEvidence(t.authority,{holder},{kind:'holder-authority',holder,transitionId:t.id,keyId:'holder'});
    if(t.authority.payload.body.proposalDigest!==digest(t.proposal))throw Error('Consent does not match the accepted proposal');
    if(!Array.isArray(t.records)||!Array.isArray(p.legs)||p.legs.length!==2||new Set(p.legs.map(l=>l.id)).size!==2)throw Error('Invalid procedure evidence structure');
    for(const r of t.records)checkEvidence(r,trust,{holder,transitionId:t.id});
    const proposalHash=digest(t.proposal),authority=t.authority.payload;
    if(authority.at>p.expiresAt||authority.body.expiresAt!==p.expiresAt||authority.body.termsVersion!==p.termsVersion||authority.body.scope!=='single exact proposal')throw Error('Invalid authority scope or term');
    for(const key of new Set([p.source.institutionId,p.destination.institutionId])){
      const accepted=t.records.filter(r=>r.payload.kind==='institutional-acceptance'&&r.keyId===key);
      if(accepted.length!==1||accepted[0].payload.body.proposalDigest!==proposalHash||accepted[0].payload.body.decision!=='ACCEPT')throw Error('Missing matching institutional acceptance');
    }
    for(const [kind,key] of [['reservation',p.source.institutionId],['execution-decision','platform']]){
      const records=t.records.filter(r=>r.payload.kind===kind&&r.keyId===key);
      if(records.length!==1||records[0].payload.body.proposalDigest!==proposalHash)throw Error('Missing matching reservation or execution decision');
    }
    for(const [index,leg] of p.legs.entries()){
      const records=t.records.filter(r=>r.payload.kind==='leg-confirmation'&&r.payload.body.legId===leg.id);
      if(((!p.recipient&&index===0)||t.state==='COMPLETED')&&records.length!==1)throw Error('Missing distinct authoritative leg');
      if(records.length>1||records.some(r=>r.keyId!==leg.authority||r.payload.body.state!=='FINAL_TEST'||r.payload.body.quantity!==(index===0?p.sourceUnits:p.destinationUnits)))throw Error('Wrong leg authority, quantity or result');
    }
    if(!['COMPLETED','RECOVERY_REQUIRED',...(p.recipient?['PENDING_CONFIRMATION']:[])].includes(t.state)||p.environment!==ENVIRONMENT)throw Error('Unsupported adapter result');
    const completions=t.records.filter(r=>r.payload.kind==='completion-receipt');
    if(t.state==='COMPLETED'&&(completions.length!==1||completions[0].keyId!=='platform'||completions[0].payload.body.proposalDigest!==proposalHash))throw Error('Missing authoritative completion evidence');
    if(p.recipient){
      if(t.state==='PENDING_CONFIRMATION'&&(completions.length||t.records.some(r=>['leg-confirmation','laboratory-finality'].includes(r.payload.kind))))throw Error('Pending transfer cannot carry final completion');
      if(t.state==='COMPLETED'){
        const proofs=t.records.filter(r=>r.payload.kind==='laboratory-finality'),f=proofs[0],b=f?.payload.body;
        if(proofs.length!==1||f.keyId!=='platform'||b.production!==false||b.basis!=='LOCAL_SIMULATION_NOT_BFT'||b.proposalDigest!==proposalHash||b.authorityDigest!==digest(t.authority)||b.recipient!==p.recipient.address||b.sourceUnits!==p.sourceUnits||b.destinationUnits!==p.destinationUnits||digest(b.legDigests)!==digest(t.records.filter(r=>r.payload.kind==='leg-confirmation').map(digest))||completions[0].payload.body.finalityDigest!==digest(f))throw Error('Missing or mismatched finality evidence');
      }
    }
    if(t.state==='RECOVERY_REQUIRED'&&(completions.length||!t.records.some(r=>r.keyId==='platform'&&r.payload.kind==='recovery-record'&&r.payload.body.missingLeg===p.legs[1].id)))throw Error('Missing recovery case or conflicting completion');
  }
  if(s.incoming!==undefined){
    if(!Array.isArray(s.incoming)||s.incoming.length>150||new Set(s.incoming.map(r=>r.payload?.transitionId)).size!==s.incoming.length)throw Error('Invalid incoming transfer history');
    for(const record of s.incoming){
      const b=checkEvidence(record,trust,{kind:'incoming-transfer',holder});
      if(!['PENDING_CONFIRMATION','RECOVERY_REQUIRED','COMPLETED'].includes(b.state))throw Error('Invalid incoming transfer state');
      if(b.state==='COMPLETED'&&(!/^[a-f0-9]{64}$/.test(b.finalityDigest)||!Number.isSafeInteger(b.confirmedAt)||b.confirmedAt<b.receivedAt||b.finalityBasis!=='LOCAL_SIMULATION_NOT_BFT'))throw Error('Missing incoming finality confirmation');
      if(b.state!=='COMPLETED'&&(b.confirmedAt!==undefined||b.finalityDigest!==undefined))throw Error('Pending receipt cannot claim finality');
      const position=s.positions.find(p=>p.id===b.positionId);
      if(!position||record.keyId!==position.institutionId||b.institutionId!==position.institutionId||b.recipientAddress!==addressOf(holder)||b.senderAddress!==addressOf(b.sourceHolder)||b.sourceHolder===holder||b.id!==record.payload.transitionId||b.instrumentId!==position.instrumentId||b.denomination!==position.denomination||b.precision!==position.precision||!/^[1-9]\d*$/.test(b.quantity)||typeof b.purpose!=='string'||b.purpose.length>280||!/^([a-f0-9]{64})$/.test(b.proposalDigest)||!/^([a-f0-9]{64})$/.test(b.authorityDigest))throw Error('Invalid incoming transfer evidence');
    }
  }
  return structuredClone(s);
}
