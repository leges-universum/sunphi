// Explicit sandbox deployment entry point. No accounts, deposits or orders are created on startup.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {ProviderExchange} from './exchange-provider.mjs';
import {PaywardAdapter,PaywardTransport} from './exchange-payward.mjs';
import {ChangeNowAdapter,ChangeNowTransport} from './exchange-changenow.mjs';
import {ExchangeBrokerAPI,exchangeBrokerServer} from './exchange-broker-api.mjs';
import {hash} from './crypto.mjs';
export function bindingAdmission(bindings,clock=Date.now) {
  return async({owner,account,request})=>{
    const b=bindings.find(b=>b.owner===owner&&b.account===account);
    if(!b||b.expiresAt<=clock())return false;
    if(request.kind==='swap')return b.routes.some(r=>['from','to','fromNetwork','toNetwork','flow'].every(k=>r[k]===request[k]));
    if(request.kind==='trade')return b.routes.some(r=>r.from===request.from&&r.to===request.to);
    return request.kind==='withdraw'&&b.destinations.some(d=>['symbol','methodId','network','addressId','address','tag','memo'].every(k=>d[k]===request[k]));
  };
}
export function configuredBroker(file,{env=process.env}={}) {
  const root=dirname(resolve(file)),read=p=>JSON.parse(readFileSync(resolve(root,p),'utf8')),c=JSON.parse(readFileSync(resolve(file),'utf8'));
  assert(['sandbox','simulation'].includes(c.environment),'This entry point is qualified for sandbox only. Simulation is also permitted.');
  const url=new URL(c.publicUrl);assert(url.protocol==='https:'&&url.pathname==='/exchange/v1'&&!url.username&&!url.password&&!url.search&&!url.hash,'HTTPS exchange endpoint required');
  assert(Number.isInteger(c.port)&&c.port>=1024&&c.port<65536);assert(c.providers.length>=1&&c.providers.length<=4);
  assert(env.DUEBYTE_BROKER_SIGNING_FILE&&env.DUEBYTE_BROKER_STORAGE_KEY_FILE,'broker secrets must be configured');
  const signer=read(env.DUEBYTE_BROKER_SIGNING_FILE),storageKey=Buffer.from(readFileSync(resolve(root,env.DUEBYTE_BROKER_STORAGE_KEY_FILE),'utf8').trim(),'base64');
  const dbs=[],paths=new Set(),providers=c.providers.map(p=>{
    assert(p.adapter==='payward-v2'&&p.environment==='sandbox'||p.adapter==='changenow-v2'&&p.environment==='simulation','ChangeNOW requires isolated simulation; live orders are not qualified');assert(/^[a-z0-9-]{1,40}$/.test(p.id));
    assert(new Set(p.bindings.map(b=>b.owner)).size===p.bindings.length,'ambiguous owner mapping');
    assert(new Set(p.bindings.map(b=>b.account)).size===p.bindings.length,'shared client accounts are not permitted');
    for(const b of p.bindings){assert(Number.isSafeInteger(b.expiresAt));assert(b.routes.length<=8&&b.destinations.length<=8);}
    const path=resolve(root,p.database);assert(!paths.has(path),'provider journals must be isolated');paths.add(path);
    const db=new DatabaseSync(path);dbs.push(db);
    const credentials=async()=>{assert(env[p.credentialFileEnv],'provider credentials not configured');return read(env[p.credentialFileEnv]);};
    const transport=p.adapter==='changenow-v2'?new ChangeNowTransport({environment:'simulation',simulationUrl:p.simulationUrl,credentials}):new PaywardTransport({environment:'sandbox',credentials});
    const routes=p.adapter==='changenow-v2'?[...new Map(p.bindings.flatMap(b=>b.routes).map(r=>[JSON.stringify(r),r])).values()]:[];
    const adapter=p.adapter==='changenow-v2'?new ChangeNowAdapter({transport,admit:bindingAdmission(p.bindings),routes}):new PaywardAdapter({transport,admit:bindingAdmission(p.bindings)});
    const engine=new ProviderExchange(db,{adapter,scope:p.scope,storageKey,signingKey:signer});
    return {...p,engine,binding:async owner=>p.bindings.find(b=>b.owner===owner)??null};
  });
  assert(!paths.has(resolve(root,c.apiDatabase)));const db=new DatabaseSync(resolve(root,c.apiDatabase));dbs.push(db);
  const api=new ExchangeBrokerAPI({db,scope:c.scope,signer,providers});
  return {api,port:c.port,close:()=>dbs.forEach(db=>db.close()),profile:{url:c.publicUrl,scope:c.scope,key:signer.publicKey,providers:providers.map(p=>({id:p.id,label:p.label,scope:p.scope,identity:p.engine.adapter.identity,reviewKey:signer.publicKey}))}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const runtime=configuredBroker(resolve(process.argv[2]));
  if(process.argv.includes('--check')) {console.log(JSON.stringify({configured:true,profile:runtime.profile,profileHash:hash(runtime.profile)}));runtime.close();}
  else {
    const server=exchangeBrokerServer(runtime.api);server.listen(runtime.port,'127.0.0.1',()=>console.log('Exchange sandbox broker listening on loopback; use authenticated TLS proxy.'));
    let stopping=false;const stop=()=>{if(stopping)return;stopping=true;server.close(async()=>{await server.drainExchangeRecovery();runtime.close();process.exit(0);});};
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
  }
}
