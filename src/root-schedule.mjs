// Operator-installed PUBLIC root allowlist. It grants no signing or activation
// authority: both existing quorums, exact signer head and chain inclusion remain.
import {canonical,digest} from './protocol.mjs';
import {ZERO} from './epoch-seal.mjs';
import {checkRenewalBody} from './root-renewal.mjs';
export function scheduledBody(schedule,ctx){
 const p=ctx.policy,g=p.history.generation,e=(ctx.last?.body.epoch??-1)+1;
 const roots=schedule?.[g+1];
 if(!roots||ctx.pending||(g>0&&e<=g*p.history.span))return null;
 const b={version:1,chainId:p.chainId,genesis:p.genesis,generation:g,nextGeneration:g+1,activationEpoch:(g+1)*p.history.span,authorizationEpoch:e,head:ctx.last?digest(ctx.last.body):ZERO,roots};
 checkRenewalBody(b,p,ctx.usedRoots);return b;
}
export function scheduledApproval(schedule,body,ctx){
 try{
  checkRenewalBody(body,ctx.policy,ctx.usedRoots);
  return canonical(schedule?.[body.nextGeneration])===canonical(body.roots)&&body.authorizationEpoch===ctx.epoch&&body.head===(ctx.last?digest(ctx.last.body):ZERO);
 }catch{return false;}
}
