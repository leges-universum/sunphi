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

const inboxUrl='https://raw.githubusercontent.com/leges-universum/sunphi/duebyte-updates-stable/governance/financial-ballots.json';
let inboxCache;
export async function financialBallots(network, fetcher=fetch){
 if(inboxCache?.network===network&&Date.now()<inboxCache.until)return inboxCache.packets;
 const reply=await fetcher(inboxUrl,{redirect:'error',signal:AbortSignal.timeout(6000)});
 assert(reply.ok,'The financial voting inbox is temporarily unavailable.');
 const chunks=[];let size=0;
 for await(const chunk of reply.body){
  size+=chunk.length;assert(size<=262144,'Voting inbox exceeds the size limit.');chunks.push(chunk);
 }
 const inbox=JSON.parse(Buffer.concat(chunks));
 assert(inbox.schema===1&&inbox.network===network&&Array.isArray(inbox.ballots)&&inbox.ballots.length<=32,'Invalid voting inbox.');
 const packets=inbox.ballots.filter(packet=>packet?.body?.network===network&&packet.body.domain==='PREPARE_OPEN_VALIDATOR_RESERVE_V3');
 inboxCache={network,packets,until:Date.now()+30000};
 return packets;
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
