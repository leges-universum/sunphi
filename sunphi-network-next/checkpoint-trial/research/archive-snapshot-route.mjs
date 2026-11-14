// Bounded read-only transport for preflight. Uses the SAME signed manifests and
// Merkle-proven chunks as Comet state sync; introduces no new state authority.
import assert from 'node:assert/strict';
import {exact,integer} from '../crypto.mjs';
export const ARCHIVE_SNAPSHOTS='DUEBYTE_ARCHIVE_SNAPSHOTS_V1';
export const ARCHIVE_SNAPSHOT_CHUNK='DUEBYTE_ARCHIVE_SNAPSHOT_CHUNK_V1';
export function archiveSnapshotQuery(repository,request){
 assert(repository,'snapshots unavailable');
 if(request.operation===ARCHIVE_SNAPSHOTS){exact(request,['operation']);return repository.list();}
 assert.equal(request.operation,ARCHIVE_SNAPSHOT_CHUNK);exact(request,['operation','height','index']);integer(request.height,1);integer(request.index);return repository.load(request);
}
export async function fetchArchiveSnapshot(source,request,{signal}={}){
 const u=new URL(source);assert(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash);
 const r=await fetch(source,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'abci_query',params:{path:'/work',data:Buffer.from(JSON.stringify(request)).toString('hex')}}),signal:AbortSignal.any([AbortSignal.timeout(10000),...(signal?[signal]:[])])});assert(r.ok);let size=0;const parts=[];
 for await(const bytes of r.body){size+=bytes.length;assert(size<=3*1024*1024,'snapshot transport response bound');parts.push(bytes);}
 const reply=JSON.parse(Buffer.concat(parts));assert(!reply.error&&!reply.result.response.code,'snapshot transport unavailable');return JSON.parse(Buffer.from(reply.result.response.value,'base64'));
}
