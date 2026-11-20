import {createServer} from 'node:http';
import {readFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {VerifiedClient} from './client.mjs';
import {Wallet,balances,outgoingStatus,paymentFee,requestedRecipientDelay} from './wallet.mjs';
import {WalletPreparationError} from './wallet-inputs.mjs';
import {WalletWorkError} from './wallet-work.mjs';
let paymentNotice=null;
import {hash,sign,exact} from './crypto.mjs';
import {paymentTariffStatus} from './payment-tariff.mjs';
import {unitScale} from './token-units.mjs';
import {displayAmounts,paymentAmounts} from './wallet-amounts.mjs';
import {scheduled} from './payment-model.mjs';
import {delayedPaymentsEnabled} from './authority.mjs';
import {WalletStore} from './wallet-store.mjs';
import {envelope} from './core.mjs';
import {candidateConsent,seatMandate,servingExperts,seatsAt,walletBallotActions} from './research/operator-ballots.mjs';
import {WalletSessionDrain,WalletPaymentLane} from './wallet-session-drain.mjs';
const sessionDrain=new WalletSessionDrain(),paymentLane=new WalletPaymentLane();
import {RewardWorker} from './reward-worker.mjs';
import {homeAdmissionClient} from './home-admission-service.mjs';
import {verificationTraffic} from './verification-traffic.mjs';
import {NetworkActivity} from './consumer-view.mjs';
import {BOUNDED_HOME,homeVerification} from './home-verification.mjs';
import {recoveryPresentation} from './home-recovery.mjs';
import {SunPhiConnection} from './sunphi-connection.mjs';
import {SunPhiApproval} from './sunphi-approval.mjs';
import {spendPolicy,protectionEnabled} from './spend-protection.mjs';
import {walletAnalytics} from './research/bounded-wallet-presentation.mjs';
import {WalletFunding} from './wallet-funding.mjs';
import {WalletBond} from './wallet-bond.mjs';
const bondSessions=new WeakMap();
const ruleReviewSessions=new WeakMap();
import {WalletRuleReviews} from './wallet-rule-review.mjs';
import {recentBlockSignatures} from './wallet-block-votes.mjs';
let collateral=null;
import {WalletNodeLinks,walletNodeOverview} from './wallet-node-links.mjs';
let nodeLinks=null;
import {WalletNodeAlerts} from './wallet-node-alerts.mjs';
let nodeAlerts=null;
import {WalletPurchase} from './wallet-protected-purchase.mjs';
import {CommittedPurchaseReader} from './research/purchase-service.mjs';
let purchase=null;
import {WalletExchange,exchangeLabTransport} from './wallet-exchange.mjs';
let exchange=null;
import {WalletBroker} from './wallet-broker.mjs';
let broker=null;
import {WalletSeller} from './wallet-seller.mjs';
import {portfolio,checkAssetProfile,observePortfolio} from './wallet-assets.mjs';
import {referencePriceFeed,checkPublicReceipt} from './wallet-public-markets.mjs';
const marketPrices=referencePriceFeed();
let checkingPublicReceipt=false;
let assetCache=null;
let seller=null;
let recoveryProgress=null;
const [directory,portArg,trustHash,historyUrl]=process.argv.slice(2),home=resolve(directory),port=Number(portArg??21800);assert(Number.isInteger(port)&&port>=1024&&port<32768);mkdirSync(home,{recursive:true});const read=f=>JSON.parse(readFileSync(join(home,f))),config=read('app-config.json'),policy=read('trust-policy.json');assert.equal(hash(policy),trustHash,'supply the independently authenticated trust-policy hash');const bounded=readWalletProfile(home);const connection=read('connections.json'),binary=resolve(import.meta.dirname,'build','duebyte-abci'+(process.platform==='win32'?'.exe':'')),client=new VerifiedClient({home,config,policy,genesisFile:join(home,'genesis.json'),binary,historyUrl,...(bounded?{bounded}:{})});let wallet=null,owner=null,view=null,checkedAt=null,working=false,error=null;
const store=new WalletStore(home,config.chainId);let lastDiagnostic='',walletBusy=false,activeId=null,sessionToken=null,sessionEpoch=0;
client.onProgress=p=>{recoveryProgress=p;if(bounded)process.send?.({recoveryProgress:p});};
let updateDrainUntil=0;
const sunphi=new SunPhiConnection({config,store});
let approval=null,approvalError=null;
const verifierActivity=new NetworkActivity();
const trafficMeter=bounded?verificationTraffic([connection.rpc,historyUrl,bounded.url]):null;
let nodeActivity=null;
process.on('message',m=>{if(!bounded&&m?.command==='node-activity')nodeActivity=m.activity;});
const admissionUrls=connection.homeAdmission?.urls??[...new Set([connection.rpc,...(bounded&&historyUrl?[historyUrl]:[])])];
const rewardWorker=new RewardWorker({home,config,store,url:connection.rpc,historyUrl:historyUrl??connection.rpc,recordProofReader:(root,key)=>client.homeRecordProof(root,key),serviceWorkReader:(certificate,node)=>client.serviceWorkView(certificate,node),admissionTransport:homeAdmissionClient(admissionUrls)});let rewardStatus=null;
// Saved payout choices are local metadata; their visibility must not depend on
// network verification. Reward accounting still comes only from verified state.
const publishRewards=()=>process.send?.({rewards:rewardStatus,rewardWallets:store.rewardWallets()});
process.on('message',m=>{if(m?.command!=='reward-wallets')return;try{store.setRewardWallets(m.ids);publishRewards();process.send?.({rewardRequest:m.request,ok:true});void refresh();}catch(e){process.send?.({rewardRequest:m.request,ok:false,error:e.message});}});
process.on('message',m=>{if(m?.command!=='prepare-update'||typeof m.request!=='string')return;const ready=!wallet&&!walletBusy;if(ready)updateDrainUntil=Date.now()+60000;process.send?.({updateRequest:m.request,ready});});
// A browser supplies its own unpredictable session capability. It gains authority
// only after password verification; GET / never reveals another client's token.
let authWindow=Date.now(),authAttempts=0;const actionPermits=new Map();
let presentation=null,verifiedHeight=null;
let analyticsRead=null,analyticsCache=null;
async function networkPresentation(current,account){
 const root=current.certificate.appHash;
 const present=totals=>({...walletAnalytics(current,totals),networkStatus:totals.networkStatus});
 if(analyticsCache?.root===root && (analyticsCache.complete||Date.now()<analyticsCache.retryAt))return present(analyticsCache.totals);
 if(analyticsRead)return analyticsRead.root===root?present(await analyticsRead.promise):walletAnalytics(current);
 const promise=(async()=>{
  let totals;
  try{totals=await client.networkTotals(current,account);}
  catch{totals={networkStatus:'retry'};}
  analyticsCache={root,totals,complete:totals.settled!==undefined,retryAt:Date.now()+2000};
  return totals;
 })();
 analyticsRead={root,promise};
 try{return present(await promise);}finally{analyticsRead=null;}
}
function summarize(v){
 return walletAnalytics(v);
}
function clearIndexedView(){paymentNotice=null;if(bounded){view=null;presentation=null;verifiedHeight=null;checkedAt=null;error=null;}}
function historyRecord(pid,r,state){return {pid,status:r.status,direction:r.intent.sender===owner?'Sent':'Received',value:r.intent.value,fee:paymentFee(r.intent,r.status),...paymentAmounts(r.intent,paymentFee(r.intent,r.status)),feeLabel:['EXPIRED','CANCELLED'].includes(r.status)?'Release fee':['RESERVED','SCHEDULED'].includes(r.status)?'Estimated fee':'Network fee',sender:r.intent.sender,recipient:r.intent.recipient,height:r.terminalHeight,scheduled:scheduled(r.intent),executeAt:r.executeAt??null,recipientDelay:r.intent.delay,cancelFee:r.intent.abortFee,canCancel:scheduled(r.intent)&&r.intent.sender===owner&&['RESERVED','SCHEDULED'].includes(r.status)&&(!r.executeAt||state.money.time<r.executeAt),cancellationPending:!!wallet.db.prepare('SELECT 1 FROM cancellations WHERE pid=?').get(pid)&&['RESERVED','SCHEDULED'].includes(r.status)};}
function indexedHistory(){if(!wallet||!view?.history)return null;return {...view.history,items:undefined,rows:view.history.items.map(({id,value})=>historyRecord(id,value,view.state))};}
function records(){
 if(!wallet)return [];
 const rows=new Map(wallet.db.prepare('SELECT pid,body FROM outgoing').all().map(r=>{const i=JSON.parse(r.body).body.action.signed.intent,status=outgoingStatus(view?.state,i);return [r.pid,{pid:r.pid,status,direction:'Sent',sender:i.sender,recipient:i.recipient,value:i.value,fee:paymentFee(i,status),...paymentAmounts(i,paymentFee(i,status)),feeLabel:status==='NOT_SUBMITTED'?'Fee charged':'Estimated fee'}];}));
 if(view)for(const [pid,r] of Object.entries({...(!bounded?wallet.terminalRecords():{}),...view.state.money.requests}))if(r.intent.sender===owner||r.intent.recipient===owner)rows.set(pid,{pid,status:r.status,direction:r.intent.sender===owner?'Sent':'Received',value:r.intent.value,fee:paymentFee(r.intent,r.status),...paymentAmounts(r.intent,paymentFee(r.intent,r.status)),feeLabel:['EXPIRED','CANCELLED'].includes(r.status)?'Release fee':['RESERVED','SCHEDULED'].includes(r.status)?'Estimated fee':'Network fee',sender:r.intent.sender,recipient:r.intent.recipient,height:r.terminalHeight,scheduled:scheduled(r.intent),executeAt:r.executeAt??null,recipientDelay:r.intent.delay,cancelFee:r.intent.abortFee,canCancel:scheduled(r.intent)&&r.intent.sender===owner&&['RESERVED','SCHEDULED'].includes(r.status)&&(!r.executeAt||view.state.money.time<r.executeAt),cancellationPending:!!wallet.db.prepare('SELECT 1 FROM cancellations WHERE pid=?').get(pid)&&['RESERVED','SCHEDULED'].includes(r.status)});
 for(const row of rows.values())if(row.status==='QUEUED'&&(spendPolicy(view?.state??{},owner)?.enabled||wallet.db.prepare('SELECT 1 FROM approval_guard WHERE pid=?').get(row.pid))){row.status='AWAITING_APPROVAL';row.canRequestApproval=!!spendPolicy(view?.state??{},owner)?.enabled&&!(approval?.rows()??[]).some(a=>a.pid===row.pid&&['opening','pending','submitted'].includes(a.status)&&a.expires>Date.now()/1000);}
 return [...rows.values()].sort((a,b)=>(b.height??0)-(a.height??0)).slice(0,200);
}
function userError(e){const detail=e.message??'verification failed';if(detail!==lastDiagnostic){console.error(detail);lastDiagnostic=detail;}if(/expired|future trust/.test(detail))return 'The checkpoint has expired. Waiting for an update from the trusted signers.';if(/local history is not ready yet|source behind retained history/.test(detail))return 'Your node is downloading verified history. Keep it connected; verification will retry automatically.';if(/fetch failed|post failed|connect|Command failed/i.test(detail))return 'Node connection temporarily unavailable. Your last verified data is retained; sending will resume after verification.';return 'Verification incomplete. Sending is paused; details are saved in the local log.';}
async function refresh(){if(working||sessionDrain.pending||paymentLane.pending)return;working=true;const epoch=sessionEpoch,active=wallet;if(active)walletBusy=true;try{const next=bounded&&active?await active.view():await client.sync(read('checkpoint.json'),connection.rpc,bounded?{service:true,rewardIds:rewardWorker.identity?[rewardWorker.identity.node]:[]}:{});if(epoch!==sessionEpoch)return;assert(Number.isSafeInteger(next.certificate.height)&&next.certificate.height>0,'verified block height required');if(active||!bounded)view=next;verifiedHeight=next.certificate.height;checkedAt=Date.now();error=null;
 if(bounded){
  const verification=homeVerification(next,config.chainId);
  verifierActivity.observe({progress:'running',network:config.chainId,homeVerification:BOUNDED_HOME,verification,trafficCounters:trafficMeter.snapshot()});
  nodeActivity={points:verifierActivity.points,visible:verifierActivity.visible,revision:verifierActivity.revision,mode:'verification'};
  process.send?.({verification,nodeActivity});
 }
 try{rewardStatus=await rewardWorker.tick(next);}catch{rewardStatus={...rewardStatus,message:'Reward synchronisation will retry automatically. Saved earnings are retained.'};}publishRewards();
 if(active){if(collateral?.wallet!==active){collateral?.clear();collateral=new WalletFunding(active);}if(collateral.rows().some(r=>collateral.present(r).canRetry))await collateral.sync();active.recoverPending(view);try{await approval?.sync();approvalError=null;}catch{approvalError='Sun\u00b7Phi approval is pending. Your wallet will retry without bypassing the required signature.';}let processed=0,nextPaymentNotice=null;for(const row of active.db.prepare('SELECT pid,body FROM outgoing ORDER BY pid').all()){const status=outgoingStatus(view.state,JSON.parse(row.body).body.action.signed.intent);if(status!=='SETTLED'&&status!=='EXPIRED'&&status!=='CANCELLED'&&status!=='NOT_SUBMITTED'&&status!=='HISTORY_UNAVAILABLE'&&status!=='REVIEW_REQUIRED'&&(status!=='SCHEDULED'||active.db.prepare('SELECT 1 FROM cancellations WHERE pid=?').get(row.pid))){if(processed++>=16)break;try{await active.resume(row.pid);}catch(e){if(e instanceof WalletWorkError)nextPaymentNotice=e.message;else error=userError(e);}}}paymentNotice=nextPaymentNotice;}}catch(e){if(epoch===sessionEpoch)error=userError(e);}finally{walletBusy=false;working=false;}}
function status(){if(view&&(presentation?.source!==view||presentation?.owner!==owner))presentation={source:view,owner,value:summarize(view),nodes:owner?walletNodeOverview(view.state,owner):null};return {nodeActivity,recovery:recoveryPresentation(recoveryProgress),trialOnly:true,network:config.chainId,locked:!wallet,hasVault:store.list().length>0,wallets:store.list(),selectedWallet:store.selected()?.id??null,activeWallet:activeId,owner,working,paymentPending:paymentLane.pending,checkedAt,error,paymentNotice,height:verifiedHeight,unitScale:view?String(unitScale(view.state)):null,balance:view&&owner?{...balances(view.state,owner),display:displayAmounts(balances(view.state,owner),String(unitScale(view.state)))}:null,analytics:presentation?.value??null,nodesSnapshot:presentation?.nodes??null,payments:records(),collateralRequests:collateral?.wallet===wallet?collateral.rows().map(r=>collateral.present(r)):[],indexedHistory:indexedHistory(),rewards:rewardStatus,sunphi:activeId?{...sunphi.view(activeId,view?spendPolicy(view.state,owner):null),requests:approval?.rows()??[],message:approvalError}:null,features:{twoWayExchange:!!config.exchangeLab,sunphiNotifications:true,sunphiApproval:!!view&&protectionEnabled(view.state),delayedPayments:!!view&&delayedPaymentsEnabled(view.state),spendProtection:!!view&&protectionEnabled(view.state)},paymentTariff:view?paymentTariffStatus(view.state.money):null,networkTime:view?.state.money.time??null};}
const server=createServer(async(req,res)=>{try{assert.equal(req.headers.host,`127.0.0.1:${port}`,'host');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
 if(req.method==='GET'&&req.url==='/activity-plots.js'){res.setHeader('Content-Type','text/javascript');res.end(readFileSync(join(import.meta.dirname,'activity-plots.js')));return;}
 if(req.method==='GET'&&req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(readFileSync(join(import.meta.dirname,'wallet.html'),'utf8'));return;}
 if(req.method==='GET'&&req.url.startsWith('/brand/')){const name=req.url.slice(7);assert(['sunphi-windows.png','sunphi-mark.svg','sunphi-mark-light.svg','duebyte-window.css','duebyte-app.png','duebyte-brand.css','duebyte-coin.css','duebyte-coin-v1.png','duebyte-coin-v2.png','duebyte-coin-back-v1.png','duebyte-light-v1.png','duebyte-dark-v1.png','duebyte-wordmark-dark-20261103.png','duebyte-wordmark-light-20261103.png','inter.woff2'].includes(name));res.setHeader('Content-Type',name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':name.endsWith('.svg')?'image/svg+xml':'font/woff2');res.end(readFileSync(join(import.meta.dirname,'../desktop/brand',name)));return;}
 const token=req.headers['x-duebyte-token'];assert(typeof token==='string'&&/^[a-f0-9]{64}$/.test(token),'local session');if(req.headers.origin)assert.equal(req.headers.origin,`http://127.0.0.1:${port}`,'origin');
 assert(!req.headers['sec-fetch-site']||['same-origin','none'].includes(req.headers['sec-fetch-site']),'cross-site request');
 if(wallet && token !== sessionToken) throw new Error('Wallet is open in another session. Lock it there first.');
 if(!wallet)assert(['/status','/unlock','/create','/restore','/select-wallet','/lock'].includes(req.url),'unlock your wallet first');
 if(req.method==='GET'&&req.url==='/backup'){assert(wallet,'unlock your wallet first');res.setHeader('Content-Type','application/json');res.end(JSON.stringify(store.backup(activeId),null,2));return;}
 if(req.method==='GET'&&req.url==='/status'){
  const snapshot=status(),epoch=sessionEpoch;
  if(wallet&&bounded&&view&&req.headers['x-duebyte-analytics']==='1'){
   snapshot.analytics=await networkPresentation(view,owner);
   assert.equal(sessionEpoch,epoch,'Wallet session changed.');
  }
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(snapshot));return;
 }
 // Reading the request body yields to lock/unlock and wallet-selection requests.
 // Bind admission to this session lifetime, including when the same token is reused.
 const admittedEpoch=sessionEpoch;
 assert.equal(req.method,'POST');let size=0,chunks=[];for await(const b of req){size+=b.length;assert(size<=(req.url==='/nodes/rule-review'?131072:16384));chunks.push(b);}const q=JSON.parse(Buffer.concat(chunks));
 assert.equal(admittedEpoch,sessionEpoch,'Wallet session changed. Retry the action in the current session.');
 assert(!sessionDrain.pending,'Wallet switching is in progress. Please wait.');
 assert(!paymentLane.pending||['/lock','/select-wallet','/assets'].includes(req.url),'A wallet operation is already in progress.');
 assert(Date.now()>=updateDrainUntil,'The node is installing an update. Please reopen the wallet after it restarts.');
 if(wallet && token !== sessionToken) throw new Error('Wallet is open in another session. Lock it there first.');
 if(!wallet)assert(['/status','/unlock','/create','/restore','/select-wallet','/lock'].includes(req.url),'unlock your wallet first');
 if(['/unlock','/create','/restore','/change-password'].includes(req.url)){
  if(Date.now()-authWindow>=60000){authWindow=Date.now();authAttempts=0;}
  assert(++authAttempts<=20,'Too many password attempts. Wait one minute.');
 }
 if(req.url==='/change-password'){
  assert(wallet&&activeId&&q.walletId===activeId,'Open the wallet whose password you want to change.');
  store.changePassword(activeId,q.currentPassword,q.newPassword);
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({changed:true}));return;
 }
 if(req.url==='/history'){
  assert(bounded&&wallet&&!working&&!walletBusy,'Wait for wallet verification to finish.');
  assert.deepEqual(Object.keys(q).sort(),['limit','offset','through']);assert(Number.isSafeInteger(q.offset)&&q.offset>=0);assert(Number.isSafeInteger(q.limit)&&q.limit>=1&&q.limit<=32);assert(q.through===null||Number.isSafeInteger(q.through)&&q.through>=0);
  const active=wallet;working=true;walletBusy=true;
  try{const current=await active.view(),page=await client.historyPage(current,owner,q.offset,q.limit,q.through);assert.equal(sessionEpoch,admittedEpoch,'Wallet session changed.');
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...page,items:undefined,rows:page.items.map(({id,value})=>historyRecord(id,value,current.state))}));return;
  }finally{working=false;walletBusy=false;}
 }
 if(req.url==='/authorize-action'){
  assert(wallet&&['/voting/candidacy','/voting/submit','/collateral/pay','/send','/cancel-payment','/bond/confirm','/collateral/confirm','/collateral/retry','/collateral/cancel','/nodes/confirm','/nodes/rule-confirm','/node-alerts/confirm','/node-alerts/activate','/node-alerts/stop','/seller/start','/exchange/confirm','/exchange/resume','/exchange/refund','/broker/confirm','/broker/fund'].includes(q.path),'supported consent action required');
  if(q.path==='/collateral/pay')assert(q.data&&/^[a-f0-9]{64}$/.test(q.data.requestId)&&['withdraw','deposit'].includes(q.data.operation),'Exact collateral instruction required');
  else if(q.path==='/voting/submit')assert(walletBallotActions.includes(q.data?.type),'Unsupported operator proposal action');
  else if(q.path==='/voting/candidacy')exact(q.data,['name','organization','history','mandate']);
  else if(q.path==='/seller/start')assert(q.data&&Object.keys(q.data).length===1&&/^[a-f0-9]{64}$/.test(q.data.profileHash),'seller review required');
  else if(['/broker/confirm','/broker/fund'].includes(q.path))assert(q.data&&Object.keys(q.data).length===1&&/^[a-f0-9-]{36}$/.test(q.data.id),'exchange review required');
  else if(q.path==='/send')requestedRecipientDelay(q.data);
  else if(['/bond/confirm','/collateral/confirm','/collateral/retry','/collateral/cancel','/nodes/confirm','/nodes/rule-confirm','/node-alerts/confirm','/exchange/confirm','/exchange/resume','/exchange/refund'].includes(q.path))assert(q.data&&Object.keys(q.data).length===1&&/^[a-f0-9]{64}$/.test(q.data.id),'review required');
  else if(q.path==='/node-alerts/activate')assert(q.data&&Object.keys(q.data).length===1&&q.data.approval?.request?.body,'server approval required');
  else if(q.path==='/node-alerts/stop')assert(q.data&&Object.keys(q.data).length===2&&/^[a-f0-9]{64}$/.test(q.data.node)&&Number.isSafeInteger(q.data.revision),'subscription required');
  else assert(q.data&&Object.keys(q.data).length===1&&typeof q.data.pid==='string','payment reference required');
  for(const [key,p]of actionPermits)if(p.expires<Date.now())actionPermits.delete(key);
  assert(actionPermits.size<8,'Too many pending confirmations.');
  const permit=randomBytes(32).toString('hex');actionPermits.set(permit,{digest:hash({path:q.path,data:q.data,activeId,sessionToken}),expires:Date.now()+30000});
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({permit}));return;
 }
 let actionExpires=null;
 if(['/voting/candidacy','/voting/submit','/collateral/pay','/send','/cancel-payment','/bond/confirm','/collateral/confirm','/collateral/retry','/collateral/cancel','/nodes/confirm','/nodes/rule-confirm','/node-alerts/confirm','/node-alerts/activate','/node-alerts/stop','/seller/start','/exchange/confirm','/exchange/resume','/exchange/refund','/broker/confirm','/broker/fund'].includes(req.url)){
  const id=req.headers['x-duebyte-action'],permit=actionPermits.get(id);actionPermits.delete(id);
  assert(permit&&permit.expires>=Date.now()&&permit.digest===hash({path:req.url,data:q,activeId,sessionToken}),'Confirmation expired or changed. Review the payment again.');actionExpires=permit.expires;
 }
 if(['/broker/availability','/broker/review','/broker/confirm','/broker/status','/broker/fundingReview','/broker/fund'].includes(req.url)){
  assert(wallet&&!working&&!walletBusy,'Wait for current wallet verification.');
  const file=join(home,'exchange-broker-profile.json');
  if(!config.exchangeBrokerProfileHash||!existsSync(file)){assert(req.url==='/broker/availability','Exchange provider is not connected.');res.end(JSON.stringify({configured:false,providers:[]}));return;}
  const profile=JSON.parse(readFileSync(file,'utf8'));assert.equal(hash(profile),config.exchangeBrokerProfileHash,'Exchange connection profile changed.');
  if(broker?.wallet!==wallet){broker?.close();broker=new WalletBroker(wallet,{profile});}
  working=true;walletBusy=true;
  try{const method=req.url.split('/')[2];if(method==='availability')assert.deepEqual(q,{});
   const result=await broker[method](q);assert.equal(sessionEpoch,admittedEpoch,'Wallet session changed.');
   if(method==='fund'&&result.status==='AWAITING_APPROVAL')await approval.payment(result.pid);
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify(method==='availability'?{configured:true,...result}:result));return;
  }finally{working=false;walletBusy=false;}
 }
 if(['/exchange/availability','/exchange/quote','/exchange/confirm','/exchange/status','/exchange/resume','/exchange/refund'].includes(req.url)){
  assert(wallet&&!working&&!walletBusy,'Wait for current wallet verification.');
  const file=join(home,'exchange-lab-profile.json'),available=!!config.exchangeLab&&existsSync(file);
  if(req.url==='/exchange/availability'){assert.deepEqual(q,{});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({available,isolated:!!config.exchangeLab,reason:available?'Isolated test assets only.':'Two-way exchange is not activated.'}));return;}
  assert(available,'Two-way exchange is not activated. No order was made.');
  if(exchange?.wallet!==wallet){exchange?.close();exchange=new WalletExchange(wallet,{request:exchangeLabTransport(JSON.parse(readFileSync(file,'utf8')),config)});}
  working=true;walletBusy=true;try{const method=req.url.split('/')[2];if(method==='status')assert.deepEqual(q,{});const result=await exchange[method](q);assert.equal(admittedEpoch,sessionEpoch,'Wallet session changed.');res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;}finally{working=false;walletBusy=false;}
 }
 if(['/quote','/send','/cancel-payment'].includes(req.url)){
  const active=wallet;
  assert(active&&checkedAt&&!error&&view,'Wait for verified wallet data before preparing a payment.');
  if(req.url==='/cancel-payment')assert(Object.keys(q).length===1&&typeof q.pid==='string','payment reference required');
  else requestedRecipientDelay(q);
  const result=await paymentLane.run({busy:()=>working||walletBusy,valid:()=>wallet===active&&sessionEpoch===admittedEpoch&&!sessionDrain.pending&&!res.destroyed&&(actionExpires===null||Date.now()<=actionExpires),execute:async()=>{
   assert(checkedAt&&!error&&view,'Verification failed. No new payment was created.');
   if(q.delayed)assert(delayedPaymentsEnabled(view.state),'Delayed sending is not enabled on this network.');
   working=true;walletBusy=true;
   try{
    if(req.url==='/quote'){const quote=await active.quote(q.value,q.unitScale);assert(wallet===active&&sessionEpoch===admittedEpoch,'Wallet session changed.');return quote;}
    if(req.url==='/send'){const p=await active.prepareTokens(q),outcome=await active.resume(p.pid);if(outcome.status==='AWAITING_APPROVAL')await approval.payment(p.pid);}
    else await active.cancel(q.pid);
    return null;
   }finally{working=false;walletBusy=false;}
  }});
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/quote'?result:status()));return;
 }
 if(req.url==='/external/prices'||req.url==='/external/receipt'){
  let result;
  if(req.url==='/external/prices'){
   assert.deepEqual(q,{});result={prices:await marketPrices()};
  }else{
   assert(!checkingPublicReceipt,'Another receipt check is in progress.');
   checkingPublicReceipt=true;
   try{result=await checkPublicReceipt(q);}finally{checkingPublicReceipt=false;}
  }
  assert.equal(sessionEpoch,admittedEpoch,'Wallet session changed.');
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
 }
 if(req.url==='/assets'){
  assert(wallet,'Unlock your wallet first.');assert.deepEqual(q,{});
  const context=owner,chain=config.chainId,file=join(store.directory(activeId),'external-accounts.json');let external=[];
  if(existsSync(file)){
   const profile=checkAssetProfile(JSON.parse(readFileSync(file,'utf8')),context,chain),pin=hash(profile);
   if(!assetCache||assetCache.pin!==pin||Date.now()-assetCache.at>15000){const observed=await observePortfolio(profile);assert.equal(admittedEpoch,sessionEpoch,'Wallet session changed.');assetCache={pin,at:Date.now(),external:observed};}
   external=assetCache.external;
  }
  assert.equal(admittedEpoch,sessionEpoch,'Wallet session changed.');const s=status();res.setHeader('Content-Type','application/json');res.end(JSON.stringify(portfolio({owner:context,chain,balance:s.balance,scale:s.unitScale??'1',checkedAt:s.checkedAt,error:s.error,external})));return;
 }
 if(req.url.startsWith('/seller/')){
  assert(['/seller/status','/seller/start','/seller/stop'].includes(req.url),'Unknown seller action.');
  if(req.url!=='/seller/start')assert.deepEqual(q,{});
  if(!config.purchaseLab||!existsSync(join(home,'seller-home-profile.json'))){assert.equal(req.url,'/seller/status','Seller is not configured.');res.end(JSON.stringify({available:false}));return;}
  if(!seller){const local=read('seller-home-profile.json'),active=wallet;assert.deepEqual(Object.keys(local).sort(),['profile','transport']);
   if(local.profile.config.purchaseLab.policy.seller!==owner){assert.equal(req.url,'/seller/status','Open the configured seller wallet.');res.end(JSON.stringify({available:false}));return;}
   seller=new WalletSeller({config,profile:local.profile,transport:local.transport,bundle:store.vault(activeId),key:active.key,journal:join(store.directory(activeId),'seller-authorizations.sqlite'),ready:()=>wallet===active&&!error&&checkedAt&&Date.now()-checkedAt<60000&&Date.now()>=updateDrainUntil});
  }
  if(req.url==='/seller/start'){assert(!walletBusy&&!working,'Wait for current verification.');seller.start(q.profileHash);}
  if(req.url==='/seller/stop')seller.stop();
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(seller.status()));return;
 }
 if(['/purchase/availability','/purchase/quote','/purchase/accept','/purchase/order'].includes(req.url)&&config.purchaseLab&&existsSync(join(home,'purchase-lab-profile.json'))){
  assert(wallet&&!walletBusy&&!working,'Unlock the wallet and wait for current verification.');
  if(!purchase){
   const profile=read('purchase-lab-profile.json');assert.equal(profile.configHash,hash(config));
   const purchaseHome=join(store.directory(activeId),'purchase-lab');mkdirSync(purchaseHome,{recursive:true});
   const reader=new CommittedPurchaseReader({home:purchaseHome,binary,genesisFile:join(home,'genesis.json'),genesisHash:profile.genesisHash,anchor:profile.anchor,historyUrl:historyUrl??connection.rpc,configHash:hash(config),policy:config.purchaseLab.policy});
   try{purchase=new WalletPurchase({file:join(purchaseHome,'orders.sqlite'),config,key:wallet.key,reader,url:profile.url,transport:profile.transport??null});}catch(e){reader.close();throw e;}
  }
  walletBusy=true;working=true;
  try{const result=await purchase.handle(req.url.split('/')[2],q);assert.equal(admittedEpoch,sessionEpoch,'Wallet session changed.');res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;}finally{walletBusy=false;working=false;}
 }
 if(req.url==='/purchase/availability'){
  assert.deepEqual(q,{});assert(wallet,'Unlock the wallet first.');
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({available:false,routes:[],reason:'Purchases are not available yet. No funded seller and verified payment route are connected. No payment will be requested.'}));return;
 }
 if(['/purchase/quote','/purchase/accept','/purchase/order','/purchase/request'].includes(req.url))throw Error('Protected purchases are not activated on this network. No payment or order was made.');
 if(req.url==='/nodes/options'||req.url==='/collateral/options'){
  assert.deepEqual(q,{});assert(wallet&&view&&checkedAt,'Waiting for verified wallet data.');
  let result;if(req.url==='/nodes/options')result=walletNodeOverview(view.state,owner);
  else{if(collateral?.wallet!==wallet){collateral?.clear();collateral=new WalletFunding(wallet);}result=collateral.options(view.state);}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
 }
 if(['/bond/overview','/bond/review','/bond/confirm','/bond/saved'].includes(req.url)){
  assert(wallet&&!working&&!walletBusy,'Wait for wallet verification to finish.');
  const active=wallet;
  if(!bondSessions.has(active))bondSessions.set(active,new WalletBond(active));
  const bonds=bondSessions.get(active);
  working=true;walletBusy=true;
  try{
   let result;
   if(req.url==='/bond/review')result=await bonds.review(q);
   else if(req.url==='/bond/confirm')result=await bonds.confirm(q,()=>wallet===active&&sessionEpoch===admittedEpoch&&!sessionDrain.pending&&Date.now()<=actionExpires);
   else{
    assert.deepEqual(Object.keys(q),['node']);assert(/^[a-f0-9]{64}$/.test(q.node));
    result=req.url==='/bond/overview'?await bonds.overview(q.node):bonds.saved(q.node);
   }
   assert.equal(sessionEpoch,admittedEpoch,'Wallet session changed.');
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
  }finally{working=false;walletBusy=false;}
 }
 if(req.url==='/voting/payload-hash'){
  assert.deepEqual(Object.keys(q),['payload']);
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(hash(q.payload)));return;
 }
 if(['/voting/list','/voting/submit','/voting/candidacy'].includes(req.url)){
  const active=wallet;assert(active,'Unlock your wallet to view proposals.');
  const valid=()=>active===wallet&&sessionEpoch===admittedEpoch&&!sessionDrain.pending&&!res.destroyed&&(actionExpires===null||Date.now()<=actionExpires);
  const result=await paymentLane.run({busy:()=>working||walletBusy,valid,timeoutMs:25000,timeoutMessage:'Network verification is busy. Try again shortly.',execute:async()=>{
   working=true;walletBusy=true;
   try{const {certificate,state}=await active.view(),data=await active.client.operatorBallots(certificate,active.key.publicKey);
    if(req.url==='/voting/list'){
     assert.deepEqual(q,{});const owned=walletNodeOverview(state,active.key.publicKey).nodes.filter(n=>n.kind==='server'&&n.collateral?.owned);
     return {...data,seats:seatsAt(data.policy,data.blockTime),serving:servingExperts(data.policy,data.blockTime),servers:owned.map(n=>({id:n.id,active:n.participation?.status==='active'}))};
    }
    assert(data.policy,'Operator voting has not been activated by the network.');
    if(req.url==='/voting/candidacy'){
     exact(q,['name','organization','history','mandate']);assert.equal(q.history,data.policy.history,'Refresh the election before signing');
     const mandate=seatMandate(data.policy,q.mandate.seat,data.blockTime);
     assert.deepEqual(q.mandate,mandate,'The seat or term changed. Review the election again.');
     for(const v of [q.name,q.organization])assert(typeof v==='string'&&v.trim()===v&&v.length&&Buffer.byteLength(v)<=160&&!/[\u0000-\u001f]/.test(v),'Enter the public candidate and organization names');
     const profile={name:q.name,organization:hash(q.organization.normalize('NFC').toLowerCase()),key:active.key.publicKey};
     assert(valid(),'Wallet session expired before signing');
     return {profile,mandate,signature:sign(candidateConsent(hash(active.client.config),q.history,profile,mandate),active.key.privateKey)};
    }
    assert(walletBallotActions.includes(q.type),'Unsupported wallet ballot action');
    if(q.type==='ADMIT_OPERATOR_QUESTION_V2'){
     assert(data.phase===q.phase&&data.agendaContext===q.context,'The agenda changed. Refresh the proposal before signing.');
     const draft=data.proposals.find(p=>p.id===q.id&&p.status==='draft');assert(draft,'This proposal is no longer awaiting admission.');
     const key=active.key.publicKey;
     if(data.phase==='expert-review')assert(servingExperts(data.policy,data.blockTime).some(x=>x.key===key),'A serving expert wallet is required.');
     else assert(key===data.founderExpert&&(data.phase==='warmup'||draft.proposal.slate),'The founder can admit only questions within the current mandate.');
    }
    if(q.type==='CAST_OPERATOR_BALLOT_V1'){
     const r=data.proposals.find(p=>p.id===q.id);assert(r?.status==='open'&&r.weights[active.key.publicKey]&&!r.votes[active.key.publicKey],'No available vote for this wallet');assert(['yes','no'].includes(q.choice));
    }
    assert(valid(),'Wallet session expired before signing');const wire=envelope(active.client.config,q,active.key);await active.broadcast(wire);return {submitted:true};
   }finally{working=false;walletBusy=false;}
  }});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
 }
 if(req.url.startsWith('/collateral/')){
  const active=wallet;
  assert(active,'Unlock the wallet to review collateral.');
  const valid=()=>wallet===active&&sessionEpoch===admittedEpoch&&!sessionDrain.pending&&!res.destroyed&&(actionExpires===null||Date.now()<=actionExpires);
  const response=await paymentLane.run({busy:()=>working||walletBusy,valid,timeoutMs:25000,timeoutMessage:'Wallet verification is still running. Review the contribution again.',execute:async()=>{
  if(collateral?.wallet!==active){collateral?.clear();collateral=new WalletFunding(active);}
  working=true;walletBusy=true;
  try{let result;
   if(req.url==='/collateral/options'){assert.deepEqual(q,{});const current=await collateral.current();result=collateral.options(current.state);}
   else if(req.url==='/collateral/pay')result=await collateral.pay(q,valid);
   else if(req.url==='/collateral/review')result=await collateral.review(q);
   else if(req.url==='/collateral/confirm')result=await collateral.confirm(q);
   else if(req.url==='/collateral/status'){assert.deepEqual(q,{});result=await collateral.sync();}
   else if(req.url==='/collateral/retry')result=await collateral.resume(q);
   else if(req.url==='/collateral/cancel')result=collateral.cancel(q);
   else assert.fail('Unknown collateral action.');
   assert.equal(sessionEpoch,admittedEpoch,'Wallet session changed.');return result;
  }finally{working=false;walletBusy=false;}
  }});
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(response));return;
 }
 if(req.url.startsWith('/nodes/')){
  const active=wallet;
  assert(active,'Unlock the wallet to review a server.');
  const valid=()=>wallet===active&&sessionEpoch===admittedEpoch&&!sessionDrain.pending&&!res.destroyed&&(actionExpires===null||Date.now()<=actionExpires);
  const result=await paymentLane.run({busy:()=>working||walletBusy,valid,timeoutMs:60000,
   timeoutMessage:'Wallet verification is still running. Check Network, then select Review server again.',
   execute:async()=>{
    if(nodeLinks?.wallet!==active){nodeLinks?.clear();nodeLinks=new WalletNodeLinks(active);}
    working=true;walletBusy=true;
    try{
       if(req.url==='/nodes/block-votes'){
        assert.deepEqual(q,{});return await recentBlockSignatures(active);
       }
       if(req.url==='/nodes/rule-review'||req.url==='/nodes/rule-confirm'){
        if(!ruleReviewSessions.has(active))ruleReviewSessions.set(active,new WalletRuleReviews(active));
        const reviewer=ruleReviewSessions.get(active);
        if(req.url==='/nodes/rule-confirm')return await reviewer.confirm(q,valid);
        if(q.builtin==='prepare-linked-servers'||q.builtin==='smooth-issuance'){
         assert.deepEqual(Object.keys(q).sort(),['builtin','nodes']);
         const result=await reviewer.preparationGroup(q.nodes,q.builtin==='smooth-issuance');assert(valid(),'Wallet session changed');return result;
        }
        const remote=Object.hasOwn(q,'server');if(remote)assert.deepEqual(Object.keys(q).sort(),['proposal','server']);
        const proposal=remote?q.proposal:q;
        const builtin=proposal?.builtin==='bonded-v3'&&Object.keys(proposal).length===1;
        const result=await reviewer.review(builtin?reviewer.builtin():proposal,remote?q.server:null);
        assert(valid(),'Wallet session changed');return result;
       }
     if(req.url==='/nodes/review')return await nodeLinks.review(q);
     if(req.url==='/nodes/confirm')return await nodeLinks.confirm(q,valid);
     if(req.url==='/nodes/check')return await nodeLinks.check(q);
     assert.equal(req.url,'/nodes/options','Unknown node link action.');
     assert.deepEqual(q,{});return await nodeLinks.options();
    }finally{working=false;walletBusy=false;}
   }});
  assert.equal(sessionEpoch,admittedEpoch,'Wallet session changed.');
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
 }
 if(req.url.startsWith('/node-alerts/')){
  assert(wallet&&!working&&!walletBusy,'Wait for current wallet verification.');
  if(nodeAlerts?.wallet!==wallet){nodeAlerts?.clear();nodeAlerts=new WalletNodeAlerts(wallet,{connection:sunphi,store,walletId:activeId,checkpoint:()=>read('checkpoint.json')});}
  const method=req.url.slice('/node-alerts/'.length);assert(['status','review','confirm','activate','stop'].includes(method),'Unknown alert action.');
  working=true;walletBusy=true;try{const result=await nodeAlerts[method](q);assert.equal(sessionEpoch,admittedEpoch,'Wallet session changed.');res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;}finally{working=false;walletBusy=false;}
 }
 if(req.url==='/lock'||req.url==='/select-wallet'){
  if(req.url==='/select-wallet')store.get(q.walletId);
  await sessionDrain.run({busy:()=>walletBusy,valid:()=>sessionEpoch===admittedEpoch,close:()=>{
   seller?.close();seller=null;collateral?.clear();collateral=null;nodeLinks?.clear();nodeLinks=null;nodeAlerts?.clear();nodeAlerts=null;
   purchase?.close();purchase=null;exchange?.close();exchange=null;broker?.close();broker=null;wallet?.close();wallet=null;approval=null;approvalError=null;owner=null;activeId=null;sessionToken=null;sessionEpoch++;actionPermits.clear();clearIndexedView();if(req.url==='/select-wallet')store.select(q.walletId);
  }});
  publishRewards();res.setHeader('Content-Type','application/json');res.end(JSON.stringify(status()));return;
 }
 if(['/unlock','/create','/restore'].includes(req.url)){seller?.close();seller=null;collateral?.clear();collateral=null;nodeLinks?.clear();nodeLinks=null;nodeAlerts?.clear();nodeAlerts=null;}
 if(req.url==='/restore'){
  assert(!wallet&&!walletBusy,'Lock the current wallet before restoring another.');store.restore(q.backup,q.password,q.name);sessionEpoch++;publishRewards();
 }else if(req.url==='/unlock'||req.url==='/create'){
  assert(!wallet&&!walletBusy,'Lock the current wallet before opening another.');
  clearIndexedView();
  const id=req.url==='/create'?store.create(q.password,q.name).id:(q.walletId??store.selected()?.id);
  const key=store.unlock(id,q.password);publishRewards();
  const opened=new Wallet({client,key,rewardIds:rewardWorker?.identity?[rewardWorker.identity.node]:[],home:store.directory(id),routes:connection.workers,url:connection.rpc,checkpoint:()=>read('checkpoint.json')});owner=key.publicKey;activeId=id;wallet=opened;approval=new SunPhiApproval({connection:sunphi,wallet:opened,store,walletId:id,checkpoint:()=>read('checkpoint.json')});approvalError=null;sessionToken=token;sessionEpoch++;actionPermits.clear();void refresh();
 }
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
 }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message,...(e instanceof WalletPreparationError?{paymentOutcome:e.paymentOutcome,code:e.code}:{})}));}});
server.requestTimeout=15000;server.listen(port,'127.0.0.1',()=>{console.log(`DueByte wallet: http://127.0.0.1:${port}`);process.send?.({ready:port});publishRewards();void refresh();});const timer=setInterval(()=>void refresh(),5000);
const sellerTimer=setInterval(()=>void seller?.tick(),2000);
process.on('SIGTERM',()=>{seller?.close();clearInterval(sellerTimer);clearInterval(timer);server.close(()=>{wallet?.close();store.close();client.close();process.exit(0);});});
import {readWalletProfile} from './wallet-profile.mjs';
