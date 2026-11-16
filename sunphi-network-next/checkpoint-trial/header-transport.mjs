// Transport only. The existing offline Comet verifier authenticates this proof.
import assert from 'node:assert/strict';
const MAX_BYTES=8*1048576;
async function request(url,method,params,signal){
 const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal});
 assert(r.ok,'Header source unavailable');let size=0;const chunks=[];
 for await(const b of r.body){size+=b.length;assert(size<=2*1048576,'Header response budget');chunks.push(b);}
 const result=JSON.parse(Buffer.concat(chunks));assert(!result.error,'Header source unavailable');return result.result;
}
export async function fetchHeaderProof({url,start,end,read=request,timeout=30000}){
 const u=new URL(url);assert(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/','authenticated local header route required');
 assert(Number.isSafeInteger(start)&&start>=1&&Number.isSafeInteger(end)&&end>=start&&end-start<512,'window bound');
 const controller=new AbortController(),deadline=AbortSignal.timeout(timeout),signal=AbortSignal.any([controller.signal,deadline]);
 const proof={version:'2',headers:new Array(end-start+1),sets:{}},sets=new Map();let cursor=start,bytes=0;
 const account=value=>{bytes+=Buffer.byteLength(JSON.stringify(value));if(bytes>MAX_BYTES-16384)throw Object.assign(Error('Header window exceeded the byte budget'),{code:'RECOVERY_WINDOW_TOO_LARGE'});};
 // Four requests at most; no unbounded fan-out or queue per historical block.
 async function worker(){for(;;){if(signal.aborted)throw signal.reason;const height=cursor++;if(height>end)return;
  const result=await read(url,'commit',{height:String(height)},signal),header=result?.signed_header;
  assert(Number(header?.header?.height)===height&&header?.commit,'Header height mismatch');
  const digest=header.header.validators_hash;assert(/^[a-f0-9]{64}$/i.test(digest),'Header validator hash');
  account(header);proof.headers[height-start]=header;
  const id=digest.toLowerCase();if(!sets.has(id))sets.set(id,height);
 }}
 try{
  const workers=Array.from({length:Math.min(4,proof.headers.length)},()=>worker().catch(e=>{controller.abort(e);throw e;}));
  const results=await Promise.allSettled(workers);const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;
  for(const [id,height]of sets){const validators=[];let total=null;
   for(let page=1;;page++){
    const r=await read(url,'validators',{height:String(height),page:String(page),per_page:'100'},signal),n=Number(r?.total);
    assert(Number(r?.block_height)===height&&Number.isSafeInteger(n)&&n>=1&&n<=256,'Validator page bounds');
    total??=n;assert.equal(n,total,'Validator page total changed');const count=Math.min(100,total-validators.length);
    assert(Array.isArray(r.validators)&&r.validators.length===count&&Number(r.count)===count,'Incomplete validator page');
    account(r.validators);validators.push(...r.validators);if(validators.length===total)break;
   }
   proof.sets[id]=validators;
  }
  const text=JSON.stringify(proof);if(Buffer.byteLength(text)>MAX_BYTES)throw Object.assign(Error('Header proof budget'),{code:'RECOVERY_WINDOW_TOO_LARGE'});return text;
 }catch(e){if(deadline.aborted)throw Object.assign(Error('Header download timed out',{cause:e}),{code:'RECOVERY_TRANSPORT_TIMEOUT'});throw e;}
 finally{controller.abort();}
}
