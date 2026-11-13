// Versioned interpreters are package-owned. Never select code from node data,
// peer responses, environment variables or an unverified filesystem search.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {indexedSchemaRootTerms} from './research/indexed-schema-upgrade.mjs';
import {sha256,safeRelative,loadRelease} from './update-core.mjs';
import {validateConsumerProfile} from './consumer-profile.mjs';
import {freshRootTerms} from './research/fresh-application.mjs';
import {assertStateInstallationComplete} from './state-access.mjs';

export const V6_RELEASE_PINS=Object.freeze({
 'home/windows-x64':'78d1ae672d28b163672e894a5b4bd36d53291905ad6152cff93443d08abc15ec',
 'home/linux-x64':'491bea32d6c260a5bc0fb28d602022fd218d1de8800e4e711b1dfe8ff5d7a5ed',
 'server/linux-x64':'feb36180d3f5bd22a26e1896503c3debb50a9d033e98fc46b0c836a656c3b9bc'
});
export const COMPATIBILITY_EXECUTABLES=Object.freeze([
 'runtime/node','sunphi-network-next/checkpoint-trial/build/duebyte-abci',
 'sunphi-network-next/.local/bft-runtime/bin/cometbft'
]);
export function installCompatibilityPermissions(root){
 if(process.platform==='win32'||!fs.existsSync(path.join(root,'compat','v6')))return;
 // Explicit installer operation, after authenticating every legacy file.
 // Never repair package contents or permissions from a network response.
 verifyCompatibilityRuntime(root);
 for(const name of COMPATIBILITY_EXECUTABLES)fs.chmodSync(path.join(root,'compat','v6',name),0o755);
}
export function verifyCompatibilityRuntime(root){
 const release=loadRelease(root),directory=path.join(root,'compat','v6');
 for(const p of [path.join(root,'compat'),directory])assert(fs.lstatSync(p).isDirectory()&&!fs.lstatSync(p).isSymbolicLink(),'regular compatibility directory required');
 const bytes=fs.readFileSync(path.join(directory,'manifest.json'));
 assert.equal(sha256(bytes),V6_RELEASE_PINS[release.edition+'/'+release.platform],'unrecognized compatibility runtime');
 const manifest=JSON.parse(bytes),files=[];
 assert.equal(manifest.version,'0.3.56');assert.equal(manifest.edition,release.edition);assert.equal(manifest.platform,release.platform);
 function walk(dir,prefix=''){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  assert(!e.isSymbolicLink(),'compatibility runtime link');const name=prefix+e.name;
  if(e.isDirectory())walk(path.join(dir,e.name),name+'/');else{assert(e.isFile());files.push(name);}
 }}walk(directory);
 assert.deepEqual(files.filter(n=>n!=='manifest.json'&&n!=='START-HERE.txt').sort(),Object.keys(manifest.files).sort(),'unexpected compatibility files');
 for(const [name,digest]of Object.entries(manifest.files)){safeRelative(name);assert.equal(sha256(fs.readFileSync(path.join(directory,name))),digest,'damaged compatibility file '+name);}
 const previous=loadRelease(directory);assert.equal(previous.networkPin,release.networkPin,'compatibility network differs');
 return path.join(directory,'sunphi-network-next/checkpoint-trial');
}
const moduleAt=(directory,name)=>import(pathToFileURL(path.join(directory,name+'.mjs')).href);
export async function selectFreshRuntime(root,config,fresh){
 try{freshRootTerms(config,fresh);return {kind:'current',directory:import.meta.dirname};}
 catch(currentError){
  // The prior interpreter must independently authenticate its original root.
  // Failure of both interpreters is an error, never a reset or a new pin.
  if(!fs.existsSync(path.join(root,'compat','v6')))throw currentError;
  const directory=verifyCompatibilityRuntime(root),previous=await moduleAt(directory,'research/fresh-application');
  previous.freshRootTerms(config,fresh);
  return {kind:'v6',directory};
 }
}
export async function consumerRuntime(root,profile,pin){
 const selected=profile.fresh?await selectFreshRuntime(root,profile.config,profile.fresh):{kind:'current',directory:import.meta.dirname};
 const validation=selected.kind==='current'?{validateConsumerProfile}:await moduleAt(selected.directory,'consumer-profile');
 validation.validateConsumerProfile(profile,pin);
 return {...selected,profile,pin,load:name=>moduleAt(selected.directory,name)};
}
export async function applicationRuntime(root,config,fresh){
 const selected=fresh?await selectFreshRuntime(root,config,fresh):{kind:'current',directory:import.meta.dirname};
 const names=['research/bounded-application','research/bounded-network-interpreter','research/bounded-api','research/indexed-checkpoint','research/indexed-snapshot','research/bounded-root-transition','research/fresh-application'];
 return {kind:selected.kind,...Object.assign({},...await Promise.all(names.map(name=>moduleAt(selected.directory,name))))};
}
export async function serviceRuntime(root,profile,home){
 const read=file=>JSON.parse(fs.readFileSync(file));
 const settings=path.join(profile,'indexed-checkpoint-operator.json');
 home??=fs.existsSync(settings)?read(settings).applicationHome:profile;
 assertStateInstallationComplete(home);
 const config=read(path.join(profile,'app-config.json'));
 const schema=path.join(home,'indexed-schema-activation.json'),fresh=path.join(home,'fresh-activation.json');
 assert(!(fs.existsSync(schema)&&fs.existsSync(fresh)),'ambiguous service authority');
 if(fs.existsSync(schema)){const {certificate,trustedBoundary}=read(schema);indexedSchemaRootTerms(config,{certificate,trustedBoundary});return {kind:'current',directory:import.meta.dirname};}
 return fs.existsSync(fresh)?selectFreshRuntime(root,config,read(fresh)):{kind:'current',directory:import.meta.dirname};
}
export async function runCompatibleService(root,profile,name,args){
 assert(['expiry-relay','checkpoint-failover'].includes(name));
 const selected=await serviceRuntime(root,profile);if(selected.kind==='current')return false;
 const child=spawn(process.execPath,[path.join(selected.directory,name+'.mjs'),...args],{stdio:'inherit',windowsHide:true});
 const stop=signal=>child.kill(signal),term=()=>stop('SIGTERM'),interrupt=()=>stop('SIGINT');
 process.on('SIGTERM',term);process.on('SIGINT',interrupt);
 try{process.exitCode=await new Promise((ok,fail)=>{child.once('error',fail);child.once('close',(code,signal)=>ok(code??(signal?1:0)));});}
 finally{process.off('SIGTERM',term);process.off('SIGINT',interrupt);}return true;
}
