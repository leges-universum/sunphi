#!/bin/bash
# Run on the Linux host that will operate the node.
set -euo pipefail
umask 022
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
version=0.3.145
archive_sha256=e0e5b14e35060bf949b1e2b9ef098a509daed3e89db63e3932b0d630fc198eeb
package="DueByte-Server-$version-Linux-x64"
prefix=/opt/duebyte-server
current="$prefix/current"
state=/var/lib/duebyte-server-updates
registry=/etc/duebyte-server/instances.json
service=duebyte-archive.service

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $# == 0 || ( $# == 2 && $1 == --wallet ) ]] || fail 'Usage: sudo bash install-linux-node.sh [--wallet HOME_RECEIVING_ADDRESS]'
wallet=${2:-}
if [[ $# == 2 ]]; then
  [[ $wallet =~ ^[A-Za-z0-9_-]{43}$ ]] || fail 'Copy your DueByte receiving address from Home.'
fi
[[ $EUID == 0 ]] || fail 'Run sudo bash install-linux-node.sh.'
[[ $(uname -sm) == 'Linux x86_64' && -d /run/systemd/system ]] ||
  fail 'This installer requires 64-bit x86 Linux with systemd.'
for tool in curl tar sha256sum flock ssh ssh-keygen systemctl; do
  command -v "$tool" >/dev/null || fail "Missing Linux command: $tool"
done
exec 9>/run/duebyte-linux-setup.lock
flock -n 9 || fail 'An installation is already in progress.'

# Existing validator services can have their own data directory and signing key.
# Only resume the archive service created by the packaged initializer.
if systemctl is-active --quiet duebyte-candidate.service; then
  [[ -z $wallet ]] || fail 'This validator candidate already exists. Check its wallet in My nodes.'
  echo 'Your DueByte candidate service is already running.'
  exit 0
fi
if systemctl cat duebyte-candidate.service >/dev/null 2>&1; then
  fail 'This host has a stopped validator candidate. Its existing service needs recovery.'
fi
if [[ ! -e $current ]]; then
  for old in "$current" "$prefix/releases/$version" "$registry" "$state/archive-node" /usr/local/bin/duebyte-server; do
    [[ ! -e $old && ! -L $old ]] || fail "Existing installation needs recovery: $old"
  done
  temp=$(mktemp -d)
  trap 'rm -rf -- "$temp"' EXIT
  archive="$package.tar.gz"
  echo "Installing DueByte Server $version…"
  curl --fail --location --silent --show-error --retry 3 --connect-timeout 15 \
    --proto '=https' --proto-redir '=https' \
    "https://github.com/leges-universum/sunphi/releases/download/duebyte-v$version/$archive" -o "$temp/$archive"
  (cd "$temp" && printf '%s  %s\n' "$archive_sha256" "$archive" | sha256sum --check --status) ||
    fail 'The release download failed verification.'
  tar -xzf "$temp/$archive" -C "$temp"
  if ! (cd "$temp/$package" && sh ./install.sh) >"$temp/package-install.log" 2>&1; then
    tail -n 8 "$temp/package-install.log" >&2
    fail 'Server installation stopped.'
  fi
  rm -rf -- "$temp"
  trap - EXIT
fi
root=$(readlink -f "$current")
[[ $root =~ ^/opt/duebyte-server/releases/[0-9]+\.[0-9]+\.[0-9]+$ && -x $root/duebyte-server ]] ||
  fail 'The installed release could not be identified.'
if [[ -e $registry ]]; then
  "$root/runtime/node" -e '
    const rows=JSON.parse(require("fs").readFileSync(process.argv[1])).instances;
    if (!Array.isArray(rows)) process.exit(1);
    if (rows.some(r=>r.role!=="archive" || r.unit!=="duebyte-archive.service")) {
      console.error("This host already has managed DueByte services. Check My nodes for their status.");
      process.exit(1);
    }
  ' "$registry"
fi
if ! systemctl is-active --quiet "$service"; then
  echo 'Starting your node…'
  "$root/duebyte-server" initialize >/dev/null
fi
if [[ -n $wallet ]]; then
  "$root/duebyte-server" link-wallet "$wallet" || fail 'Wallet linking could not be prepared with the installed Server release.'
fi
echo 'Verifying the connection. You can close this terminal while the node synchronizes.'
"$root/runtime/node" -e '
  const fs=require("node:fs");
  const {execFileSync}=require("node:child_process");
  const service="duebyte-archive.service";
  const diagnose=reason=>{
    console.error(reason+" Check sudo journalctl -u "+service+" -n 30.");
    process.exit(1);
  };
  let previous="",invocation="",seenAt=Date.now(),lastReport=Date.now();
  const restarts=[];
  function check(){
    const now=Date.now();
    let unit;
    try{
      const properties=execFileSync("systemctl",["show",service,"-p","ActiveState","-p","InvocationID","-p","SubState"],{encoding:"utf8",timeout:5000});
      unit=Object.fromEntries(properties.trim().split("\n").map(line=>line.split("=")));
    }catch{diagnose("Could not read the node service state.");}
    if(unit.ActiveState==="failed" || unit.ActiveState==="inactive")diagnose("The node service stopped.");
    if(unit.InvocationID && unit.InvocationID!==invocation){
      if(invocation)restarts.push(now);
      while(restarts.length && now-restarts[0]>180000)restarts.shift();
      if(restarts.length>=5)diagnose("The node service repeatedly stopped during startup.");
      invocation=unit.InvocationID;
      seenAt=now;
    }
    let s;
    try { s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); } catch {}
    const running=unit.ActiveState==="active" && unit.SubState==="running";
    const fresh=running && s && s.updatedAt>=seenAt && now>=s.updatedAt && now-s.updatedAt<15000;
    if(fresh && s.phase==="ready" && Number.isSafeInteger(s.height)&&s.height>0){
      console.log("Connected. Latest verified block "+s.height+".");
      if(s.invitation){
        console.log(s.invitation.status);
        if(s.invitation.node)console.log("Server ID for Home: "+s.invitation.node);
      }
      return;
    }
    if(fresh && s.phase!=="failed")lastReport=now;
    if(now-lastReport>120000)diagnose("No recent progress from the node service.");
    let message="Starting the node service…";
    if(unit.SubState==="auto-restart" || (fresh && s.phase==="failed"))message="The node service is recovering. Waiting for it to reconnect…";
    else if(fresh){
      message=s.message;
      const height=s.bootstrap?.verifiedThrough;
      if(Number.isSafeInteger(height) && height>0)message="Verifying network history. Block "+height+".";
    }
    if(message && message!==previous){console.log(message);previous=message;}
    setTimeout(check,5000);
  }
  check();
' "$state/archive-node/server-progress.json"
