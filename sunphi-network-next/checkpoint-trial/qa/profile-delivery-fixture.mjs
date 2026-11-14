// Synthetic authority only. Never import this fixture into a runtime package.
import fs from 'node:fs';
import {join} from 'node:path';
import {fixture} from '../../research/transition-core-20261103/fixture.mjs';
import {keys,hash,sign} from '../crypto.mjs';
import {PROFILE} from '../core.mjs';
import {CHECKPOINT} from '../checkpoint.mjs';
import {Store} from '../store.mjs';
import {migrateBoundedArchive} from '../research/bounded-archive-migration.mjs';
import {prepareBoundedRootTransition} from '../research/bounded-root-transition.mjs';
export function profileDeliveryFixture(home){
 const f=fixture(),validators=Array.from({length:10},keys),members=Array.from({length:4},keys),now=Math.floor(Date.now()/1000);f.state.time=now;
 const config={profile:PROFILE,chainId:'duebyte-trial-profile-delivery',trialOnly:true,initial:f.state,control:{validators:validators.map((k,i)=>({key:k.publicKey,group:hash(i)})),policy:{version:1,members:members.map((k,i)=>({key:k.publicKey,group:hash(i)})),threshold:3,maxAge:3600,notAfter:now+86400}}};
 const genesis={chain_id:config.chainId,app_state:config,validators:validators.map(k=>({power:'10',pub_key:{type:'tendermint/PubKeyEd25519',value:Buffer.from(k.publicKey,'base64url').toString('base64')}}))};
 const policy={domain:CHECKPOINT+'/POLICY',network:config.chainId,genesisHash:hash(genesis),...config.control.policy};
 const old=new Store(join(home,'legacy.sqlite'),config),source=structuredClone(old.state);old.close();
 const migrated=migrateBoundedArchive(join(home,'legacy.sqlite'),join(home,'indexed.sqlite'),config,hash(source));
 const terms=prepareBoundedRootTransition(source,config,migrated,hash(source));migrated.close();
 const certificate={body:terms,approvals:validators.slice(0,7).map(k=>({key:k.publicKey,signature:sign(terms,k.privateKey)}))};
 const pin='ssh-ed25519 '+Buffer.concat([Buffer.from('0000000b7373682d6564323535313900000020','hex'),Buffer.alloc(32,1)]).toString('base64');
 const original={version:1,config,genesis,policy,basePort:28000,walletPort:28010,hosts:[{ip:'192.0.2.1',port:2244,user:'duebytefollower',pin,forwards:[[28100,28100],[28101,28101]]},{ip:'192.0.2.2',port:2244,user:'duebytefollower',pin,forwards:[[28110,28110],[28111,28111]]}],rpcServers:['http://127.0.0.1:28101','http://127.0.0.1:28111'],peers:[{id:'1'.repeat(40),port:28100},{id:'2'.repeat(40),port:28110}],workers:Object.fromEntries(Object.keys(config.initial.nodes).map(id=>[id,'http://127.0.0.1:28101']))};
 const fromProfileHash=hash(original),profile=structuredClone(original);profile.hosts[0].forwards.push([28105,28105]);profile.indexed={previousProfileHash:fromProfileHash,readPort:28004,url:'http://127.0.0.1:28105',source,certificate};
 return {original,body:{domain:'DUEBYTE_HOME_PROFILE_DELIVERY_V1',sequence:1,fromProfileHash,toProfileHash:hash(profile),minimumVersion:'0.3.42',issuedAt:now,expiresAt:now+3600,profile}};
}
