#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
release=/opt/duebyte-server/releases/0.3.109
state=/var/lib/duebyte-server-updates/archive-node
tools=/usr/local/lib/duebyte-connect
command_name=${1:-install}
case "$command_name" in
  install|status|join|wallet|apply-wallet|register-rewards) ;;
  *) echo 'Usage: duebyte-connect [install | status | join | wallet]'; exit 2 ;;
esac
[[ $(id -u) == 0 ]] || { echo 'Run this program with sudo on your Linux server.'; exit 1; }
[[ $(uname -sm) == 'Linux x86_64' && -d /run/systemd/system ]] || { echo 'This installer requires Linux x86_64 with systemd.'; exit 1; }
for cmd in flock curl sha256sum systemctl tar; do command -v "$cmd" >/dev/null || { echo "Install $cmd and run again."; exit 1; }; done
exec 9>/run/duebyte-connect.lock
flock -n 9 || { echo 'Another DueByte setup is running. Try again when it finishes.'; exit 1; }
assistant() { "$release/runtime/node" "$tools/connect.mjs" "$@"; }
identity() { "$release/runtime/node" "$tools/validator-candidate.mjs" status "$state"; }
observe() {
  local facts
  if ! facts=$(identity 2>/dev/null); then
    echo 'Waiting for a recent block that agrees with the network.'
    if [[ -f $state/server-progress.json ]]; then
      "$release/runtime/node" -e 'const p=require(process.argv[1]); console.log("Setup:",p.phase,"   Verified history:",p.bootstrap?.verifiedThrough??p.height??0); if(p.phase==="failed")process.exit(2)' "$state/server-progress.json" || return 2
    fi
    return 1
  fi
  assistant status "$facts"
}
if [[ $command_name != install ]]; then
  case "$command_name" in
    status) observe ;;
    join) facts=$(identity); assistant join "$facts" ;;
    wallet) assistant wallet "${2:-}"; if [[ -s $state/receive-only.json ]]; then systemctl enable --now duebyte-connect-wallet.timer >/dev/null; assistant apply-wallet; elif [[ -s $state/requested-recipient.json ]]; then assistant register-rewards; fi ;;
    register-rewards) assistant register-rewards ;;
    apply-wallet) assistant apply-wallet ;;
  esac
  exit
fi
root=https://github.com/leges-universum/sunphi/releases/download/duebyte-v0.3.109
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
fetch() {
  curl --fail --silent --show-error --location --retry 3 --proto '=https' --proto-redir '=https' "$root/$1" -o "$tmp/$1"
  (cd "$tmp"; echo "$2  $1" | sha256sum -c --status) || { echo "Verification failed for $1"; exit 1; }
}
if [[ -L /opt/duebyte-server/current || -e /opt/duebyte-server/current ]]; then
  [[ $(readlink -f /opt/duebyte-server/current) == "$release" ]] || { echo 'Another Server release is installed. Use its supported upgrade route.'; exit 1; }
elif [[ -e $release || -e /usr/local/bin/duebyte-server || -e /etc/duebyte-server/instances.json ]]; then
  echo 'An existing or incomplete installation needs review before setup can continue.'; exit 1
else
  echo 'Downloading and checking DueByte Server for Linux…'
  name=DueByte-Server-0.3.109-Linux-x64.tar.gz
  fetch "$name" ac1b9606c318531daba1261c7f9830dabf072d57d575e3974664ff4befcce7f7
  tar -xzf "$tmp/$name" -C "$tmp"
  # The packaged installer creates shared program directories and a service user.
  # Its configuration and key directories have their own restrictive permissions.
  (umask 022; sh "$tmp/${name%.tar.gz}/install.sh")
fi
fetch validator-candidate.mjs 6819874b29ccf3e37798a32558f034e47938ce38a2117342d57c90acee2da7c6
install -d -m 755 "$tools"
install -m 644 "$tmp/validator-candidate.mjs" "$tools/validator-candidate.mjs"
cat > "$tmp/connect.mjs" <<'DUEBYTE_HELPER'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline/promises';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';

const kit=path.resolve(path.dirname(fs.realpathSync(process.execPath)),'../sunphi-network-next/checkpoint-trial');
const mod=name=>import(pathToFileURL(path.join(kit,name+'.mjs')));
const {hash,digest,publicKey,sign,verify}=await mod('crypto');
const {walletConsent,REWARDS}=await mod('node-rewards');
const {envelope}=await mod('core');
const {consumerNodeHome}=await mod('consumer-home');
const {paymentWorkerId}=await mod('research/bounded-worker-preparation');
const {boundedHttpQuery}=await mod('research/bounded-wallet-view');
const {verifyBoundedQuery}=await mod('research/bounded-query');
const {rpc}=await mod('client');
const folder='/var/lib/duebyte-server-updates/archive-node',home=consumerNodeHome(folder);
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const cfg=read(path.join(home,'app-config.json')),configHash=hash(cfg);
assert.equal(configHash,'5a6af5048049049bee003078f845ccea883140f291897f950007c5ba113a807c','Unexpected network configuration');
const identity=read(path.join(folder,'reward-identity.json'));
assert.equal(identity.configHash,configHash,'Reward identity belongs to another network');
assert.equal(identity.network,cfg.chainId);
const key=identity.work,node=paymentWorkerId(configHash,key.publicKey);
const rpcUrl='http://127.0.0.1:28001',query=boundedHttpQuery('http://127.0.0.1:28005');
const pending=path.join(folder,'receive-only.json'),confirmed=path.join(folder,'receive-only-confirmed.json');
const recipientFile=path.join(folder,'requested-recipient.json');
function save(file,data){
  const tmp=file+'.'+process.pid+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(data),{flag:'wx',mode:0o600,flush:true});
  try{fs.linkSync(tmp,file);}finally{fs.unlinkSync(tmp);}
}
async function observe(request={type:'reward-account',id:node}){
  const info=await rpc(rpcUrl,'status');
  assert.equal(info.node_info.network,cfg.chainId);
  assert(!info.sync_info.catching_up&&Math.abs(Date.now()-Date.parse(info.sync_info.latest_block_time))<120000,'Waiting for synchronization');
  const {block}=await rpc(rpcUrl,'block',{height:info.sync_info.latest_block_height});
  const height=Number(block.header.height)-1,root=block.header.app_hash.toLowerCase();
  return query.withLease(root,async q=>{
    const record=verifyBoundedQuery(await q(request,root),request,root,configHash);
    assert.equal(record.height,height);assert(!record.isolatedIssuance);
    return {height,account:record.data};
  });
}
async function registerSeat(facts){
  assert.equal(facts.network,cfg.chainId);assert(facts.agreeingEndpoints>=2);
  const {account:metadata,height}=await observe({type:'wallet-meta',id:null});
  const seat=metadata.network.authority?.rotatingSeat;
  if(!seat){console.log('Block voting: waiting for the network to open the free seat.');return;}
  let rules;
  try{rules=await mod('rotating-seat');}catch(error){
    if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;
    throw Error('Update the Server release to the signed version supporting rotating seats before registering.');
  }
  assert.equal(hash(seat.policy),seat.id);assert.equal(seat.policy.network,cfg.chainId);
  assert.equal(seat.policy.configHash,configHash);
  const voter=facts.validatorKey,worker=key.publicKey;
  publicKey(voter);
  const position=seat.queue.findIndex(entry=>entry.key===voter);
  if(seat.holder===voter||position>=0){
    console.log(seat.holder===voter?'Selected for the block seat. Check status for a committed signature.':'Free block seat: queue position '+(position+1));return;
  }
  const {start,period,rounds}=seat.policy,epoch=Math.floor((height-start)/period);
  if(epoch<0 || epoch>=rounds-1 || seat.queue.length>=32){
    console.log('Free block seat: waiting for an open registration window.');return;
  }
  // This dedicated file is read only inside the node. Sign this fixed domain only.
  const localSigner=read(path.join(home,'config','priv_validator_key.json'));
  assert.equal(localSigner.priv_key.type,'tendermint/PrivKeyEd25519');
  const raw=Buffer.from(localSigner.priv_key.value,'base64');
  assert.equal(raw.length,64);assert.equal(raw.subarray(32).toString('base64url'),voter);
  const secret=Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),raw.subarray(0,32)]);
  const body=rules.possessionBody(seat.id,epoch,voter,worker);
  const possession=sign(body,secret.toString('base64url'));raw.fill(0);secret.fill(0);
  assert(verify(body,possession,voter),'Local consensus key mismatch');
  const registration=envelope(cfg,{type:'JOIN_ROTATING_SEAT_V1',policy:seat.id,epoch,voter,possession},key);
  const tx=Buffer.from(JSON.stringify(registration));
  const result=await rpc(rpcUrl,'broadcast_tx_sync',{tx:tx.toString('base64')});
  assert(Number(result.code??0)===0||/already exists in cache/i.test(result.log??''),'Registration declined: '+result.log);
  console.log('Submitted free block-seat registration. Waiting for confirmation.',digest(tx).toUpperCase());
}
function decode(token){
  assert(/^[A-Za-z0-9_-]{1,1400}$/.test(token),'Paste the signed reward code from your home computer');
  const receipt=JSON.parse(Buffer.from(token,'base64url'));
  const expected=walletConsent(configHash,node,receipt.body?.wallet);
  publicKey(expected.wallet);assert.deepEqual(receipt.body,expected,'This permission belongs to another node or network');
  assert(verify(expected,receipt.signature,expected.wallet),'Invalid wallet signature');
  return receipt;
}
const describe=acc=>acc?.payouts?.length?acc.payouts.map(p=>p.wallet).join(', '):'No confirmed reward wallet';
async function submit(action){
  const wire=Buffer.from(JSON.stringify(envelope(cfg,action,key)));
  const result=await rpc(rpcUrl,'broadcast_tx_sync',{tx:wire.toString('base64')});
  assert(Number(result.code??0)===0||/already exists in cache/i.test(result.log??''),'Registration declined: '+result.log);
  console.log('Submitted for network confirmation:',digest(wire).toUpperCase());
}
async function registerRewards(){
  const {account,height}=await observe();
  if(!account){
    const {account:head}=await observe({type:'server-enrollment',id:null});
    if(!head||height<head.policy.notBefore||height>=head.policy.expires||head.count>=head.policy.limit){
      console.log('Awaiting the next public server registration window.');return;
    }
    assert.equal(head.id,hash(head.policy));assert.equal(head.policy.configHash,configHash);
    assert.equal(head.policy.network,cfg.chainId);
    await submit({type:'REGISTER_SERVER_REWARD_ACCOUNT_V1',window:head.id});return;
  }
  if(!fs.existsSync(recipientFile))return;
  const {wallet}=read(recipientFile);publicKey(wallet);
  if(account.payouts.length){
    assert.deepEqual(account.payouts,[{wallet,weight:1}],'The confirmed recipient differs from the requested wallet.');
    console.log('Recipient confirmed at block',height,wallet);return;
  }
  assert.equal(account.management,key.publicKey,'A separate management key controls this account.');
  const {account:offer}=await observe({type:'server-recipient',id:node});
  const sequence=account.sequence+1;
  if(offer?.wallet===wallet&&offer.sequence===sequence&&offer.management===key.publicKey){
    console.log('Invitation confirmed. Open DueByte Home → Receive DUBYT → Server rewards. Node ID:',node);return;
  }
  const body={domain:REWARDS+'/BIND',configHash,node,sequence,payouts:[{wallet,weight:1}]};
  await submit({type:'NOMINATE_SERVER_REWARD_RECIPIENT_V1',node,wallet,sequence,previous:offer?hash(offer):null,signature:sign(body,key.privateKey)});
}
function requestWallet(address){
  publicKey(address);
  if(fs.existsSync(pending))assert.equal(read(pending).body.wallet,address,'A different signed permission is pending.');
  if(fs.existsSync(recipientFile))assert.deepEqual(read(recipientFile),{wallet:address},'Another recipient is already requested.');
  else save(recipientFile,{wallet:address});
  console.log('Recipient saved:',address,'\nIn DueByte Home open Receive DUBYT → Server rewards. Reward node ID:',node);
}
async function wallet(){
  assert(process.stdin.isTTY,'Open an interactive terminal to connect a wallet');
  const {account}=await observe();
  console.log('Reward node ID:',node);
  if(account?.payouts?.length){console.log('Confirmed reward wallet:',describe(account));return;}
  if(fs.existsSync(pending)){console.log('Saved signed permission for',read(pending).body.wallet);return;}
  console.log('Enter the public wallet address from DueByte Home. You can also paste a previously signed permission.');
  const io=createInterface({input:process.stdin,output:process.stdout});
  try{
    const token=(await io.question('Wallet address or signed permission (Enter to skip): ')).trim();if(!token)return;
    if(token.length===43){requestWallet(token);return;}
    const receipt=decode(token);
    if(fs.existsSync(recipientFile))assert.equal(receipt.body.wallet,read(recipientFile).wallet,'This is not the requested wallet.');
    console.log('Send this node’s future rewards to',receipt.body.wallet);
    if(!/^y(es)?$/i.test((await io.question('Save this recipient? [y/N] ')).trim()))return;
    save(pending,receipt);
  }finally{io.close();}
}
async function applyWallet(){
  if(!fs.existsSync(pending))return;
  const receipt=decode(Buffer.from(JSON.stringify(read(pending))).toString('base64url'));
  const {account,height}=await observe();
  if(!account){console.log('Wallet approval saved. Waiting for the network to register this reward node.');return;}
  assert.equal(account.management,key.publicKey,'Reward node management differs');
  const payouts=[{wallet:receipt.body.wallet,weight:1}];
  if(account.payouts.length){
    assert.deepEqual(account.payouts,payouts,'A different payout selection is already registered; review it in Home');
    if(!fs.existsSync(confirmed))save(confirmed,{node,payouts,height});
    fs.unlinkSync(pending);
    execFileSync('systemctl',['disable','--now','duebyte-connect-wallet.timer'],{stdio:'ignore'});
    console.log('Reward wallet confirmed at block',height,receipt.body.wallet);return;
  }
  const body={domain:REWARDS+'/BIND',configHash,node,sequence:account.sequence+1,payouts};
  const tx=envelope(cfg,{type:'BIND_REWARD_WALLETS_V1',body,signature:sign(body,key.privateKey),consents:[receipt.signature]},key);
  const bytes=Buffer.from(JSON.stringify(tx)),result=await rpc(rpcUrl,'broadcast_tx_sync',{tx:bytes.toString('base64')});
  assert(Number(result.code??0)===0||/already exists in cache/i.test(result.log??''),'Network declined the reward link: '+result.log);
  console.log('Submitted wallet permission. Awaiting confirmation.',digest(bytes).toUpperCase());
}
try{
  const mode=process.argv[2];
  if(mode==='wallet'){if(process.argv[3])requestWallet(process.argv[3]);else await wallet();}
  else if(mode==='register-rewards')await registerRewards();
  else if(mode==='join'){try{await registerSeat(JSON.parse(process.argv[3]));}finally{await registerRewards();}}
  else if(mode==='apply-wallet')await applyWallet();
  else if(mode==='status'){
    const s=JSON.parse(process.argv[3]);assert.equal(s.network,cfg.chainId);
    console.log('Connected to DueByte at block',s.height,'· agreeing endpoints:',s.agreeingEndpoints);
    console.log('Validator address:',s.validatorAddress);
    if(Number(s.votingPower)===0)console.log('Block voting: awaiting admission (voting power 0).');
    else{
      const {signed_header:{commit}}=await rpc(rpcUrl,'commit',{height:String(s.height)});
      const signed=commit.signatures.some(v=>v.validator_address===s.validatorAddress&&v.block_id_flag===2&&v.signature);
      console.log('Block voting power:',s.votingPower,signed?'· signature confirmed in block '+s.height:'· no signature in this block');
    }
    console.log('Reward node:',node);
    try{console.log('Rewards:',describe((await observe()).account));}
    catch{console.log('Reward status could not be verified. Run sudo duebyte-connect status again.');}
    if(fs.existsSync(pending))console.log('Saved wallet permission:',read(pending).body.wallet,'· awaiting network confirmation');
    if(fs.existsSync(recipientFile)&&!fs.existsSync(confirmed))console.log('Requested recipient:',read(recipientFile).wallet,'· check the confirmed Rewards status above.');
  }else throw Error('Unknown operation');
}catch(e){console.error(e.message);process.exitCode=1;}

DUEBYTE_HELPER
install -m 644 "$tmp/connect.mjs" "$tools/connect.mjs"
if ! [[ "$0" -ef /usr/local/bin/duebyte-connect ]]; then install -m 755 "$0" /usr/local/bin/duebyte-connect; fi
unit=/etc/systemd/system
cat > "$tmp/duebyte-connect-wallet.service" <<'UNIT'
[Unit]
Description=Confirm signed DueByte reward recipient
ConditionPathExists=/var/lib/duebyte-server-updates/archive-node/receive-only.json
[Service]
Type=oneshot
ExecStart=/usr/local/bin/duebyte-connect apply-wallet
NoNewPrivileges=yes
UMask=0077
UNIT
cat > "$tmp/duebyte-connect-wallet.timer" <<'UNIT'
[Unit]
Description=Retry a pending DueByte reward recipient
[Timer]
OnActiveSec=2min
OnUnitInactiveSec=15min
[Install]
WantedBy=timers.target
UNIT
for file in duebyte-connect-wallet.{service,timer}; do
  if [[ -e $unit/$file ]]; then cmp -s "$tmp/$file" "$unit/$file" || { echo "Existing $file has local changes."; exit 1; }; else install -m 644 "$tmp/$file" "$unit/$file"; fi
done
systemctl daemon-reload
if ! systemctl is-active --quiet duebyte-candidate.service; then
  if systemctl cat duebyte-candidate.service >/dev/null 2>&1; then
    if ! cmp -s "$tools/managed-candidate.service" "$unit/duebyte-candidate.service" ||
       [[ -n $(systemctl show -p DropInPaths --value duebyte-candidate.service) ]]; then
      echo 'An existing candidate service is stopped. Check it before starting another signer.'; exit 1
    fi
    # Resume an interrupted handover using the original archive and its keys.
    systemctl disable --now duebyte-candidate.service
    systemctl enable --now duebyte-archive.service
  else
    "$release/duebyte-server" initialize
  fi
fi
echo 'Checking the connection. Initial synchronization can take time. You can run this installer again to resume.'
until facts=$(identity 2>/dev/null); do
  if [[ -f $state/server-progress.json ]]; then
    "$release/runtime/node" -e 'const p=require(process.argv[1]); console.log("Setup:",p.phase,"   Verified history:",p.bootstrap?.verifiedThrough??p.height??0); if(p.phase==="failed")process.exit(2)' "$state/server-progress.json"
  fi
  sleep 15
done
assistant status "$facts"
if ! systemctl is-active --quiet duebyte-candidate.service; then
  key=$("$release/runtime/node" -e 'const key=JSON.parse(process.argv[1]).validatorKey;if(!/^[A-Za-z0-9_-]{43}$/.test(key))process.exit(1);console.log(key)' "$facts")
  cat > "$tmp/duebyte-candidate.service" <<UNIT
[Unit]
Description=DueByte validator candidate
After=network-online.target
Wants=network-online.target
Conflicts=duebyte-archive.service
[Service]
ExecStart=$release/runtime/node $tools/validator-candidate.mjs run $state $key
Restart=on-failure
RestartSec=10
KillMode=control-group
TimeoutStopSec=45
UMask=0077
NoNewPrivileges=yes
[Install]
WantedBy=multi-user.target
UNIT
  install -m 644 "$tmp/duebyte-candidate.service" "$tools/managed-candidate.service"
  install -m 644 "$tmp/duebyte-candidate.service" "$unit/duebyte-candidate.service"
  systemctl daemon-reload
  systemctl disable --now duebyte-archive.service
  ok=0
  if systemctl enable --now duebyte-candidate.service; then
    for ((i=0;i<60;i++)); do
      if next=$(identity 2>/dev/null) && "$release/runtime/node" -e 'const [a,b]=process.argv.slice(1).map(JSON.parse);process.exit(a.validatorKey===b.validatorKey && a.peerId===b.peerId && b.height>a.height?0:1)' "$facts" "$next"; then ok=1; break; fi
      sleep 3
    done
  fi
  if (( !ok )); then
    systemctl disable --now duebyte-candidate.service; systemctl enable --now duebyte-archive.service
    echo 'Archive service restored. Candidate handover could not be verified.'; exit 1
  fi
  assistant status "$next"
fi
cat > "$tmp/duebyte-connect-seat.service" <<'UNIT'
[Unit]
Description=Register this DueByte node for the free rotating block seat
After=duebyte-candidate.service
[Service]
Type=oneshot
ExecStart=/usr/local/bin/duebyte-connect join
NoNewPrivileges=yes
UMask=0077
UNIT
cat > "$tmp/duebyte-connect-seat.timer" <<'UNIT'
[Unit]
Description=Retry open block-seat registration for this candidate
[Timer]
OnActiveSec=30s
OnUnitInactiveSec=2min
RandomizedDelaySec=15s
[Install]
WantedBy=timers.target
UNIT
for file in duebyte-connect-seat.{service,timer}; do
  if [[ -e $unit/$file ]]; then cmp -s "$tmp/$file" "$unit/$file" || { echo "Existing $file has local changes."; exit 1; }; else install -m 644 "$tmp/$file" "$unit/$file"; fi
done
systemctl daemon-reload
systemctl enable --now duebyte-connect-seat.timer
echo 'Your node is connected. Free block-seat registration is automatic. Check with: sudo duebyte-connect status'
if [[ -t 0 ]] && read -r -p 'Connect your home wallet for rewards? [y/N] ' choice && [[ $choice == [Yy] ]]; then
  flock -u 9
  /usr/local/bin/duebyte-connect wallet
else
  echo 'You can connect a wallet later with: sudo duebyte-connect wallet'
fi
