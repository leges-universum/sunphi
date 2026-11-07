// Read-only production snapshot, historical reader compatibility, and service inventory.
import fs from 'node:fs';import assert from 'node:assert/strict';import {remote} from './admin-remote.mjs';
import {pathToFileURL} from 'node:url';
const work='D:/CodexData/duebyte-editions-0.3.35',prior='/opt/duebyte-server/releases/0.3.32',out=process.argv[2]||work+'/preflight.json';
fs.mkdirSync(work,{recursive:true});assert(!fs.existsSync(out),'fresh evidence required');
const inventory=await Promise.allSettled([0,1,2,3].map(async host=>JSON.parse(await remote(host,`${prior}/runtime/node --input-type=module <<'INVENTORY'
import fs from 'node:fs';import assert from 'node:assert/strict';import{execFileSync}from'node:child_process';
const rows=JSON.parse(fs.readFileSync('/etc/duebyte-server/instances.json')).instances;
const services=rows.map(r=>{const status=execFileSync('systemctl',['is-active',r.unit],{encoding:'utf8'}).trim();assert.equal(status,'active');const command=execFileSync('systemctl',['show',r.unit,'-p','ExecStart','--value'],{encoding:'utf8'});assert(command.includes('/opt/duebyte-server/releases/'+r.version+'/'));return{unit:r.unit,role:r.role,version:r.version,active:true};});console.log(JSON.stringify({host:${host},services}));
INVENTORY
`))));
for(const r of inventory)if(r.status!=='fulfilled')throw r.reason;
const network=JSON.parse(await remote(0,`${prior}/runtime/node --input-type=module <<'READERS'
import assert from'node:assert/strict';
const rpc=async(slot,method,params={})=>{const j=await(await fetch('http://127.0.0.1:'+(22001+slot*10),{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(10000)})).json();assert(!j.error&&!j.result?.response?.code);return j.result;};
const statuses=await Promise.all(Array.from({length:10},(_,i)=>rpc(i,'status')));assert(statuses.every(s=>!s.sync_info.catching_up));const height=Math.min(...statuses.map(s=>Number(s.sync_info.latest_block_height)))-2;
const rows=[],homes=[];let snapshot;
for(let slot=0;slot<10;slot++){const q=await rpc(slot,'abci_query',{path:'/snapshot',data:Buffer.from(String(height)).toString('hex')}),s=JSON.parse(Buffer.from(q.response.value,'base64'));snapshot??=s;rows.push({slot,height:Number(statuses[slot].sync_info.latest_block_height),appHash:s.appHash});const peers=await rpc(slot,'net_info');for(const p of peers.peers)if(p.node_info.moniker.startsWith('DESKTOP-'))homes.push({id:p.node_info.id,label:p.node_info.moniker,transportVersion:p.node_info.version});}
assert.equal(new Set(rows.map(r=>r.appHash)).size,1);console.log(JSON.stringify({height,rows,homes:[...new Map(homes.map(h=>[h.id,h])).values()],snapshot}));
READERS
`));
const {stateHash}=await import(pathToFileURL(work+'/packages-release/DueByte-Server-0.3.35-Linux-x64/sunphi-network-next/checkpoint-trial/core.mjs'));
const {hash}=await import('../crypto.mjs');const config=JSON.parse(fs.readFileSync(work+'/connection-profile.json')).config,s=network.snapshot.state;
assert.equal(stateHash(s,config),network.snapshot.appHash);assert.equal(s.money.supply,'2000');assert.equal(s.money.fees,'46');assert(!s.rewards&&!s.authority.nodeRewards&&!s.networkReserves.issued&&!s.economicPreparation);assert.equal(s.money.liability.pool,'0');
const financial={supply:s.money.supply,fees:s.money.fees,outputs:hash(s.money.outputs),nodes:hash(s.money.nodes)};
assert.deepEqual(financial,JSON.parse(fs.readFileSync('D:/CodexData/duebyte-protection-20261107/live-activation.json')).before.financial);
fs.writeFileSync(out,JSON.stringify({passed:true,at:new Date().toISOString(),readOnly:true,inventory:inventory.map(r=>r.value),...network,financial,reader35Compatible:true,issuance:false},null,2));
console.log(JSON.stringify({passed:true,height:network.height,validators:10,services:inventory.map(r=>r.value.services.length),versions:[...new Set(inventory.flatMap(r=>r.value.services.map(s=>s.version)))],homes:network.homes,financialPreserved:true,issuance:false}));
