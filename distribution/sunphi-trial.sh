#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
export O1JS_BACKEND=native SUNPHI_PROVER_WORKERS=1 RAYON_NUM_THREADS=1
exec ./runtime/node tools/trial-client.mjs "$@"
