import assert from 'node:assert/strict';
import {amount,policy} from './payment-model.mjs';
import {eligibleLiabilityWorker,effectiveWorkGroup,founderWorker} from './payment-liability.mjs';
export function plan(money,value){let left=amount(value);const workers=Object.entries(money.nodes).map(([id,n])=>({id,group:effectiveWorkGroup(money,id),tier:BigInt(n.tier),free:BigInt(n.stake)-BigInt(n.consensusHeld)-BigInt(n.taskHeld)})).filter(n=>eligibleLiabilityWorker(money,n.id)&&n.tier>0n&&n.free>0n&&BigInt(money.nodes[n.id].consensusHeld)>0n),parts=[];
 // Rank usable per-part capacity, not collateral that the worker's tier cannot use.
 const capacity=n=>n.free<n.tier?n.free:n.tier;
 while(left>0n){const groups=new Set(),chosen=[];workers.sort((a,b)=>{const ac=capacity(a),bc=capacity(b);return ac===bc?(a.free===b.free?a.id.localeCompare(b.id):a.free>b.free?-1:1):ac>bc?-1:1;});for(const n of workers)if(n.free>0n&&(!groups.has(n.group)||founderWorker(money,n.id))){groups.add(n.group);chosen.push(n);if(chosen.length===3)break;}assert.equal(chosen.length,3,'not enough independent worker capacity');let v=left;for(const n of chosen){if(n.free<v)v=n.free;if(n.tier<v)v=n.tier;}assert(v>0n);parts.push({value:String(v),nodes:chosen.map(n=>n.id)});assert(parts.length<=policy.maxParts,'trial plan limit');for(const n of chosen)n.free-=v;left-=v;}
 return parts;
}
