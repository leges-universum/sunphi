#!/usr/bin/env bash
# Upgrade an existing .107 candidate in place, retaining the signer and history.
set -Eeuo pipefail
cd "${1:?supply verified bundle directory}"
base=/opt/duebyte-server
old=$base/releases/0.3.108
new=$base/releases/0.3.109
tools=/usr/local/lib/duebyte-connect
cli=/usr/local/bin/duebyte-connect
service=duebyte-candidate.service
unit=/etc/systemd/system/$service
state=/var/lib/duebyte-server-updates/archive-node
exec 9>/run/duebyte-connect.lock
flock -w 20 9
check() { echo "$1  $2" | sha256sum --check --status; }
check 5fd28c7bdf71c24381b1732f787be616ead8825b7daea7e05d73778d2e6eb1a5 server-overlay.tar.gz
check 7086cda42ea6ea5ab11c9f45ffa5c2458166786b81c82666b336d9f304d91fbd duebyte-connect.sh
check 6819874b29ccf3e37798a32558f034e47938ce38a2117342d57c90acee2da7c6 validator-candidate.mjs
check 9619c31e98de53f56246f5a42cbbffb1f0f5a3d3d7dfaa742570c9f6584fcc12 "$cli"
check 024baeb5c26ceb43011f15e60cd4c3a61d5abfa061da2db4b945cea35cb07803 "$tools/validator-candidate.mjs"
[[ $(readlink -f "$base/current") == "$old" && -z $(systemctl show -p DropInPaths --value "$service") ]]
verify() {
  "$old/runtime/node" --input-type=module - "$old" "$1" "$2" "$3" <<'JS'
const [old,dir,version,manifestSha256]=process.argv.slice(2);
const {verifyPackage}=await import(old+'/sunphi-network-next/checkpoint-trial/update-core.mjs');
verifyPackage(dir,{version,manifestSha256,edition:'server',platform:'linux-x64',networkPin:'15b2d004316dcab66d65eca71aa583ed9574c0a54abb335cd0ce8db139d45429'});
JS
}
verify "$old" 0.3.108 ebe18f3b273339c5bc883f1ce1423048bbd16dbde8cb67053266322341a6d8e1
if [[ ! -e $new ]]; then
  stage=$(mktemp -d "$base/releases/.candidate-109-XXXXXXXX")
  cp -a --reflink=auto "$old/." "$stage/"
  tar -xzf server-overlay.tar.gz -C "$stage"
  chmod 755 "$stage/install.sh"
  verify "$stage" 0.3.109 1f51dec3ad8981ef91309de7869890df9f74191f3a277bf0397062261f2627b5
  chmod --reference="$old" "$stage"
  mv -T "$stage" "$new"
else
  verify "$new" 0.3.109 1f51dec3ad8981ef91309de7869890df9f74191f3a277bf0397062261f2627b5
fi
systemctl is-active --quiet "$service"
if systemctl is-active --quiet duebyte-archive.service; then exit 1; fi
umask 077
backup=$(mktemp -d "$PWD/backup-XXXXXXXX")
cp -p "$tools/connect.mjs" "$backup/connect.mjs"
cp -p "$unit" "$cli" "$tools/validator-candidate.mjs" "$backup/"
priorHelper=$(awk '/^ExecStart=/{print $2}' "$unit")
check 024baeb5c26ceb43011f15e60cd4c3a61d5abfa061da2db4b945cea35cb07803 "$priorHelper"
"$old/runtime/node" "$priorHelper" status "$state" > "$backup/facts.json"
key=$("$old/runtime/node" -p 'require(process.argv[1]).validatorKey' "$backup/facts.json")
grep -Fx "ExecStart=$old/runtime/node $priorHelper run $state $key" "$unit"
sed "s|^ExecStart=.*|ExecStart=$new/runtime/node $tools/validator-candidate.mjs run $state $key|" "$unit" > "$backup/next.service"
restore() {
  trap - ERR
  set +e
  systemctl stop "$service"
  install -m 644 "$backup/connect.mjs" "$tools/connect.mjs"
  install -m 644 "$backup/$service" "$unit"
  install -m 755 "$backup/duebyte-connect" "$cli"
  install -m 644 "$backup/validator-candidate.mjs" "$tools/validator-candidate.mjs"
  systemctl daemon-reload && systemctl start "$service"
  echo "Restored previous candidate; diagnostics in $backup"
  exit 1
}
trap restore ERR
systemctl stop "$service"
install -m 644 validator-candidate.mjs "$tools/validator-candidate.mjs"
awk '/^cat > .*DUEBYTE_HELPER/ {emit=1;next} /^DUEBYTE_HELPER$/ {exit} emit' duebyte-connect.sh > "$backup/new-helper.mjs"
check 7a87fe9e66f301b414a7f78d0e986536d514f8f3ad5bbaa3fcc2dfc8f8ae0681 "$backup/new-helper.mjs"
install -m 644 "$backup/new-helper.mjs" "$tools/connect.mjs"
install -m 755 duebyte-connect.sh "$cli"
install -m 644 "$backup/next.service" "$unit"
systemctl daemon-reload
systemctl start "$service"
valid=0
for ((i=0;i<30;i++)); do
  if "$new/runtime/node" "$tools/validator-candidate.mjs" status "$state" > "$backup/after.json" 2>"$backup/status.err" &&
    "$new/runtime/node" -e 'const [a,b]=process.argv.slice(1).map(f=>require(f));process.exit(b.version==="0.3.109" && b.height>a.height && b.peerId===a.peerId && b.validatorKey===a.validatorKey && b.agreeingEndpoints>=2 ? 0 : 1)' "$backup/facts.json" "$backup/after.json"; then valid=1; break; fi
  sleep 3
done
[[ $valid == 1 ]]
[[ $(readlink -f "/proc/$(systemctl show -p MainPID --value "$service")/exe") == "$new/runtime/node" ]]
ln -s "$new" "$base/.candidate-109-$$"
mv -Tf "$base/.candidate-109-$$" "$base/current"
trap - ERR
cat "$backup/after.json"
echo "Verified candidate upgrade"
