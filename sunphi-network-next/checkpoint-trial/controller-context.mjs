// Internal execution capability. Never serialized or accepted from a wire.
const contexts=new WeakMap();
export const controllerContext=s=>contexts.get((s.money??s).outputs);
export function withControllerContext(money,context,run){const key=money.outputs,old=contexts.get(key);contexts.set(key,context);try{return run();}finally{if(old)contexts.set(key,old);else contexts.delete(key);}}
export function copyControllerState(base,fields){if(!controllerContext(base))return structuredClone(base);const out={...base,money:{...base.money}};for(const field of fields)if(base[field]!==undefined)out[field]=structuredClone(base[field]);return out;}
export const ownedOutputs=(money,owner)=>controllerContext(money)?.owned(owner)??Object.entries(money.outputs).filter(([,o])=>o.owner===owner);
