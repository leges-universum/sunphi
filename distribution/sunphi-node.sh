#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo 'This package requires Linux x86_64 (Ubuntu 22.04+ recommended).' >&2; exit 1
fi
exec "$task_root/runtime/node" "$task_root/distribution/node.mjs" "$@"
