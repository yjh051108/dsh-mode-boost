#!/bin/bash
# Build dsh-mode-boost: verify lib/ and the bundle manifest are present, then
# pack the release tgz. The plugin is hand-written zero-dependency ESM — no
# tsc step needed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -f lib/index.js ] || [ ! -f lib/core.js ]; then
  echo "build: lib/index.js or lib/core.js missing" >&2
  exit 1
fi

# The bundle loader fails every dsh command when dsh.bundle.patch points at a
# missing manifest — fail the build instead of shipping that landmine.
node -e "const fs = require('fs'); const p = JSON.parse(fs.readFileSync('./package.json', 'utf8')); const f = p.dsh && p.dsh.bundle && p.dsh.bundle.patch; if (!f) { console.error('build: package.json dsh.bundle.patch missing'); process.exit(1) } if (!fs.existsSync(f)) { console.error('build: dsh.bundle.patch ' + f + ' does not exist'); process.exit(1) }"

node --check lib/index.js
node --check lib/core.js
echo "=== Build complete (lib + bundle manifest verified, ${PWD}) ==="
