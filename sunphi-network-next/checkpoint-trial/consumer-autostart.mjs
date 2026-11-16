import {readUserRegistryString} from './windows-registry.mjs';
import {releaseAtExe,launchEntryAllowed,parseStartup,managedStartupArgs} from './home-launch-entries.mjs';
export const startupName='com.duebyte.node';
function registeredCommand(name){
 return readUserRegistryString('Software\\Microsoft\\Windows\\CurrentVersion\\Run',name);
}
export function createAutoStart(app,{exe=process.execPath,platform=process.platform,isolated=false,name=startupName,readCommand=registeredCommand,readRelease=releaseAtExe}={}){
 const available=platform==='win32'&&!isolated;
 const entry=()=>parseStartup(readCommand(name));
 let cached=available?entry():null;
 const active=e=>{if(!e)return false;const s=app.getLoginItemSettings({path:'"'+e.target+'"',args:e.args.split(' ')});return s.openAtLogin&&s.launchItems.some(item=>item.name===name&&item.scope==='user'&&item.enabled);};
 const allowed=e=>launchEntryAllowed(e,readRelease(exe),{readRelease});
 const set=enabled=>{
  if(!available)throw Error('Windows startup is unavailable in this installation.');
  const command=readCommand(name),e=entry();
  if(command&&!allowed(e))throw Error('Startup belongs to another installation or a newer version. Open that installation to change it.');
  app.setLoginItemSettings({name,path:exe,args:managedStartupArgs,openAtLogin:enabled,enabled});
  cached=enabled?{target:exe,args:managedStartupArgs.join(' ')}:null;
 };
 return {available,get:()=>!!(available&&active(cached)),set,reconcile:()=>{
  if(!available)return false;const e=entry();
  if(!e||!allowed(e)||!active(e))return false;
  set(true);return true;
 }};
}
