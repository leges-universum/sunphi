import {verificationFailure} from './verification-failure.mjs';
import { DesktopSession } from './session.mjs';
import {BackgroundVerification} from './background-verification.mjs';
import {balanceView} from './balance-view.mjs';
const session=new DesktopSession({root:process.argv[2],profile:process.argv[3]});
const background=new BackgroundVerification(session);
let stopping=false;
// Public counters only; no keys, paths or balances cross this unsolicited channel.
const idleProgress=setInterval(()=>{if(stopping||!process.connected)return;const s=background.view();process.send({type:'verification-idle',value:{locked:s.locked,epoch:s.network?.checkpointEpoch,scanned:s.balance?.scanned,complete:balanceView(s).fresh}});},1000);
process.on('message',async m=>{
 if(stopping||!m||!Number.isSafeInteger(m.id))return;
 try{const value=await background.request(m.action,m.args);if(process.connected)process.send({id:m.id,ok:true,value});}
 catch(e){if(m.action==='refresh'){if(process.connected)process.send({id:m.id,ok:false,error:'Network verification is incomplete.',verification:verificationFailure(e)});return;}const safe=['History / fresh quorum not yet verified. Saved progress is retained; keep the node connected and check again. No payment was sent.','Insufficient verified available funds','Funds are fragmented: this proof accepts at most two inputs; consolidation is required','Discovery incomplete or stale; finish checking incoming payments first','Fresh network evidence is unavailable. No new payment was sent.','Choose and review a signed invoice first','incoming receipt capacity reached'];if(process.connected)process.send({id:m.id,ok:false,error:safe.includes(e.message)?e.message:'Operation could not be completed. Check the selected file, password and network availability. Existing wallet data has not been replaced.'});}
});
async function stop(){if(stopping)return;stopping=true;clearInterval(idleProgress);await background.close();process.exit(0);}
process.on('disconnect',stop);process.on('SIGTERM',stop);
