// Preparation contract only: cannot switch an installation or authorize issuance.
import assert from 'node:assert/strict';
import {hash,hex,exact,integer} from './crypto.mjs';
import {assertCleanConfig} from './research/fresh-chain-preparation.mjs';
import {origin} from './core.mjs';
import {FIXED_BLOCK_TIMING} from './fixed-block-timing.mjs';
import {validateGenesisAuthority} from './genesis-authority.mjs';

export function validateFreshReleaseProfile(p,pin){
 hex(pin);assert.equal(hash(p),pin,'Fresh release profile pin');
 exact(p,['domain','status','authorityScope','version','previousNetwork','config','genesis','manifest','packages','roles','activation','recovery']);
 assert.equal(p.domain,'DUEBYTE_FRESH_RELEASE_PREPARATION_V1');
 assert.equal(p.status,'PREPARED_NOT_AUTHORIZED');
 assert.equal(p.authorityScope,'LABORATORY_ONLY');
 assert(/^0\.3\.[0-9]+$/.test(p.version));
 assertCleanConfig(p.config);assert(p.previousNetwork&&p.previousNetwork!==p.config.chainId,'Distinct new chain required');
 assert.equal(p.genesis.chain_id,p.config.chainId);assert.equal(hash(p.genesis.app_state),hash(p.config));
 assert.equal(p.genesis.app_hash,'');assert.equal(Date.parse(p.genesis.genesis_time),p.config.initial.time*1000);
 validateGenesisAuthority(p.genesis,p.config);
 exact(p.manifest,['domain','network','configHash','stateHash','root','height','issuance','imports','timing']);
 assert.equal(p.manifest.domain,'DUEBYTE_FRESH_GENESIS_V2');assert.equal(p.manifest.network,p.config.chainId);
 assert.equal(p.manifest.configHash,hash(p.config));assert.equal(p.manifest.stateHash,hash(origin(p.config)));hex(p.manifest.root);
 assert.equal(p.manifest.height,0);assert.equal(p.manifest.issuance,false);assert.equal(p.manifest.imports,false);
 assert.deepEqual(p.manifest.timing,FIXED_BLOCK_TIMING);
 assert(Array.isArray(p.packages)&&p.packages.length===3);
 assert.deepEqual(p.packages.map(v=>v.edition+'/'+v.platform).sort(),['home/linux-x64','home/windows-x64','server/linux-x64']);
 for(const pkg of p.packages){exact(pkg,['edition','platform','version','sha256','manifestSha256','bytes']);assert.equal(pkg.version,p.version);hex(pkg.sha256);hex(pkg.manifestSha256);integer(pkg.bytes,1);}
 assert.deepEqual(p.roles,{home:{voting:false,updates:'automatic-compatible-only'},server:{voting:'explicit-enrollment',updates:'manual'}});
 assert.deepEqual(p.activation,{authorized:false,automaticChainSwitch:false,issuance:false,importBalances:false,importHistory:false});
 assert.deepEqual(p.recovery,{newIndependentBackupRequired:true,oldBackupValidForNewChain:false});
 return p;
}

export function prepareFreshReleaseProfile({version,previousNetwork,config,genesis,manifest,packages}){
 const p=structuredClone({domain:'DUEBYTE_FRESH_RELEASE_PREPARATION_V1',status:'PREPARED_NOT_AUTHORIZED',authorityScope:'LABORATORY_ONLY',version,previousNetwork,config,genesis,manifest,packages,
  roles:{home:{voting:false,updates:'automatic-compatible-only'},server:{voting:'explicit-enrollment',updates:'manual'}},
  activation:{authorized:false,automaticChainSwitch:false,issuance:false,importBalances:false,importHistory:false},
  recovery:{newIndependentBackupRequired:true,oldBackupValidForNewChain:false}});
 return validateFreshReleaseProfile(p,hash(p));
}
