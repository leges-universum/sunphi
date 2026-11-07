#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
runtime="$here/../.local/bft-runtime"
export PATH="$runtime/go/bin:$PATH" GOPATH="$runtime/gopath" GOCACHE="$runtime/go-cache"
mkdir -p "$here/build"
# The application owns its pinned embedded-consensus module and checksums.
cd "$here/bridge"
go build -mod=readonly -buildvcs=false -o "$here/build/duebyte-abci" "$here/bridge/main.go"
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -mod=readonly -buildvcs=false -o "$here/build/duebyte-abci.exe" "$here/bridge/main.go"
sha256sum "$here/build/duebyte-abci" "$here/build/duebyte-abci.exe"
