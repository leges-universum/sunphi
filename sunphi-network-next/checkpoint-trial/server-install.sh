#!/bin/sh
set -eu
test "$(id -u)" = 0 || { echo 'Run sudo sh install.sh'; exit 1; }
cd "$(dirname "$0")"
version=$(./runtime/node -p "JSON.parse(require('fs').readFileSync('release-config.json')).version")
case "$version" in 0.3.18|0.3.19|0.3.20|0.3.21|0.3.22|0.3.23|0.3.24|0.3.25|0.3.26|0.3.27|0.3.28) ;; *) echo 'Unsupported server release'; exit 1;; esac
dest="/opt/duebyte-server/releases/$version"
test ! -e "$dest" || { echo "Already exists: $dest. Nothing overwritten."; exit 1; }
./runtime/node --version
command -v systemctl >/dev/null
mkdir -p "$dest"
cp -R . "$dest/"
chown -R root:root "$dest"
chmod -R go-w "$dest"
chmod 755 "$dest" "$dest/runtime/node" "$dest/duebyte-server" "$dest/start.sh" "$dest/install.sh" "$dest/sunphi-network-next/checkpoint-trial/build/duebyte-abci" "$dest/sunphi-network-next/.local/bft-runtime/bin/cometbft"
test ! -e /opt/duebyte-server/current || { echo 'Existing current release retained. Use its explicit update command.'; exit 1; }
ln -s "$dest" /opt/duebyte-server/current
test ! -e /usr/local/bin/duebyte-server || { echo 'Existing command retained.'; exit 1; }
ln -s /opt/duebyte-server/current/duebyte-server /usr/local/bin/duebyte-server
id duebyteupdates >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin duebyteupdates
install -d -m 755 -o root -g root /var/lib/duebyte-server-updates
install -d -m 700 -o duebyteupdates -g duebyteupdates /var/lib/duebyte-server-updates/check
install -d -m 700 -o root -g root /etc/duebyte-server
test ! -e /etc/systemd/system/duebyte-update-check.service
cat > /etc/systemd/system/duebyte-update-check.service <<'UNIT'
[Unit]
Description=DueByte signed release notice (never installs)
After=network-online.target
[Service]
Type=oneshot
User=duebyteupdates
Group=duebyteupdates
Environment=DUEBYTE_SERVER_STATE=/var/lib/duebyte-server-updates/check
ExecStart=/opt/duebyte-server/current/duebyte-server check
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/duebyte-server-updates/check
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
TimeoutStartSec=120
UMask=0077
UNIT
cat > /etc/systemd/system/duebyte-update-check.timer <<'UNIT'
[Unit]
Description=Check DueByte releases every six hours
[Timer]
OnBootSec=5min
OnUnitActiveSec=6h
RandomizedDelaySec=15min
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now duebyte-update-check.timer
echo 'Server software installed. Existing node services and data are unchanged.'
echo 'Read SERVER-GUIDE.txt. sudo duebyte-server status; sudo journalctl -u duebyte-update-check'
