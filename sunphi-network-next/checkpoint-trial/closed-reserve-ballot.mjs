import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {exact,hash,integer,verify} from './crypto.mjs';
import {closedReserveTerms} from './research/closed-network-reserve.mjs';
import {developmentManager} from './reserve-recovery.mjs';
import {verifyValidatorApprovals} from './validator-authority.mjs';

export function publishedReserveBallot(){
 try{return JSON.parse(readFileSync(new URL('./public-closed-reserve-ballot.json',import.meta.url),'utf8'));}
 catch(e){if(e.code==='ENOENT')return null;throw e;}
}

export function reviewClosedReserve(packet,state,network,signer){
 exact(packet,['body','approvals','managerConsent']);
 const {body,approvals}=packet;
 const terms=closedReserveTerms(state,network);
 assert.deepEqual(body,{...terms,notBefore:body.notBefore,expires:body.expires});
 integer(body.notBefore,1);integer(body.expires,body.notBefore+1);
 assert(body.expires<=terms.programmeStart&&body.expires-body.notBefore<=7*86400);
 assert(verify(body,packet.managerConsent,developmentManager(state.networkReserves)),'Invalid reserve management consent.');
 const members=state.authority.validators,tally=verifyValidatorApprovals(body,approvals,members);
 const expired=state.money.time>=body.expires,available=state.money.time>=body.notBefore&&!expired;
 const approved=tally.power>=tally.threshold,member=members.some(m=>m.key===signer),voted=approvals.some(v=>v.key===signer);
 return {kind:'closed-reserve',proposal:hash(body),network,height:state.height,weight:String(tally.power),
  required:String(tally.threshold),expired,available,approved,member,voted,canSign:available&&!approved&&member&&!voted,
  canSubmit:available&&approved};
}
