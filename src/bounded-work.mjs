// Preserve result order and individual failures while bounding expensive work.
// A transport success never changes the caller's cryptographic acceptance rule.
export async function boundedSettled(values,limit,operation){
 if(!Array.isArray(values)||values.length>10||!Number.isInteger(limit)||limit<1||limit>10)throw Error('bounded work limits');
 const results=new Array(values.length);let next=0;
 await Promise.all(Array.from({length:Math.min(limit,values.length)},async()=>{
  while(next<values.length){const i=next++;try{results[i]={status:'fulfilled',value:await operation(values[i],i)};}catch(reason){results[i]={status:'rejected',reason};}}
 }));return results;
}
