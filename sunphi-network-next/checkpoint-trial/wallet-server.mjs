import {createServer} from 'node:http';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {VerifiedClient} from './client.mjs';
import {Wallet,balances} from './wallet.mjs';
import {createVault,unseal} from './vault.mjs';
import {hash} from './crypto.mjs';
const [directory,portArg,trustHash,historyUrl]=process.argv.slice(2),home=resolve(directory),port=Number(portArg??21800);assert(Number.isInteger(port)&&port>=1024&&port<32768);mkdirSync(home,{recursive:true});const read=f=>JSON.parse(readFileSync(join(home,f))),config=read('app-config.json'),policy=read('trust-policy.json');assert.equal(hash(policy),trustHash,'supply the independently authenticated trust-policy hash');const connection=read('connections.json'),binary=resolve(import.meta.dirname,'build','duebyte-abci'+(process.platform==='win32'?'.exe':'')),client=new VerifiedClient({home,config,policy,genesisFile:join(home,'genesis.json'),binary,historyUrl});let wallet=null,owner=null,view=null,checkedAt=null,working=false,error=null;
const token=randomBytes(32).toString('base64url'),vaultFile=join(home,'wallet.encrypted.json');let lastDiagnostic='',walletBusy=false;
let presentation=null;
function summarize(v){
 const m=v.state.money,requests=Object.values(m.requests),nodes=Object.values(m.nodes);
 return {height:v.certificate.height,appHeight:v.state.height,blockHash:v.certificate.blockHash,checkpoint:v.checkpointId,supply:m.supply,outputs:Object.keys(m.outputs).length,workerSeats:nodes.length,operatorGroups:new Set(nodes.map(n=>n.operator)).size,settled:requests.filter(r=>r.status==='SETTLED').length,reserved:requests.filter(r=>r.status==='RESERVED').length,expired:requests.filter(r=>r.status==='EXPIRED').length,volume:String(requests.filter(r=>r.status==='SETTLED').reduce((a,r)=>a+BigInt(r.intent.value),0n))};
}
function records(){
 if(!wallet)return [];
 const rows=new Map(wallet.db.prepare('SELECT pid,body FROM outgoing').all().map(r=>{const i=JSON.parse(r.body).body.action.signed.intent;return [r.pid,{pid:r.pid,status:'QUEUED',direction:'Sent',value:i.value,fee:i.fee}];}));
 if(view)for(const [pid,r] of Object.entries(view.state.money.requests))if(r.intent.sender===owner||r.intent.recipient===owner)rows.set(pid,{pid,status:r.status,direction:r.intent.sender===owner?'Sent':'Received',value:r.intent.value,fee:r.intent.fee,recipient:r.intent.recipient,height:r.terminalHeight});
 return [...rows.values()].sort((a,b)=>(b.height??0)-(a.height??0)).slice(0,200);
}
function userError(e){const detail=e.message??'verification failed';if(detail!==lastDiagnostic){console.error(detail);lastDiagnostic=detail;}if(/expired|future trust/.test(detail))return 'The checkpoint has expired. Waiting for an update from the trusted signers.';if(/local history is not ready yet|source behind retained history/.test(detail))return 'Your node is downloading verified history. Keep it connected; verification will retry automatically.';if(/fetch failed|post failed|connect|Command failed/i.test(detail))return 'Node connection temporarily unavailable. Your last verified data is retained; sending will resume after verification.';return 'Verification incomplete. Sending is paused; details are saved in the local log.';}
async function refresh(){if(working)return;working=true;try{view=await client.sync(read('checkpoint.json'),connection.rpc);checkedAt=Date.now();error=null;const active=wallet;if(active){walletBusy=true;try{active.recoverPending(view);let processed=0;for(const row of active.db.prepare('SELECT pid FROM outgoing ORDER BY pid').all()){const status=view.state.money.requests[row.pid]?.status;if(status!=='SETTLED'&&status!=='EXPIRED'){if(processed++>=16)break;try{await active.resume(row.pid);}catch(e){error=userError(e);}}}}finally{walletBusy=false;}}}catch(e){error=userError(e);}finally{working=false;}}
function status(){if(view&&presentation?.source!==view)presentation={source:view,value:summarize(view)};return {trialOnly:true,network:config.chainId,locked:!wallet,hasVault:existsSync(vaultFile),owner,working,checkedAt,error,height:view?.certificate.height??null,balance:view&&owner?balances(view.state,owner):null,analytics:presentation?.value??null,payments:records()};}
const html=readFileSync(join(import.meta.dirname,'wallet.html'),'utf8').replace('__TOKEN__',token);
const server=createServer(async(req,res)=>{try{assert.equal(req.headers.host,`127.0.0.1:${port}`,'host');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
 if(req.method==='GET'&&req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
 if(req.method==='GET'&&req.url.startsWith('/brand/')){const name=req.url.slice(7);assert(['sunphi-windows.png','sunphi-mark.svg','sunphi-mark-light.svg','duebyte-window.css','duebyte-app.png','duebyte-brand.css','duebyte-coin.css','duebyte-coin-v1.png','duebyte-coin-back-v1.png','duebyte-light-v1.png','duebyte-dark-v1.png','duebyte-wordmark-dark-20261103.png','duebyte-wordmark-light-20261103.png','inter.woff2'].includes(name));res.setHeader('Content-Type',name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':name.endsWith('.svg')?'image/svg+xml':'font/woff2');res.end(readFileSync(join(import.meta.dirname,'../desktop/brand',name)));return;}
 assert.equal(req.headers['x-duebyte-token'],token,'local session');if(req.headers.origin)assert.equal(req.headers.origin,`http://127.0.0.1:${port}`,'origin');
 if(req.method==='GET'&&req.url==='/backup'){assert(wallet,'unlock your wallet first');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({format:'DueByte encrypted wallet',network:config.chainId,vault:read('wallet.encrypted.json')},null,2));return;}
 if(req.method==='GET'&&req.url==='/status'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(status()));return;}
 assert.equal(req.method,'POST');let size=0,chunks=[];for await(const b of req){size+=b.length;assert(size<=16384);chunks.push(b);}const q=JSON.parse(Buffer.concat(chunks));
 if(req.url==='/restore'){
  assert(!wallet&&!existsSync(vaultFile),'a wallet already exists on this computer; it has not been replaced');assert.equal(q.backup?.format,'DueByte encrypted wallet','select a DueByte encrypted backup');assert.equal(q.backup.network,config.chainId,'backup belongs to a different network');
  unseal(q.backup.vault,q.password);writeFileSync(vaultFile,JSON.stringify(q.backup.vault),{flag:'wx',mode:0o600,flush:true});
 }else if(req.url==='/unlock'||req.url==='/create'){
  assert(!wallet,'wallet is already open');if(req.url==='/create'){assert(!existsSync(vaultFile),'wallet already exists');writeFileSync(vaultFile,JSON.stringify(createVault(q.password)),{flag:'wx',mode:0o600,flush:true});}
  const key=unseal(read('wallet.encrypted.json'),q.password);owner=key.publicKey;wallet=new Wallet({client,key,home,routes:connection.workers,url:connection.rpc,checkpoint:()=>read('checkpoint.json')});void refresh();
 }else if(req.url==='/lock'){assert(!walletBusy,'wait for current operation');wallet?.close();wallet=null;}
 else if(req.url==='/send'){assert(wallet&&!working&&checkedAt&&!error,'wallet not ready');working=true;walletBusy=true;try{const p=await wallet.prepare(q.recipient,q.value,q.protected?86400:0);await wallet.resume(p.pid);}finally{working=false;walletBusy=false;}}
 else if(req.url==='/refresh')void refresh();else assert.fail('unknown action');
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify(status()));
 }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}});
server.requestTimeout=15000;server.listen(port,'127.0.0.1',()=>{console.log(`DueByte wallet: http://127.0.0.1:${port}`);process.send?.({ready:port});void refresh();});const timer=setInterval(()=>void refresh(),5000);
process.on('SIGTERM',()=>{clearInterval(timer);server.close(()=>{wallet?.close();client.close();process.exit(0);});});
