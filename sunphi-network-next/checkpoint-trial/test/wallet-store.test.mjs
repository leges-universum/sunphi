import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WalletStore} from '../wallet-store.mjs';
import {createVault,unseal} from '../vault.mjs';
import {Wallet} from '../wallet.mjs';
import {prepareRewardIdentity,validRewardConsent} from '../reward-identity.mjs';
import {verify} from '../crypto.mjs';
import {walletConsent} from '../node-rewards.mjs';
const password='isolated-qa-password',network='isolated-qa-network';
const home=()=>mkdtempSync(join(tmpdir(),'duebyte-wallet-store-'));
test('password rotation preserves identity, history, reward selection and independent backups across restart',()=>{
 const dir=home(),next='updated-test-password';
 let store=new WalletStore(dir,network);
 const {id}=store.create(password,'Daily'),other=store.create(password,'Reserve');
 const original=store.backup(id),otherBackup=store.backup(other.id),key=store.unlock(id,password);
 const wallet=new Wallet({client:{},key,home:store.directory(id),routes:{}});
 wallet.db.prepare('INSERT INTO outgoing(pid,body) VALUES(?,?)').run('original-record','{}');wallet.close();
 store.select(id);
 const rewards=store.rewardWallets();
 for(const [old,value] of [['wrong-password',next],[password,'short'],[password,password]]){
  assert.throws(()=>store.changePassword(id,old,value));assert.deepEqual(store.backup(id),original);
 }
 store.changePassword(id,password,next);
 const updated=store.backup(id);
 assert.notDeepEqual(updated.vault,original.vault);
 assert.deepEqual(unseal(original.vault,password),key);assert.throws(()=>unseal(updated.vault,password));
 store.close();store=new WalletStore(dir,network);
 assert.deepEqual(store.unlock(id,next),key);assert.deepEqual(store.backup(other.id),otherBackup);
 assert.deepEqual(store.rewardWallets(),rewards);assert.equal(store.selected().id,id);
 const reopened=new Wallet({client:{},key,home:store.directory(id),routes:{}});
 assert.equal(reopened.db.prepare('SELECT body FROM outgoing WHERE pid=?').get('original-record').body,'{}');
 reopened.close();store.close();
});
test('legacy migration preserves encrypted bytes and original pending outbox across restart',()=>{
 const dir=home(),vault=JSON.stringify(createVault(password));writeFileSync(join(dir,'wallet.encrypted.json'),vault);
 let store=new WalletStore(dir,network);assert.equal(store.selected().id,'legacy');assert.throws(()=>store.create(password),/original wallet once/);
 const key=store.unlock('legacy',password),wallet=new Wallet({client:{},key,home:dir,routes:{}});
 wallet.db.prepare('INSERT INTO outgoing(pid,body) VALUES(?,?)').run('pending-fixture','{}');wallet.close();
 const second=store.create(password,'Second wallet');assert.notEqual(second.id,'legacy');store.close();
 store=new WalletStore(dir,network);assert.equal(store.selected().id,second.id);assert.equal(readFileSync(join(dir,'wallet.encrypted.json'),'utf8'),vault);
 const reopened=new Wallet({client:{},key:store.unlock('legacy',password),home:store.directory('legacy'),routes:{}});assert.equal(reopened.db.prepare('SELECT body FROM outgoing WHERE pid=?').get('pending-fixture').body,'{}');reopened.close();store.close();
});
test('separate wallets retain addresses, independent passwords, selection and isolated outboxes',()=>{
 const dir=home();let store=new WalletStore(dir,network);const a=store.create(password,'Personal'),b=store.create('other-qa-password','Business');
 assert.notEqual(store.get(a.id).owner,store.get(b.id).owner);assert.throws(()=>store.unlock(b.id,password));
 for(const item of [a,b]){const key=store.unlock(item.id,item===a?password:'other-qa-password'),w=new Wallet({client:{},key,home:store.directory(item.id),routes:{}});w.db.prepare('INSERT INTO outgoing(pid,body) VALUES(?,?)').run('same-id',item.id);w.close();}
 store.select(a.id);store.close();store=new WalletStore(dir,network);assert.equal(store.selected().id,a.id);
 for(const item of [a,b]){const key=store.unlock(item.id,item===a?password:'other-qa-password'),w=new Wallet({client:{},key,home:store.directory(item.id),routes:{}});assert.equal(w.db.prepare('SELECT body FROM outgoing').get().body,item.id);w.close();}store.close();
});
test('backup restore deduplicates identity without overwriting a vault or its pending outbox',()=>{
 const store=new WalletStore(home(),network),a=store.create(password,'First'),backup=store.backup(a.id),vault=readFileSync(join(store.directory(a.id),'wallet.encrypted.json'),'utf8');
 store.create(password,'Second');const restored=store.restore(backup,password,'Duplicate');assert.deepEqual(restored,{id:a.id,existing:true});assert.equal(store.list().length,2);assert.equal(store.get(a.id).name,'First');assert.equal(readFileSync(join(store.directory(a.id),'wallet.encrypted.json'),'utf8'),vault);
 const other=new WalletStore(home(),network),imported=other.restore(backup,password,'Imported');assert.equal(other.unlock(imported.id,password).publicKey,store.get(a.id).owner);other.close();store.close();
});
test('invalid backup, network, password, name and traversal leave selection and inventory intact',()=>{
 const store=new WalletStore(home(),network),a=store.create(password,'First'),backup=store.backup(a.id),before=JSON.stringify(store.list());
 for(const bad of [{...backup,network:'wrong'},{...backup,format:'SunPhi'},{...backup,vault:{}}])assert.throws(()=>store.restore(bad,password));
 assert.throws(()=>store.restore(backup,'wrong'));assert.throws(()=>store.create(password,'x'.repeat(81)));assert.throws(()=>store.directory('../outside'));assert.throws(()=>store.select('missing'));assert.equal(store.selected().id,a.id);assert.equal(JSON.stringify(store.list()),before);store.close();
});

test('first wallet receives rewards automatically; later wallets never silently replace it; multi-selection persists',()=>{
 const root=home(),dir=join(root,'wallet'),identity=prepareRewardIdentity(root,{chainId:network});let store=new WalletStore(dir,network);
 const first=store.create(password,'Household'),second=store.create(password,'Savings');
 assert.deepEqual(store.rewardWallets().filter(w=>w.rewardsSelected).map(w=>w.id),[first.id]);
 const consent=JSON.parse(store.db.prepare('SELECT body FROM reward_consents WHERE wallet=?').get(store.get(first.id).owner).body);
 assert(verify(walletConsent(identity.configHash,identity.node,consent.wallet),consent.signature,consent.wallet));
 store.setRewardWallets([first.id,second.id]);store.close();store=new WalletStore(dir,network);
 assert.equal(store.rewardWallets().filter(w=>w.rewardsSelected).length,2);store.unlock(second.id,password);assert.equal(store.rewardWallets().filter(w=>w.rewardsSelected).length,2);
 assert.throws(()=>store.setRewardWallets([]));assert.throws(()=>store.setRewardWallets([first.id,first.id]));assert.throws(()=>store.setRewardWallets(['unknown']));
 assert.equal(store.rewardWallets().filter(w=>w.rewardsSelected).length,2);store.close();
});

test('restoring a first wallet selects it for all retained node rewards without creating a new identity',()=>{
 const original=new WalletStore(home(),network),first=original.create(password,'Original'),backup=original.backup(first.id);original.close();
 const root=home(),identity=prepareRewardIdentity(root,{chainId:network}),store=new WalletStore(join(root,'wallet'),network);
 const restored=store.restore(backup,password,'Restored');assert.equal(store.rewardWallets()[0].id,restored.id);assert(store.rewardWallets()[0].rewardsSelected);assert(store.rewardWallets()[0].rewardsReady);
 assert.equal(prepareRewardIdentity(root,{chainId:network}).node,identity.node);store.close();
});

test('reward readiness verifies consent signature, node and network; reopening repairs without changing selection',()=>{
 const root=home(),dir=join(root,'wallet'),identity=prepareRewardIdentity(root,{chainId:network});const store=new WalletStore(dir,network),a=store.create(password,'First'),b=store.create(password,'Second');store.setRewardWallets([a.id,b.id]);
 const owner=store.get(a.id).owner,original=JSON.parse(store.db.prepare('SELECT body FROM reward_consents WHERE wallet=?').get(owner).body),vault=readFileSync(join(store.directory(a.id),'wallet.encrypted.json'),'utf8');
 try{assert(validRewardConsent(identity,owner,original));assert.equal(validRewardConsent({...identity,configHash:'0'.repeat(64)},owner,original),false);for(const body of ['{',JSON.stringify({...original,signature:'invalid'}),JSON.stringify({...original,node:'0'.repeat(64)}),JSON.stringify({...original,wallet:store.get(b.id).owner})]){
  store.db.prepare('UPDATE reward_consents SET body=? WHERE wallet=?').run(body,owner);assert.equal(store.rewardWallets().find(w=>w.id===a.id).rewardsReady,false);assert.equal(store.rewardWallets().filter(w=>w.rewardsSelected).length,2);assert.throws(()=>store.setRewardWallets([a.id]));
 }store.unlock(a.id,password);assert(store.rewardWallets().every(w=>w.rewardsReady));assert.equal(store.rewardWallets().filter(w=>w.rewardsSelected).length,2);assert.equal(readFileSync(join(store.directory(a.id),'wallet.encrypted.json'),'utf8'),vault);
 }finally{store.close();}
});
