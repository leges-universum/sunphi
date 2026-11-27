// Local operator action. Only public pairing information is persisted.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,linkSync,unlinkSync,existsSync,statSync} from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
import {join,resolve} from 'node:path';
import {hash,publicKey,hex} from './crypto.mjs';
import {checkRuleGrant} from './home-rule-route.mjs';
import {mandateId} from './ordinary-issuance-ballot.mjs';
import {reviewRuleText} from './wallet-rule-review.mjs';
import {rpc} from './client.mjs';
import {boundedHttpQuery} from './research/bounded-wallet-view.mjs';
import {verifyBoundedQuery} from './research/bounded-query.mjs';

const [cmd,home,operator,packetPath,rpcUrl,indexUrl]=process.argv.slice(2);
assert(['pair','revoke'].includes(cmd)&&home,'pair NODE_HOME HOME_PUBLIC_KEY PROPOSAL_JSON LOCAL_RPC LOCAL_INDEX | revoke NODE_HOME');
const directory=join(resolve(home),'home-governance');
let grantFile=join(directory,'operator.json');
if(cmd==='revoke'){
 if(existsSync(grantFile))unlinkSync(grantFile);
 const issueFile=join(directory,mandateId+'.grant.json');if(existsSync(issueFile))unlinkSync(issueFile);
 console.log('Home voting permission revoked.');
}else{
 publicKey(operator);
 assert(statSync(packetPath).size<=131072,'Oversize proposal');
 const read=f=>JSON.parse(readFileSync(f,'utf8')),packet=read(packetPath);
 const config=read(join(home,'app-config.json')),node=hex(read(join(home,'work-key.json')).node);
 for(const url of [rpcUrl,indexUrl]){
  const u=new URL(url);assert(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!u.username&&!u.password);
 }
 const status=await rpc(rpcUrl,'status'),height=Number(status.sync_info.latest_block_height)-1;
 assert.equal(status.node_info.network,config.chainId);
 assert(!status.sync_info.catching_up&&Math.abs(Date.now()-Date.parse(status.sync_info.latest_block_time))<120000);
 const controller=Buffer.from(status.validator_info.pub_key.value,'base64').toString('base64url');
 const root=(await rpc(rpcUrl,'block',{height:String(height+1)})).block.header.app_hash.toLowerCase();
 const req={type:'wallet-meta',id:null};
 const proof=await boundedHttpQuery(indexUrl).withLease(root,async q=>verifyBoundedQuery(await q(req,root),req,root,hash(config)));
 assert(proof.height===height&&!proof.isolatedIssuance);
 const state={...proof.data.network,money:proof.data.money},review=reviewRuleText(packet,state,config.chainId,controller);
 const issuance=review.kind==='issuance';if(issuance){assert(review.canSign);grantFile=join(directory,mandateId+'.grant.json');}
 assert(review.member&&!review.expired,'A current financial controller and open review period are required');
 const grant={network:config.chainId,configHash:hash(config),generation:state.authority.generation,node,controller,
  owner:operator,domain:packet.body.domain,expiresHeight:issuance?(existsSync(grantFile)?read(grantFile).expiresHeight:height+100800):packet.body.expiresHeight??packet.body.expires,
  proposal:review.proposal,nonce:existsSync(grantFile)?read(grantFile).nonce:randomBytes(32).toString('hex')};
 checkRuleGrant(grant,state,config.chainId,node);
 const pin=join(directory,'operator-wallet.json');
 if(existsSync(pin)){
  const enrolled=read(pin);
  assert.deepEqual(enrolled,{version:1,network:grant.network,configHash:grant.configHash,node,controller,owner:operator},
   'This installation is enrolled to another operator wallet or signing identity');
 }
 mkdirSync(directory,{recursive:true,mode:0o700});
 function save(file,data){
  const temp=join(directory,'.'+randomUUID());
  writeFileSync(temp,JSON.stringify(data)+'\n',{flag:'wx',mode:0o600,flush:true});
  try{linkSync(temp,file);}catch(e){if(e.code!=='EEXIST')throw e;assert.deepEqual(read(file),data,'Different pairing or proposal already installed');}
  finally{unlinkSync(temp);}
 }
 if(existsSync(grantFile))assert.deepEqual(read(grantFile),grant,'Revoke the prior grant before replacing it');
 save(join(directory,review.proposal+'.json'),packet);save(grantFile,grant);
 console.log(JSON.stringify({paired:true,grant,proposal:review.proposal}));
}
