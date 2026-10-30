import { DesktopSession } from './session.mjs';
const session=new DesktopSession({root:process.argv[2],profile:process.argv[3]});
let stopping=false;
process.on('message',async m=>{
 if(stopping||!m||!Number.isSafeInteger(m.id))return;
 try{const value=await session.execute(m.action,m.args);if(process.connected)process.send({id:m.id,ok:true,value});}
 catch{if(process.connected)process.send({id:m.id,ok:false,error:'Operation could not be completed. Check the selected file, password and network availability. Existing wallet data has not been replaced.'});}
});
async function stop(){if(stopping)return;stopping=true;while(session.busy)await new Promise(r=>setTimeout(r,100));await session.close();process.exit(0);}
process.on('disconnect',stop);process.on('SIGTERM',stop);
