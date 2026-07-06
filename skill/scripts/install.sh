#!/usr/bin/env bash
# Install the halo CLI and link it globally.
#
# Idempotent — safe to re-run. If halo is already on PATH, does nothing.
set -euo pipefail

if command -v halo &>/dev/null; then
  echo "✓ halo already installed at $(command -v halo)"
  exit 0
fi

if ! command -v node &>/dev/null; then
  echo "✖ node not found. Install Node 20+ first: https://nodejs.org" >&2
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "✖ Node $NODE_MAJOR is too old; need 20+" >&2
  exit 1
fi

TMP="${TMPDIR:-/tmp}/halo-install"
rm -rf "$TMP"
echo "  cloning halo…"
git clone --depth 1 https://github.com/warden-protocol/run-halo.git "$TMP"

echo "  building CLI…"
# The CLI bundles two local workspace packages (@halo/vault-core, halo-sdk).
# Build them in dependency order first: each needs its own deps installed
# before its prepare/build runs, which a bare `npm install` in cli/ can't do
# (npm runs a file: dep's prepare before installing that dep's dependencies).
( cd "$TMP/vault-core" && npm install --silent && npm run build --silent )
( cd "$TMP/sdk"        && npm install --silent && npm run build --silent )
cd "$TMP/cli"
npm install --silent
npm run build --silent

echo "  linking halo globally…"
npm link --silent

echo ""
echo "✓ halo installed."
command -v halo
halo --help || true
