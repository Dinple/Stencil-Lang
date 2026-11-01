#!/usr/bin/env bash
# Run the integration suite in the Windows VS Code (for WSL machines without a
# Linux display). Uses its own user-data and extensions folders, so the normal
# VS Code setup is not touched. Results: test/integration/results.json.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/../.." && pwd)
CODE="${CODE_EXE:-/mnt/c/Users/$(cmd.exe /c 'echo %USERNAME%' 2>/dev/null | tr -d '\r')/AppData/Local/Programs/Microsoft VS Code/Code.exe}"
WT=$(cmd.exe /c "echo %TEMP%" 2>/dev/null | tr -d '\r')
BASE="$(wslpath "$WT")/stencil-vscode-it"
rm -rf "$BASE" && mkdir -p "$BASE/ext/test/integration" "$BASE/ud" "$BASE/exts"
cp -r "$HERE/package.json" "$HERE/dist" "$HERE/syntaxes" "$HERE/language-configuration.json" "$BASE/ext/"
cp "$HERE/test/integration/suite.cjs" "$BASE/ext/test/integration/"
cp -r "$HERE/test/integration/fixtures" "$BASE/fixtures"
W="$WT\\stencil-vscode-it"
cd "$BASE"
timeout 240 "$CODE" --extensionDevelopmentPath="$W\\ext" --extensionTestsPath="$W\\ext\\test\\integration\\suite.cjs" \
  --user-data-dir="$W\\ud" --extensions-dir="$W\\exts" --disable-extensions --disable-workspace-trust \
  --skip-welcome --skip-release-notes --new-window "$W\\fixtures" >/dev/null 2>&1 || true
for i in $(seq 1 60); do [ -f "$BASE/ext/test/integration/results.json" ] && break; sleep 2; done
cp "$BASE/ext/test/integration/results.json" "$HERE/test/integration/results.json"
cat "$HERE/test/integration/results.json"
