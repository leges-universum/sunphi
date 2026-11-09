import {execFileSync} from 'node:child_process';
// reg.exe uses the console code page, not UTF-8. Read the Unicode registry
// value directly and explicitly encode stdout, independent of system locale.
export function readUserRegistryString(subkey,name){
 const payload=Buffer.from(JSON.stringify({subkey,name}),'utf8').toString('base64');
 const script=`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json; $k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($p.subkey); if($null -eq $k){exit 0}; try { if($k.GetValueKind($p.name) -eq [Microsoft.Win32.RegistryValueKind]::String){[Console]::Write([string]$k.GetValue($p.name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames))} } finally {$k.Dispose()}`;
 try{return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:10000,stdio:['ignore','pipe','pipe']});}catch{return '';}
}
