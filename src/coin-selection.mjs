import {MAX_NOTE} from './circuit.mjs';
// Current proof supports at most two inputs. Never silently split a payment or
// create a consolidation transaction/fee the user did not review.
export function selectCoins(notes,amount,fee=0n){
 if(typeof amount!=='bigint'||amount<=0n||amount>MAX_NOTE||typeof fee!=='bigint'||fee<0n||fee>MAX_NOTE||!Array.isArray(notes)||notes.length>256)throw Error('selection bounds');
 const seen=new Set(),items=notes.map(n=>{if(typeof n.id!=='string'||seen.has(n.id)||typeof n.amount!=='string'||!/^[1-9][0-9]*$/.test(n.amount))throw Error('invalid selection note');seen.add(n.id);const value=BigInt(n.amount);if(value>MAX_NOTE)throw Error('note range');return {...n,value};}),target=amount+fee;
 let best;function consider(a){const sum=a.reduce((s,n)=>s+n.value,0n),change=sum-target;if(change<0n||change>MAX_NOTE)return;const ids=a.map(n=>n.id).sort();if(!best||a.length<best.ids.length||a.length===best.ids.length&&(change<best.change||change===best.change&&ids.join(',')<best.ids.join(',')))best={ids,change};}
 items.forEach(n=>consider([n]));if(!best)for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++)consider([items[i],items[j]]);
 if(!best)throw Error(items.reduce((s,n)=>s+n.value,0n)<target?'Insufficient verified available funds':'Funds are fragmented: this proof accepts at most two inputs; consolidation is required');return {ids:best.ids,change:best.change.toString()};
}
