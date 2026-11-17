import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {keys} from '../crypto.mjs';
import {configuredBroker} from '../exchange-broker-run.mjs';
test('sandbox configuration starts without credentials or financial calls, reopens pinned journals, rejects production',t=>{
 const base=resolve(tmpdir()),dir=mkdtempSync(join(base,'duebyte-broker-config-'));
 t.after(()=>{assert.equal(dirname(resolve(dir)),base);rmSync(dir,{recursive:true,force:true});});
 const c=JSON.parse(readFileSync(new URL('../exchange-broker.sandbox.example.json',import.meta.url),'utf8'));
 c.publicUrl='https://sandbox.example.invalid/exchange/v1';
 const signer=keys(),file=join(dir,'config.json');writeFileSync(file,JSON.stringify(c));writeFileSync(join(dir,'signing.json'),JSON.stringify(signer));writeFileSync(join(dir,'storage.key'),Buffer.alloc(32,6).toString('base64'));
 const env={DUEBYTE_BROKER_SIGNING_FILE:'signing.json',DUEBYTE_BROKER_STORAGE_KEY_FILE:'storage.key'};
 const first=configuredBroker(relative(process.cwd(),file),{env});assert.equal(first.profile.key,signer.publicKey);assert.equal(first.api.providers.size,1);first.close();
 const reopened=configuredBroker(file,{env});assert.equal(reopened.api.db.prepare('SELECT count(*) n FROM broker_requests').get().n,0);assert.equal([...reopened.api.providers.values()][0].engine.db.prepare('SELECT count(*) n FROM provider_exchange_commands').get().n,0);reopened.close();
 writeFileSync(file,JSON.stringify({...c,environment:'production'}));assert.throws(()=>configuredBroker(file,{env}),/sandbox only/);
});

test('ChangeNOW simulation configuration stays pinned to loopback and cannot become a live trading endpoint',()=>{
 const dir=mkdtempSync(join(tmpdir(),'duebyte-changenow-config-')),c=JSON.parse(readFileSync(new URL('../exchange-broker.changenow-simulation.example.json',import.meta.url),'utf8')),file=join(dir,'config.json');
 c.publicUrl='https://isolated.example.invalid/exchange/v1';writeFileSync(file,JSON.stringify(c));writeFileSync(join(dir,'signing.json'),JSON.stringify(keys()));writeFileSync(join(dir,'storage.key'),Buffer.alloc(32,9).toString('base64'));
 const env={DUEBYTE_BROKER_SIGNING_FILE:'signing.json',DUEBYTE_BROKER_STORAGE_KEY_FILE:'storage.key'};
 const r=configuredBroker(file,{env});assert.equal(r.profile.providers[0].identity,'changenow-v2:simulation');r.close();
 c.providers[0].environment='production';writeFileSync(file,JSON.stringify(c));assert.throws(()=>configuredBroker(file,{env}),/isolated simulation/);
});
