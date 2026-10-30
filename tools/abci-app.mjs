import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ReplicatedApp } from '../src/replicated-app.mjs';
const [dir,portText]=process.argv.slice(2),port=Number(portText);
if(!dir||!Number.isInteger(port)||port<1024||port>65535)throw new Error('directory and loopback port required');
const app=await ReplicatedApp.open({mode:'isolated',path:resolve(dir,'application.sqlite'),keyPath:resolve(dir,'verification-key.json'),config:JSON.parse(readFileSync(resolve(dir,'app-config.json'),'utf8'))});
let queue=Promise.resolve(),queued=0;
const server=createServer(async(req,res)=>{
  if(req.method!=='POST'||req.url!=='/'||req.headers.origin||queued>=32){res.writeHead(403);res.end();return;}
  let size=0,parts=[];try{
    for await(const p of req){size+=p.length;if(size>2*1024*1024)throw new Error('request size');parts.push(p);}
    const q=JSON.parse(Buffer.concat(parts).toString());queued++;
    const job=queue.then(()=>app.dispatch(q));queue=job.catch(()=>{});
    try {const r=await job;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(r));}
    finally{queued--;}
  }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}
});
server.requestTimeout=150000;server.headersTimeout=5000;server.listen(port,'127.0.0.1',()=>console.log(`isolated app ready ${port}`));
process.on('SIGTERM',()=>server.close(()=>{app.close();process.exit(0);}));
