// Prospective fresh-chain settings. Never rewrites a running node's configuration.
import assert from 'node:assert/strict';
export const FIXED_BLOCK_TIMING=Object.freeze({mode:'fixed',targetSeconds:10,timeoutCommit:'10s',skipTimeoutCommit:false,createEmptyBlocks:true,createEmptyBlocksInterval:'0s'});
const settings={timeout_commit:'"10s"',skip_timeout_commit:'false',create_empty_blocks:'true',create_empty_blocks_interval:'"0s"'};
function consensusSection(text){
 assert.equal(typeof text,'string');const matches=[...text.matchAll(/^\[consensus\][ \t]*\r?$/gm)];assert.equal(matches.length,1,'Exactly one consensus section required');
 const start=matches[0].index+matches[0][0].length,next=text.slice(start).search(/^\[/m),end=next<0?text.length:start+next;
 return {start,end,body:text.slice(start,end)};
}
export function configureFixedBlockTiming(text){
 const {start,end,body}=consensusSection(text);let result=body;
 for(const [key,value] of Object.entries(settings)){
  const pattern=new RegExp('^'+key+'[ \\t]*=[^\\r\\n]*','gm');assert.equal([...body.matchAll(pattern)].length,1,'Missing or duplicate consensus setting: '+key);
  result=result.replace(pattern,key+' = '+value);
 }
 const configured=text.slice(0,start)+result+text.slice(end);assertFixedBlockTiming(configured);return configured;
}
export function assertFixedBlockTiming(text){
 const {body}=consensusSection(text);
 for(const [key,value] of Object.entries(settings)){
  const matches=[...body.matchAll(new RegExp('^'+key+'[ \\t]*=[ \\t]*([^\\r\\n#]+)','gm'))];
  assert.equal(matches.length,1,'Missing or duplicate consensus setting: '+key);assert.equal(matches[0][1].trim(),value,'Unexpected fixed timing: '+key);
 }
 return true;
}
// Use only for NEW consensus-height policy windows, never payment-action heights
// or already signed/live deadlines. Rounding up does not shorten a safety delay.
export function blocksCoveringSeconds(seconds,{minimum=1,maximum=Number.MAX_SAFE_INTEGER}={}){
 assert(Number.isSafeInteger(seconds)&&seconds>0);assert(Number.isSafeInteger(minimum)&&minimum>0);assert(Number.isSafeInteger(maximum)&&maximum>=minimum);
 const blocks=Math.max(minimum,Math.ceil(seconds/FIXED_BLOCK_TIMING.targetSeconds));assert(blocks<=maximum,'Duration exceeds policy block limit');
 return blocks;
}
