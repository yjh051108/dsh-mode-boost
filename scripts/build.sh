#!/bin/bash
# Build dsh-mode-boost: verify lib/ is present and pack the release tgz.
# The plugin is hand-written zero-dependency ESM — no tsc step needed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -f lib/index.js ] || [ ! -f lib/core.js ]; then
  echo "build: lib/index.js or lib/core.js missing" >&2
  exit 1
fi

node --check lib/index.js
node --check lib/core.js
echo "=== Build complete (lib verified, ${PWD}) ==="
