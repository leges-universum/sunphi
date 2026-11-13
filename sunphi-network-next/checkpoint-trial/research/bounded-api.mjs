// Isolated read-only adapter. No production routing or activation endpoint.
import http from 'node:http';
import {queryBounded} from './bounded-query.mjs';
import {BoundedReadLeases} from './bounded-read-leases.mjs';
export function createBoundedApi(handler,options={}){
 const leases=new BoundedReadLeases(handler,options);
 const server=http.createServer({maxHeaderSize:8192,requestTimeout:5000,headersTimeout:5000},(req,res)=>{
  const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return send(403,{error:'loopback only'});
  if(req.headers.origin)return send(403,{error:'cross-origin denied'});
  try{
   if(req.url.length>512)return send(400,{error:'request too long'});
   const u=new URL(req.url,'http://localhost'),parts=u.pathname.split('/');
   if(u.pathname==='/v1/read-lease'){
    if(req.method==='POST'&&[...u.searchParams.keys()].join(',')==='root'&&/^[a-f0-9]{64}$/.test(u.searchParams.get('root')))return send(200,leases.acquire(u.searchParams.get('root')));
    if(req.method==='DELETE'&&[...u.searchParams.keys()].join(',')==='lease'&&/^[a-f0-9]{48}$/.test(u.searchParams.get('lease'))){leases.release(u.searchParams.get('lease'));return send(200,{released:true});}
    return send(400,{error:'read lease parameters'});
   }
   if(req.method!=='GET')return send(405,{error:'read only'});
   if(parts[1]==='v1'&&parts.length===4&&['paid-admission','paid-admission-page'].includes(parts[2])){
    const paged=parts[2]==='paid-admission-page',names=paged?['root','offset','limit']:['root'];if(u.searchParams.has('lease'))names.push('lease');
    if([...u.searchParams.keys()].length!==names.length||!names.every(n=>u.searchParams.has(n)))return send(400,{error:'query parameters'});
    const root=u.searchParams.get('root'),token=u.searchParams.get('lease');if(!/^[a-f0-9]{64}$/.test(root)||token&&!/^[a-f0-9]{48}$/.test(token))return send(400,{error:'invalid root or lease'});
    const reader=token?leases.resolve(token,root):handler;if(root!==reader.root)return send(409,{error:'stale root'});
    if(paged&&parts[3]!=='summary')return send(404,{error:'unknown query'});
    const number=n=>{const v=u.searchParams.get(n);if(!/^(0|[1-9][0-9]*)$/.test(v))throw Error('integer required');return Number(v);};
    return send(200,queryBounded(reader,{type:parts[2],id:paged?{offset:number('offset'),limit:number('limit')}:parts[3]},root));
   }
   if(parts[1]!=='v1'||parts.length!==4||!['economic-page','economic-record','economy','reward','reward-account','reward-owner-page','output','request','node','owner-count','wallet-page','wallet-meta','worker-page','reward-page','contract','approval-context','payment-events','reward-planning','expiry-candidates','exchange-order','payment-capacity'].includes(parts[2]))return send(404,{error:'unknown query'});
   const type=parts[2],names=type==='economic-record'?['root','kind']:type==='wallet-page'?['root','kind','offset','limit']:['economic-page','worker-page','reward-page','reward-owner-page','payment-events','reward-planning'].includes(type)?['root','offset','limit']:type==='approval-context'?['root','pid']:type==='payment-capacity'?['root','value','unitScale']:['root'];
   if(u.searchParams.has('lease'))names.push('lease');
   if(type==='wallet-page'&&u.searchParams.has('through'))names.push('through');
   if([...u.searchParams.keys()].length!==names.length||!names.every(n=>u.searchParams.has(n)))return send(400,{error:'query parameters'});
   const root=u.searchParams.get('root');if(!/^[a-f0-9]{64}$/.test(root))return send(400,{error:'invalid root'});
   const token=u.searchParams.get('lease');if(token&&!/^[a-f0-9]{48}$/.test(token))return send(400,{error:'invalid lease'});
   const reader=token?leases.resolve(token,root):handler;
   if(root!==reader.root)return send(409,{error:'stale root'});
   if(['economy','wallet-meta','worker-page','reward-page','payment-events','reward-planning','expiry-candidates','payment-capacity'].includes(type)&&parts[3]!=='summary')return send(404,{error:'unknown query'});
   const number=n=>{const v=u.searchParams.get(n);if(!/^(0|[1-9][0-9]*)$/.test(v))throw Error('integer required');return Number(v);};
   const id=type==='economic-page'?{kind:parts[3],offset:number('offset'),limit:number('limit')}:type==='economic-record'?{kind:u.searchParams.get('kind'),node:parts[3]}:type==='payment-capacity'?{value:u.searchParams.get('value'),unitScale:u.searchParams.get('unitScale')}:type==='reward-owner-page'?{owner:parts[3],offset:number('offset'),limit:number('limit')}:type==='wallet-page'?{owner:parts[3],kind:u.searchParams.get('kind'),offset:number('offset'),limit:number('limit')}:['worker-page','reward-page','payment-events','reward-planning'].includes(type)?{offset:number('offset'),limit:number('limit')}:type==='approval-context'?{owner:parts[3],pid:u.searchParams.get('pid')==='none'?null:u.searchParams.get('pid')}:['economy','wallet-meta','expiry-candidates'].includes(type)?null:parts[3];
   if(type==='wallet-page'&&u.searchParams.has('through'))id.through=number('through');
   send(200,queryBounded(reader,{type,id},root));
  }catch{send(400,{error:'query rejected'});}
 });
 server.once('close',()=>leases.close());server.maxConnections=8;return server;
}
