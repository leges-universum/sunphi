import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {execFileSync} from 'node:child_process';
import {readUserRegistryString} from '../windows-registry.mjs';
test('Unicode registry paths round-trip independently of the console code page',{skip:process.platform!=='win32'},()=>{
 const subkey='Software\\DueByte-QA\\'+randomUUID(),name='test-path',value='"D:\\O\'Brien & \u041f\u0430\u043f\u043a\u0430 \\ \u4e2d\u6587 \u0627\u0644\u0645\u0644\u0641\u0627\u062a \u0939\u093f\u0928\u094d\u0926\u0940 \ud83d\udcc1\\DueByte.exe" --connect';
 const payload=Buffer.from(JSON.stringify({subkey,name,value})).toString('base64'),header=`$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json;`;
 const ps=script=>execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:'pipe'});
 try{ps(header+"$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($p.subkey); try {$k.SetValue($p.name,$p.value,[Microsoft.Win32.RegistryValueKind]::String)} finally {$k.Dispose()}");assert.equal(readUserRegistryString(subkey,name),value);assert.equal(readUserRegistryString(subkey,'absent'),'');}
 finally{ps(header+'[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($p.subkey,$false)');}
});
