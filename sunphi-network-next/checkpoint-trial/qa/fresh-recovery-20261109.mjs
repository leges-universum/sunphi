// Independent, password-only recovery of a STOPPED synthetic new-chain signer.
import fs from 'node:fs';import assert from 'node:assert/strict';import {join} from 'node:path';import {spawnSync,spawn} from 'node:child_process';import {randomBytes} from 'node:crypto';
import {encryptArchive} from './backup-stream-20261108.mjs';
import {sealBackupKey,digestFile,recoverPortableArchive} from './portable-network-backup.mjs';
import {withStoppedRecoveryState} from '../recovery-state.mjs';
export async function exerciseFreshRecovery({out,home,packageRoot,onSealed=()=>{}}){
 const backup=join(out,'encrypted-recovery'),restored=join(out,'independent-restored');fs.mkdirSync(backup,{mode:0o700});fs.mkdirSync(restored,{mode:0o700});
 const password=randomBytes(24).toString('base64url'),key=randomBytes(32),name='node0.tar.gz.enc',file=join(backup,name);
 let enc;const expected=await withStoppedRecoveryState(home,{packageRoot},async()=>{
  // This database is only an OS ownership lock, never network or signer state.
  // Recreate it on restore; copying its active journal is invalid on Windows.
  const exclusions=['','-journal','-wal','-shm'].map(s=>'--exclude=./state-access.sqlite'+s);
  const tar=spawn('tar',['-czf','-',...exclusions,'-C',home,'.'],{stdio:['ignore','pipe','pipe']});let errors='';tar.stderr.on('data',b=>errors+=b);const ended=new Promise(r=>tar.once('exit',r));enc=await encryptArchive(tar.stdout,file,key);assert.equal(await ended,0,errors);
 });
 const manifest={setId:randomBytes(16).toString('hex'),archives:[{name,bytes:fs.statSync(file).size,sha256:await digestFile(file),compressedSha256:enc.compressedSha256}]};fs.writeFileSync(join(backup,'recovery-key.encrypted.json'),JSON.stringify(sealBackupKey(key,password,manifest)),{mode:0o600});key.fill(0);
 // Test controller may carry this in memory for a different-host restore.
 // Never write the password to evidence, command arguments or a report.
 await onSealed({password,expected});
 const script=join(import.meta.dirname,'portable-network-backup.mjs'),archive=join(restored,'restored.tar.gz');
 const run=pass=>spawnSync(process.execPath,[script,backup,name,archive],{input:pass,encoding:'utf8',env:{PATH:process.env.PATH,HOME:restored},timeout:60000});
 assert.notEqual(run('incorrect-password-for-isolated-test').status,0);assert(!fs.existsSync(archive));const ok=run(password);assert.equal(ok.status,0,ok.stderr);assert.equal(JSON.parse(ok.stdout).servicesStarted,false);assert.notEqual(run(password).status,0,'must refuse overwrite');
 const extracted=join(restored,'node');fs.mkdirSync(extracted);const unpack=spawnSync('tar',['-xzf',archive,'-C',extracted],{encoding:'utf8'});assert.equal(unpack.status,0,unpack.stderr);
 // Verification in another process has no original node paths or credentials.
 const code=`import {withStoppedRecoveryState} from ${JSON.stringify(new URL('../recovery-state.mjs',import.meta.url).href)};console.log(JSON.stringify(await withStoppedRecoveryState(process.argv[1],{packageRoot:process.argv[2]||undefined})));`;
 const verify=spawnSync(process.execPath,['--input-type=module','-e',code,extracted,packageRoot??''],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:restored},timeout:60000});assert.equal(verify.status,0,verify.stderr);const actual=JSON.parse(verify.stdout);assert.deepEqual(actual,expected);
 // Tamper a separate encrypted copy, never the verified recovery set.
 const bad=join(out,'tampered-recovery');fs.mkdirSync(bad);fs.copyFileSync(join(backup,'recovery-key.encrypted.json'),join(bad,'recovery-key.encrypted.json'));const bytes=fs.readFileSync(file);bytes[30]^=1;fs.writeFileSync(join(bad,name),bytes);await assert.rejects(()=>recoverPortableArchive(bad,password,name,join(restored,'must-not-exist.gz')));assert(!fs.existsSync(join(restored,'must-not-exist.gz')));
 return {passed:true,scope:'SYNTHETIC_CHAIN_ONLY',format:expected.format,height:expected.height,root:expected.root,restoredHome:extracted,signingStateRetained:Object.keys(expected.identities).length===3,stateHash:expected.stateHash,passwordOnly:true,separateProcess:true,windowsAccountRequired:false,networkAccess:false,servicesStarted:false,safeToStartSigner:false,requiresCurrentSigningWatermark:true,usbTouched:false,productionRecoveryKit:false};
}
