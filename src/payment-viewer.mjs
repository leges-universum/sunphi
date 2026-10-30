import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
// Read-only money boundary: no key import, signing, mint or send route. The only
// mutation is verification/reconciliation of already recorded local payments.
export function paymentViewer(wallet,{port=8865}={}){
 if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('viewer port');
 const token=randomBytes(32).toString('hex'),origin=`http://127.0.0.1:${port}`,html=readFileSync(new URL('../web/payments.html',import.meta.url),'utf8').replaceAll('__TOKEN__',token);let busy=false;
 const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${token}'; style-src 'nonce-${token}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
  const send=(code,data)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  if(req.headers.host!==`127.0.0.1:${port}`||(req.headers.origin&&req.headers.origin!==origin)||req.headers['sec-fetch-site']==='cross-site')return send(403,{error:'Local origin required'});
  const url=new URL(req.url,origin);
  if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end(html);}
  if(!['GET','POST'].includes(req.method))return send(405,{error:'Method unavailable'});
  if(req.method==='POST'&&(req.headers['x-sunphi-viewer']!==token||req.headers['content-length']!=='0'||req.headers['transfer-encoding']))return send(403,{error:'Explicit local action required'});
  if(busy)return send(409,{error:'Verification in progress'});busy=true;
  try{
   let result;
   if(req.method==='GET'&&url.pathname==='/api/payments')result=await wallet.payments({after:url.searchParams.get('after')??'',limit:10});
   else if(req.method==='GET'&&url.pathname==='/api/trust')result=wallet.status;
   else if(req.method==='GET'&&/^\/api\/receipt\/[a-f0-9]{64}$/.test(url.pathname)){
    const saved=await wallet.receipt(url.pathname.split('/').at(-1));if(!saved)return send(404,{error:'Verified receipt not available'});result=saved.receipt;
    res.setHeader('Content-Disposition',`attachment; filename="sunphi-${saved.result.txid}.json"`);
   }else if(req.method==='POST'&&url.pathname==='/api/reconcile'){
    // Includes final receipts: they remain independently verifiable offline.
    result=await wallet.reconcilePending({after:url.searchParams.get('after')??'',limit:2});
   }else if(req.method==='POST'&&url.pathname==='/api/refresh')result=await wallet.refresh();
   else return send(404,{error:'Route unavailable'});
   send(200,result);
  }catch{send(409,{error:'Verification unavailable. Existing evidence is retained; this does not mean payment failure.'});}
  finally{busy=false;}
 });
 server.requestTimeout=10000;server.headersTimeout=10000;server.maxConnections=8;return server;
}
