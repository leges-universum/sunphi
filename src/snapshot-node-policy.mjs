import {loopback} from './history-io.mjs';
export function validateBootstrapConfig(toml,certified,publicKey){
 const v=new Map();let section='';
 for(const raw of toml.split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith('#'))continue;const group=line.match(/^\[([\w.]+)\]$/);if(group){section=group[1];continue;}const item=line.match(/^(\w+)\s*=\s*(.*)$/);if(item){const key=`${section}.${item[1]}`;if(v.has(key))throw Error('duplicate bootstrap setting');v.set(key,item[2].trim());}}
 const text=key=>{const raw=v.get(key);if(!/^"[^"\r\n]*"$/.test(raw??''))throw Error('bootstrap string setting');return raw.slice(1,-1);};
 if(text('.db_backend')!=='goleveldb'||v.get('statesync.enable')!=='true'||v.get('statesync.trust_height')!==String(certified.trust.height)||text('statesync.trust_hash').toLowerCase()!==certified.trust.hash||text('statesync.trust_period')!=='24h0m0s')throw Error('state sync must pin independently verified checkpoint');
 const rpc=text('statesync.rpc_servers').split(',');if(rpc.length!==2||new Set(rpc.map(loopback)).size!==2)throw Error('two distinct isolated RPC endpoints required');
 const key=Buffer.from(publicKey,'base64').toString('hex');
 if(!/^[a-f0-9]{64}$/.test(key)||certified.isKnownSigningKey(key))throw Error('snapshot bootstrap is for a new non-voting node only');
 return true;
}
