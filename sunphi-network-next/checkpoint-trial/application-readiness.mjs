// A slow local disk/CPU is not a failed process. Keep the wait bounded and
// cancel promptly when the supervisor stops or its owned application exits.
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
export async function waitForApplication({port,alive,stopping,timeoutMs=120000,intervalMs=250}){
 assert(Number.isInteger(port)&&port>=1024&&port<=65535);
 assert(Number.isFinite(timeoutMs)&&timeoutMs>0&&timeoutMs<=120000);
 assert(Number.isFinite(intervalMs)&&intervalMs>0&&intervalMs<=1000);
 const deadline=performance.now()+timeoutMs;
 while(!stopping()&&alive()&&performance.now()<deadline){
  try{
   const response=await fetch(`http://127.0.0.1:${port}`,{method:'POST',body:'{"method":"info"}',signal:AbortSignal.timeout(Math.max(1,Math.min(2000,Math.ceil(deadline-performance.now()))))});
   if(response.ok){const value=await response.json();if(Number.isSafeInteger(value.height)&&value.height>=0&&typeof value.hash==='string'&&/^[A-Za-z0-9+/]{43}=$/.test(value.hash)&&!stopping()&&alive())return true;}
  }catch{}
  if(!stopping()&&alive())await delay(Math.max(1,Math.min(intervalMs,deadline-performance.now())));
 }
 return false;
}
