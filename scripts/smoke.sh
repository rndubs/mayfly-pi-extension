#!/usr/bin/env bash
# Load the extension in a real `pi` (RPC mode, empty config dir, no network/model needed)
# and check that /mayfly is registered from the expected file and its handler runs.
# Usage: scripts/smoke.sh <path-to-extension-entry.js> [pi-binary]
set -euo pipefail
ext="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
pi_bin="${2:-pi}"
cfg="$(mktemp -d)"
trap 'rm -rf "$cfg"' EXIT
out="$( (printf '%s\n' '{"type":"get_commands"}' '{"type":"prompt","message":"/mayfly status"}'; sleep 5) \
  | PI_CODING_AGENT_DIR="$cfg" "$pi_bin" --mode rpc --no-session --offline --no-extensions -e "$ext" 2>&1 || true)"
fail() { echo "SMOKE FAIL: $1"; echo "--- pi output ---"; echo "$out" | cut -c1-400; exit 1; }
echo "$out" | grep -q "\"name\":\"mayfly\"" || fail "/mayfly command not registered"
echo "$out" | grep -qF "\"path\":\"$ext\"" || fail "/mayfly not loaded from $ext"
echo "$out" | grep -q "Mayfly: Not watching any Mayfly channel" || fail "/mayfly status handler did not run"
if echo "$out" | grep -qi "extension_error\|failed to load\|Cannot find module"; then fail "extension load error"; fi
echo "SMOKE OK: /mayfly registered from $ext and handler ran"
