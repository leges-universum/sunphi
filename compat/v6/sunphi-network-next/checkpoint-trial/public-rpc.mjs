// Public data/payment facade. Operator archive writes and witness control are
// deliberately absent. All destinations come from a root-owned local policy.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const reads=new Set(['status','net_info','block','commit','validators','consensus_params','tx','abci_query']);
const queries=new Set(['/status','/snapshot','/checkpoint','/work']);
export function permitted(kind,method,path,body){
 if(kind==='rpc'){
  const u=new URL(path,'http://local');
  const op=method==='GET'?u.pathname.slice(1):body?.method;
  if(method!=='GET'&&method!=='POST'||method==='POST'&&(u.pathname!=='/'||body?.jsonrpc!=='2.0'||Array.isArray(body)))return false;
  if(!reads.has(op)&&!(method==='POST'&&op==='broadcast_tx_sync'))return false;
  if(op==='abci_query'){let q=method==='GET'?u.searchParams.get('path'):body?.params?.path;try{if(q?.startsWith('"'))q=JSON.parse(q);}catch{return false;}if(!queries.has(q))return false;}
  return true;
 }
 if(method!=='POST'||path!=='/'||!body||Array.isArray(body))return false;
 return (kind==='archive'?['manifest','chunk','proofs']:kind==='witness'?['status','head','publicSeal']:[]).includes(body.method);
}
export function publicServer(route,{budget={active:0},upstream=fetch,timeoutMs=10000}={}){
 // Separate admission lanes: public history reads cannot consume payment slots.
 // The peer is the socket address, never an untrusted forwarding header.
 budget.reads??=0;budget.payments??=0;budget.parsing??=0;budget.peers??=new Map();budget.pending??=new Set();budget.sockets??=new Map();
 const server=createServer(async(req,res)=>{
  const reply=(code,msg)=>{if(!res.headersSent)res.writeHead(code,{'content-type':'application/json','connection':'close'});res.end(JSON.stringify({error:msg}));};
  if(req.headers.origin||!req.url.startsWith('/')||req.url.startsWith('//')||req.url.length>16384)return reply(403,'not permitted');
  const address=req.socket.remoteAddress,peer=budget.peers.get(address)??{reads:0,payments:0,parsing:0};
  // SSH forwards share a loopback address. An incomplete body must not lock
  // that identity out: replace the oldest incomplete request, never a payment
  // already admitted upstream. Both memory and connections remain bounded.
  for(const item of budget.pending){if(peer.parsing>=8&&item.peer===peer||budget.parsing>=32){item.evict();if(peer.parsing<8&&budget.parsing<32)break;}}
  if(budget.parsing>=32||peer.parsing>=8)return reply(429,'request admission busy');
  budget.peers.set(address,peer);budget.parsing++;peer.parsing++;
  const controller=new AbortController();let lane=null,parsing=true;
  const pending={peer,evict:()=>{releaseParsing();controller.abort();req.destroy();}};
  const releaseParsing=()=>{if(parsing){parsing=false;budget.parsing--;peer.parsing--;budget.pending.delete(pending);}};
  budget.pending.add(pending);
  const abort=()=>controller.abort();req.once('aborted',abort);res.once('close',abort);
  const bodyTimer=setTimeout(()=>{controller.abort();req.destroy();},Math.min(timeoutMs,3000));bodyTimer.unref();
  try{
   const chunks=[];let size=0;for await(const b of req){size+=b.length;if(size>1024*1024){reply(413,'request too large');req.destroy();return;}chunks.push(b);}
   const raw=Buffer.concat(chunks),body=raw.length?JSON.parse(raw):null;
   clearTimeout(bodyTimer);releaseParsing();
   if(!permitted(route.kind,req.method,req.url,body))return reply(403,'not permitted');
   const category=route.kind==='rpc'&&req.method==='POST'&&body?.method==='broadcast_tx_sync'?'payments':'reads';
   if(budget[category]>=(category==='payments'?8:16))return reply(503,'busy');
   if(peer[category]>=(category==='payments'?4:8))return reply(429,'client busy');
   lane=category;budget[lane]++;peer[lane]++;budget.active++;const socket=budget.sockets.get(req.socket);if(socket)socket.active++;
   const r=await upstream(`http://127.0.0.1:${route.target}${req.url}`,{method:req.method,headers:{'content-type':'application/json',...(route.kind==='rpc'?{}:{'x-sunphi-lab':'history-v1'})},...(req.method==='POST'?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs)])});
   const parts=[];let length=0;for await(const b of r.body){length+=b.length;if(length>4*1024*1024)throw Error('response bound');parts.push(b);}
   res.writeHead(r.status,{'content-type':'application/json'});res.end(Buffer.concat(parts));
  }catch{if(!res.destroyed)reply(502,'request unavailable');}finally{
   clearTimeout(bodyTimer);req.off('aborted',abort);res.off('close',abort);
   releaseParsing();if(lane){budget[lane]--;peer[lane]--;budget.active--;const socket=budget.sockets.get(req.socket);if(socket)socket.active--;}
   if(peer.parsing+peer.reads+peer.payments===0)budget.peers.delete(address);
  }
 });
 server.on('connection',socket=>{
  if(budget.sockets.size>=64){const victim=[...budget.sockets].find(([,state])=>state.active===0);if(victim){budget.sockets.delete(victim[0]);victim[0].destroy();}else{socket.destroy();return;}}
  budget.sockets.set(socket,{active:0});socket.once('close',()=>budget.sockets.delete(socket));
 });
 server.requestTimeout=15000;server.headersTimeout=10000;server.timeout=15000;server.maxRequestsPerSocket=100;
 return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const routes=JSON.parse(readFileSync(process.argv[2]));const budget={active:0},servers=[];
 for(const route of routes){if(!['rpc','archive','witness'].includes(route.kind)||!Number.isInteger(route.target)||route.listen!==route.target+1000||route.target<22001||route.target>22091)throw Error('route policy');const s=publicServer(route,{budget});s.listen(route.listen,'127.0.0.1');servers.push(s);}
 process.on('SIGTERM',()=>{for(const s of servers){s.close();s.closeAllConnections();}});
}
