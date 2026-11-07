import {createServer} from 'node:http';
import {readFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {VerifiedClient} from './client.mjs';
import {Wallet,balances,outgoingStatus,paymentFee,requestedRecipientDelay} from './wallet.mjs';
import {hash} from './crypto.mjs';
import {unitScale} from './token-units.mjs';
import {paymentQuote,displayAmounts,paymentAmounts,monetaryAnalytics} from './wallet-amounts.mjs';
import {scheduled} from './payment-model.mjs';
import {delayedPaymentsEnabled} from './authority.mjs';
import {WalletStore} from './wallet-store.mjs';
import {RewardWorker} from './reward-worker.mjs';
import {SunPhiConnection} from './sunphi-connection.mjs';
import {SunPhiApproval} from './sunphi-approval.mjs';
import {spendPolicy,protectionEnabled} from './spend-protection.mjs';
const [directory,portArg,trustHash,historyUrl]=process.argv.slice(2),home=resolve(directory),port=Number(portArg??21800);assert(Number.isInteger(port)&&port>=1024&&port<32768);mkdirSync(home,{recursive:true});const read=f=>JSON.parse(readFileSync(join(home,f))),config=read('app-config.json'),policy=read('trust-policy.json');assert.equal(hash(policy),trustHash,'supply the independently authenticated trust-policy hash');const connection=read('connections.json'),binary=resolve(import.meta.dirname,'build','duebyte-abci'+(process.platform==='win32'?'.exe':'')),client=new VerifiedClient({home,config,policy,genesisFile:join(home,'genesis.json'),binary,historyUrl});let wallet=null,owner=null,view=null,checkedAt=null,working=false,error=null;
const store=new WalletStore(home,config.chainId);let lastDiagnostic='',walletBusy=false,activeId=null,sessionToken=null,sessionEpoch=0;
let updateDrainUntil=0;
const sunphi=new SunPhiConnection({config,store});
let approval=null,approvalError=null;
const rewardWorker=new RewardWorker({home,config,store,url:connection.rpc,historyUrl:historyUrl??connection.rpc});let rewardStatus=null;
const publishRewards=()=>process.send?.({rewards:rewardStatus,rewardWallets:store.rewardWallets()});
process.on('message',m=>{if(m?.command!=='reward-wallets')return;try{store.setRewardWallets(m.ids);publishRewards();process.send?.({rewardRequest:m.request,ok:true});void refresh();}catch(e){process.send?.({rewardRequest:m.request,ok:false,error:e.message});}});
process.on('message',m=>{if(m?.command!=='prepare-update'||typeof m.request!=='string')return;const ready=!wallet&&!walletBusy;if(ready)updateDrainUntil=Date.now()+60000;process.send?.({updateRequest:m.request,ready});});
// A browser supplies its own unpredictable session capability. It gains authority
// only after password verification; GET / never reveals another client's token.
let authWindow=Date.now(),authAttempts=0;const actionPermits=new Map();
let presentation=null;
function summarize(v){
 const m=v.state.money,requests=Object.values(m.requests),nodes=Object.values(m.nodes);
 return {height:v.certificate.height,appHeight:v.state.height,blockHash:v.certificate.blockHash,checkpoint:v.checkpointId,...monetaryAnalytics(v.state),outputs:Object.keys(m.outputs).length,workerSeats:nodes.length,operatorGroups:new Set(nodes.map(n=>n.operator)).size,settled:requests.filter(r=>r.status==='SETTLED').length,reserved:requests.filter(r=>r.status==='RESERVED').length,expired:requests.filter(r=>r.status==='EXPIRED').length};
}
function records(){
 if(!wallet)return [];
 const rows=new Map(wallet.db.prepare('SELECT pid,body FROM outgoing').all().map(r=>{const i=JSON.parse(r.body).body.action.signed.intent,status=outgoingStatus(view?.state,i);return [r.pid,{pid:r.pid,status,direction:'Sent',value:i.value,fee:paymentFee(i,status),...paymentAmounts(i,paymentFee(i,status)),feeLabel:status==='NOT_SUBMITTED'?'Fee charged':'Estimated fee'}];}));
 if(view)for(const [pid,r] of Object.entries({...wallet.terminalRecords(),...view.state.money.requests}))if(r.intent.sender===owner||r.intent.recipient===owner)rows.set(pid,{pid,status:r.status,direction:r.intent.sender===owner?'Sent':'Received',value:r.intent.value,fee:paymentFee(r.intent,r.status),...paymentAmounts(r.intent,paymentFee(r.intent,r.status)),feeLabel:['EXPIRED','CANCELLED'].includes(r.status)?'Release fee':['RESERVED','SCHEDULED'].includes(r.status)?'Estimated fee':'Network fee',recipient:r.intent.recipient,height:r.terminalHeight,scheduled:scheduled(r.intent),executeAt:r.executeAt??null,recipientDelay:r.intent.delay,cancelFee:r.intent.abortFee,canCancel:scheduled(r.intent)&&r.intent.sender===owner&&['RESERVED','SCHEDULED'].includes(r.status)&&(!r.executeAt||view.state.money.time<r.executeAt),cancellationPending:!!wallet.db.prepare('SELECT 1 FROM cancellations WHERE pid=?').get(pid)&&['RESERVED','SCHEDULED'].includes(r.status)});
 for(const row of rows.values())if(row.status==='QUEUED'&&(spendPolicy(view?.state??{},owner)?.enabled||wallet.db.prepare('SELECT 1 FROM approval_guard WHERE pid=?').get(row.pid))){row.status='AWAITING_APPROVAL';row.canRequestApproval=!!spendPolicy(view?.state??{},owner)?.enabled&&!(approval?.rows()??[]).some(a=>a.pid===row.pid&&['opening','pending','submitted'].includes(a.status)&&a.expires>Date.now()/1000);}
 return [...rows.values()].sort((a,b)=>(b.height??0)-(a.height??0)).slice(0,200);
}
function userError(e){const detail=e.message??'verification failed';if(detail!==lastDiagnostic){console.error(detail);lastDiagnostic=detail;}if(/expired|future trust/.test(detail))return 'The checkpoint has expired. Waiting for an update from the trusted signers.';if(/local history is not ready yet|source behind retained history/.test(detail))return 'Your node is downloading verified history. Keep it connected; verification will retry automatically.';if(/fetch failed|post failed|connect|Command failed/i.test(detail))return 'Node connection temporarily unavailable. Your last verified data is retained; sending will resume after verification.';return 'Verification incomplete. Sending is paused; details are saved in the local log.';}
async function refresh(){if(working)return;working=true;try{view=await client.sync(read('checkpoint.json'),connection.rpc);checkedAt=Date.now();error=null;
 try{rewardStatus=await rewardWorker.tick(view);}catch{rewardStatus={...rewardStatus,message:'Reward synchronisation will retry automatically. Saved earnings are retained.'};}publishRewards();
 const active=wallet;if(active){walletBusy=true;try{active.recoverPending(view);try{await approval?.sync();approvalError=null;}catch{approvalError='Sun·Phi approval is pending. Your wallet will retry without bypassing the required signature.';}let processed=0;for(const row of active.db.prepare('SELECT pid,body FROM outgoing ORDER BY pid').all()){const status=outgoingStatus(view.state,JSON.parse(row.body).body.action.signed.intent);if(status!=='SETTLED'&&status!=='EXPIRED'&&status!=='CANCELLED'&&status!=='NOT_SUBMITTED'&&status!=='HISTORY_UNAVAILABLE'&&status!=='REVIEW_REQUIRED'&&(status!=='SCHEDULED'||active.db.prepare('SELECT 1 FROM cancellations WHERE pid=?').get(row.pid))){if(processed++>=16)break;try{await active.resume(row.pid);}catch(e){error=userError(e);}}}}finally{walletBusy=false;}}}catch(e){error=userError(e);}finally{working=false;}}
function status(){if(view&&presentation?.source!==view)presentation={source:view,value:summarize(view)};return {trialOnly:true,network:config.chainId,locked:!wallet,hasVault:store.list().length>0,wallets:store.list(),selectedWallet:store.selected()?.id??null,activeWallet:activeId,owner,working,checkedAt,error,height:view?.certificate.height??null,unitScale:view?String(unitScale(view.state)):null,balance:view&&owner?{...balances(view.state,owner),display:displayAmounts(balances(view.state,owner),String(unitScale(view.state)))}:null,analytics:presentation?.value??null,payments:records(),rewards:rewardStatus,sunphi:activeId?{...sunphi.view(activeId,view?spendPolicy(view.state,owner):null),requests:approval?.rows()??[],message:approvalError}:null,features:{sunphiNotifications:true,sunphiApproval:!!view&&protectionEnabled(view.state),delayedPayments:!!view&&delayedPaymentsEnabled(view.state),spendProtection:!!view&&protectionEnabled(view.state)},networkTime:view?.state.money.time??null};}
const server=createServer(async(req,res)=>{try{assert.equal(req.headers.host,`127.0.0.1:${port}`,'host');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
 if(req.method==='GET'&&req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(readFileSync(join(import.meta.dirname,'wallet.html'),'utf8'));return;}
 if(req.method==='GET'&&req.url.startsWith('/brand/')){const name=req.url.slice(7);assert(['sunphi-windows.png','sunphi-mark.svg','sunphi-mark-light.svg','duebyte-window.css','duebyte-app.png','duebyte-brand.css','duebyte-coin.css','duebyte-coin-v1.png','duebyte-coin-back-v1.png','duebyte-light-v1.png','duebyte-dark-v1.png','duebyte-wordmark-dark-20261103.png','duebyte-wordmark-light-20261103.png','inter.woff2'].includes(name));res.setHeader('Content-Type',name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':name.endsWith('.svg')?'image/svg+xml':'font/woff2');res.end(readFileSync(join(import.meta.dirname,'../desktop/brand',name)));return;}
 const token=req.headers['x-duebyte-token'];assert(typeof token==='string'&&/^[a-f0-9]{64}$/.test(token),'local session');if(req.headers.origin)assert.equal(req.headers.origin,`http://127.0.0.1:${port}`,'origin');
 assert(!req.headers['sec-fetch-site']||['same-origin','none'].includes(req.headers['sec-fetch-site']),'cross-site request');
 if(wallet)assert.equal(token,sessionToken,'Wallet is open in another session. Lock it there first.');
 if(!wallet)assert(['/status','/unlock','/create','/restore','/select-wallet','/lock'].includes(req.url),'unlock your wallet first');
 if(req.method==='GET'&&req.url==='/backup'){assert(wallet,'unlock your wallet first');res.setHeader('Content-Type','application/json');res.end(JSON.stringify(store.backup(activeId),null,2));return;}
 if(req.method==='GET'&&req.url==='/status'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(status()));return;}
 // Reading the request body yields to lock/unlock and wallet-selection requests.
 // Bind admission to this session lifetime, including when the same token is reused.
 const admittedEpoch=sessionEpoch;
 assert.equal(req.method,'POST');let size=0,chunks=[];for await(const b of req){size+=b.length;assert(size<=16384);chunks.push(b);}const q=JSON.parse(Buffer.concat(chunks));
 assert.equal(admittedEpoch,sessionEpoch,'Wallet session changed. Retry the action in the current session.');
 assert(Date.now()>=updateDrainUntil,'The node is installing an update. Please reopen the wallet after it restarts.');
 if(wallet)assert.equal(token,sessionToken,'Wallet is open in another session. Lock it there first.');
 if(!wallet)assert(['/status','/unlock','/create','/restore','/select-wallet','/lock'].includes(req.url),'unlock your wallet first');
 if(['/unlock','/create','/restore'].includes(req.url)){
  if(Date.now()-authWindow>=60000){authWindow=Date.now();authAttempts=0;}
  assert(++authAttempts<=20,'Too many password attempts. Wait one minute.');
 }
 if(req.url==='/authorize-action'){
  assert(wallet&&['/send','/cancel-payment'].includes(q.path),'payment action required');
  if(q.path==='/send')requestedRecipientDelay(q.data);
  else assert(q.data&&Object.keys(q.data).length===1&&typeof q.data.pid==='string','payment reference required');
  for(const [key,p]of actionPermits)if(p.expires<Date.now())actionPermits.delete(key);
  assert(actionPermits.size<8,'Too many pending confirmations.');
  const permit=randomBytes(32).toString('hex');actionPermits.set(permit,{digest:hash({path:q.path,data:q.data,activeId,sessionToken}),expires:Date.now()+30000});
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({permit}));return;
 }
 if(['/send','/cancel-payment'].includes(req.url)){
  const id=req.headers['x-duebyte-action'],permit=actionPermits.get(id);actionPermits.delete(id);
  assert(permit&&permit.expires>=Date.now()&&permit.digest===hash({path:req.url,data:q,activeId,sessionToken}),'Confirmation expired or changed. Review the payment again.');
 }
 if(req.url==='/restore'){
  assert(!wallet&&!walletBusy,'Lock the current wallet before restoring another.');store.restore(q.backup,q.password,q.name);sessionEpoch++;
 }else if(req.url==='/unlock'||req.url==='/create'){
  assert(!wallet&&!walletBusy,'Lock the current wallet before opening another.');
  const id=req.url==='/create'?store.create(q.password,q.name).id:(q.walletId??store.selected()?.id);
  const key=store.unlock(id,q.password),opened=new Wallet({client,key,home:store.directory(id),routes:connection.workers,url:connection.rpc,checkpoint:()=>read('checkpoint.json')});owner=key.publicKey;activeId=id;wallet=opened;approval=new SunPhiApproval({connection:sunphi,wallet:opened,store,walletId:id,checkpoint:()=>read('checkpoint.json')});approvalError=null;sessionToken=token;sessionEpoch++;actionPermits.clear();void refresh();
 }else if(req.url==='/lock'||req.url==='/select-wallet'){assert(!walletBusy,'wait for current operation');if(req.url==='/select-wallet')store.get(q.walletId);wallet?.close();wallet=null;approval=null;approvalError=null;owner=null;activeId=null;sessionToken=null;sessionEpoch++;actionPermits.clear();if(req.url==='/select-wallet')store.select(q.walletId);}
 else if(req.url==='/quote'){assert(wallet&&!error&&checkedAt&&view,'wallet not ready');requestedRecipientDelay(q);const quote=paymentQuote(view.state,q.value,q.unitScale);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(quote));return;}
 else if(req.url==='/send'){assert(wallet&&!working&&checkedAt&&!error,'wallet not ready');const delay=requestedRecipientDelay(q);working=true;walletBusy=true;try{const p=await wallet.prepareTokens(q);const outcome=await wallet.resume(p.pid);if(outcome.status==='AWAITING_APPROVAL')await approval.payment(p.pid);}finally{working=false;walletBusy=false;}}
 else if(req.url==='/cancel-payment'){assert(wallet&&!working&&checkedAt&&!error,'wallet not ready');assert(Object.keys(q).length===1&&typeof q.pid==='string','payment reference required');working=true;walletBusy=true;try{await wallet.cancel(q.pid);}finally{working=false;walletBusy=false;}}
 else if(req.url.startsWith('/sunphi/')){
  assert(wallet&&!working&&!walletBusy,'Wait for the current wallet operation.');
  const action=req.url.slice(8),fields={start:[],check:[],confirm:['accountId'],notifications:['enabled'],approval:['enabled'],'payment-approval':['pid'],disconnect:[]};assert(Object.hasOwn(fields,action),'Unknown Sun·Phi action.');assert.deepEqual(Object.keys(q).sort(),fields[action]);
  working=true;walletBusy=true;try{
   if(action==='start')await sunphi.start(activeId,wallet.key);
   else if(action==='check')await sunphi.refresh(activeId,wallet.key);
   else if(action==='confirm')await sunphi.confirm(activeId,wallet.key,q.accountId);
   else if(action==='notifications')await sunphi.notifications(activeId,wallet.key,q.enabled);
   else if(action==='approval')await approval.policy(q.enabled);
   else if(action==='payment-approval')await approval.payment(q.pid);
   else {const current=await wallet.view();await sunphi.revoke(activeId,wallet.key,spendPolicy(current.state,owner));}
   assert.equal(admittedEpoch,sessionEpoch,'Wallet session changed.');
  }finally{working=false;walletBusy=false;}
 }
 else if(req.url==='/refresh')void refresh();else assert.fail('unknown action');
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify(status()));
 }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}});
server.requestTimeout=15000;server.listen(port,'127.0.0.1',()=>{console.log(`DueByte wallet: http://127.0.0.1:${port}`);process.send?.({ready:port});void refresh();});const timer=setInterval(()=>void refresh(),5000);
process.on('SIGTERM',()=>{clearInterval(timer);server.close(()=>{wallet?.close();store.close();client.close();process.exit(0);});});
