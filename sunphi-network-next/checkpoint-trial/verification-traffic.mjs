import {channel} from 'node:diagnostics_channel';

// Count transport bytes at the local verifier boundary. Never retain requests,
// remote addresses, messages, or payloads in the activity history.
export function verificationTraffic(urls){
 const origins=new Set(urls.filter(Boolean).map(url=>new URL(url).origin));
 const active=new Map(),finished={incoming:0,outgoing:0};
 let observed=false;
 const track=({request,socket})=>{
  if(!origins.has(String(request.origin))||active.has(socket))return;
  observed=true;
  const start={incoming:socket.bytesRead,outgoing:socket.bytesWritten};
  active.set(socket,start);
  socket.once('close',()=>{
   finished.incoming+=socket.bytesRead-start.incoming;
   finished.outgoing+=socket.bytesWritten-start.outgoing;
   active.delete(socket);
  });
 };
 const events=channel('undici:client:sendHeaders');events.subscribe(track);
 return {snapshot(){
  if(!observed)return null;
  const totals={...finished};
  for(const [socket,start] of active){
   totals.incoming+=socket.bytesRead-start.incoming;
   totals.outgoing+=socket.bytesWritten-start.outgoing;
  }
  return totals;
 },close(){events.unsubscribe(track);}};
}
