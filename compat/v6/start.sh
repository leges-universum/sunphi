#!/bin/sh
set -eu
cd "$(dirname "$0")"
exec ./runtime/node sunphi-network-next/checkpoint-trial/server-manager.mjs "$@"
