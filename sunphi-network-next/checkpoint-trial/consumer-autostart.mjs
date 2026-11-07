import {readUserRegistryString} from './windows-registry.mjs';
import path from 'node:path';
export const startupName='com.duebyte.node';
const startupArgs=['--connect'];
function registeredCommand(name){
 return readUserRegistryString('Software\\Microsoft\\Windows\\CurrentVersion\\Run',name);
}
export function createAutoStart(app,{exe=process.execPath,platform=process.platform,isolated=false,name=startupName,readCommand=registeredCommand}={}){
 const available=platform==='win32'&&!isolated;
 // Electron44.8 parses an unquoted path at spaces. Quoted lookup also works
 // with the upstream fix. The setter itself expects the ordinary raw path.
 const read=target=>app.getLoginItemSettings({path:'"'+target+'"',args:startupArgs});
 const active=s=>s.openAtLogin&&s.launchItems.some(item=>item.name===name&&item.scope==='user'&&item.enabled);
 const set=enabled=>{if(!available)throw Error('Windows startup is unavailable in this installation.');app.setLoginItemSettings({name,path:exe,args:startupArgs,openAtLogin:enabled,enabled});};
 // Preserve an already enabled setting when a signed update changes the EXE
 // directory. Never enable an entry the user disabled in Windows Settings.
 if(available){const command=readCommand(name),match=/^"([^"\r\n]+)"\s+--connect$/.exec(command);if(match&&path.win32.basename(match[1]).toLowerCase()==='duebyte.exe'&&path.win32.normalize(match[1]).toLowerCase()!==path.win32.normalize(exe).toLowerCase()&&active(read(match[1])))set(true);}
 return {available,get:()=>available&&active(read(exe)),set};
}
