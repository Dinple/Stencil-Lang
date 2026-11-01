#!/usr/bin/env bash
# Rebuild ../codemirror.js from pinned packages (needs Node + npm; users of the
# playground do not).
set -euo pipefail
cd "$(dirname "$0")"
npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund
npx esbuild entry.js --bundle --format=esm --minify --legal-comments=eof --outfile=../codemirror.js
echo "wrote $(cd .. && pwd)/codemirror.js ($(wc -c < ../codemirror.js) bytes)"
