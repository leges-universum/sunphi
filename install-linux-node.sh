#!/bin/bash
# Run on the Linux host that will operate the node.
set -euo pipefail
umask 022
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
version=0.3.131
archive_sha256=48ec5ef98228e9fc1338b7e7f675969b0fe2ae61fcd99f2e6ca844a7a0ae83f7
package="DueByte-Server-$version-Linux-x64"
prefix=/opt/duebyte-server
current="$prefix/current"
state=/var/lib/duebyte-server-updates
registry=/etc/duebyte-server/instances.json
service=duebyte-archive.service

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $# == 0 ]] || fail 'Usage: sudo bash install-linux-node.sh'
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
systemctl is-active --quiet "$service" || fail 'The node service did not start.'
echo 'Verifying the connection. You can close this terminal while the node synchronizes.'
"$root/runtime/node" -e '
  const fs=require("node:fs");
  const {execFileSync}=require("node:child_process");
  let previous="",staleSince=Date.now();
  function check(){
    let s;
    try { s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); } catch {}
    const fresh=s && Date.now()-s.updatedAt>=0 && Date.now()-s.updatedAt<15000;
    if(fresh && s.phase==="failed"){console.error(s.message||"Node setup stopped.");process.exit(1);}
    if(fresh && s.phase==="ready" && Number.isSafeInteger(s.height)&&s.height>0){
      console.log("Connected. Latest verified block "+s.height+".");return;
    }
    if(fresh)staleSince=Date.now();
    if(Date.now()-staleSince>60000){
      console.error("No recent node status. Check sudo journalctl -u duebyte-archive.service -n 20.");process.exit(1);
    }
    const message=fresh?s.message:"Starting the node service…";
    if(message && message!==previous){console.log(message);previous=message;}
    try{execFileSync("systemctl",["is-active","--quiet","duebyte-archive.service"]);}
    catch{console.error("Node service stopped. Check sudo journalctl -u duebyte-archive.service -n 20.");process.exit(1);}
    setTimeout(check,5000);
  }
  check();
' "$state/archive-node/server-progress.json"
