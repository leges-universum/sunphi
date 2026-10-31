export async function loadNetwork(options={}) {
  if(Object.keys(options).some(k=>k!=='mode')) throw new Error('unknown option');
  if(options.mode===undefined || options.mode==='disabled') return Object.freeze({enabled:false,productionSupported:false});
  if(options.mode!=='isolated') throw new Error('production activation is not supported');
  return Object.freeze({enabled:true,productionSupported:false,...await import('./ledger.mjs')});
}
