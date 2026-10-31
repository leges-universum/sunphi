// Only a bounded category crosses IPC. Never forward RPC bodies, paths or stderr.
export function verificationFailure(error){
 if(error instanceof AggregateError)return error.errors.length&&error.errors.every(e=>verificationFailure(e)==='retry')?'retry':'attention';
 if(['SNAPSHOT_PENDING','VERIFIER_TIMEOUT','HISTORY_RECOVERING'].includes(error?.code)||['TimeoutError','AbortError'].includes(error?.name))return 'retry';
 if(error?.message==='fetch failed'&&['ECONNREFUSED','ECONNRESET','ETIMEDOUT','UND_ERR_SOCKET'].includes(error.cause?.code))return 'retry';
 return ['wallet requires seven fresh witness heads','wallet waiting for fresh chain progress','wallet freshness samples expired','wallet sealed history is stale','wallet monotonic freshness expired','wallet refresh required','wallet snapshot expired during verification','inventory snapshot expired','delta snapshot expired','discovery changed while verifying; retry bounded synchronization'].includes(error?.message)?'retry':'attention';
}
