export function validateNodeLaunch(config,toml,base){
 if(config?.mode!=='isolated'||typeof config.chainId!=='string'||!config.chainId.startsWith('sunphi-lab-'))throw Error('isolated chain only');
 if(!Number.isInteger(base)||base<1024||base>65530)throw Error('port range');
 const values=new Map();let section='';
 for(const raw of toml.split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith('#'))continue;const group=line.match(/^\[([\w.]+)\]$/);if(group){section=group[1];continue;}const item=line.match(/^(\w+)\s*=\s*(.*)$/);if(item){const k=`${section}.${item[1]}`;if(values.has(k))throw Error('duplicate node setting');values.set(k,item[2].trim());}}
 const string=k=>{const v=values.get(k);if(!v||!/^"[^"\r\n]*"$/.test(v))throw Error('unsupported node setting '+k);return v.slice(1,-1);};
 for(const [key,port] of [['.proxy_app',base+2],['rpc.laddr',base+1],['p2p.laddr',base]])if(string(key)!==`tcp://127.0.0.1:${port}`)throw Error('loopback port/config mismatch');
 for(const key of ['.priv_validator_laddr','rpc.grpc_laddr'])if(string(key)!=='')throw Error('remote signer / gRPC disabled');
 if(string('rpc.pprof_laddr')!==''&&string('rpc.pprof_laddr')!=='localhost:6060')throw Error('profiler binding');
 if(values.get('instrumentation.prometheus')!=='false')throw Error('external metrics disabled');
 for(const key of ['p2p.seeds','p2p.persistent_peers'])for(const peer of string(key).split(',').filter(Boolean))if(!/^[0-9a-f]{40}@127\.0\.0\.1:[0-9]{4,5}$/.test(peer))throw Error('loopback peers required');
 return true;
}
