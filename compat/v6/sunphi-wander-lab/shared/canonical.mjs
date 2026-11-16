export function canonical(x) {
  if(x===null||typeof x==='boolean'||typeof x==='string')return JSON.stringify(x);
  if(typeof x==='number'){if(!Number.isSafeInteger(x))throw Error('Only safe integers are permitted');return String(x);}
  if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';
  if(typeof x==='object'&&Object.getPrototypeOf(x)===Object.prototype)return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
  throw Error('Unsupported canonical value');
}
export function fields(object,names){
  if(!object||Array.isArray(object)||Object.keys(object).sort().join('|')!==[...names].sort().join('|'))throw Error('Unexpected message fields');
}
