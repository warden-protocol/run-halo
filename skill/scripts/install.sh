#!/usr/bin/env bash
# Install or update the managed halo CLI checkout and link it globally.
set -euo pipefail

REMOTE="https://github.com/warden-protocol/run-halo.git"
HALO_HOME="${HOME}/.halo"
SRC="${HALO_HOME}/src"
SENTINEL="${SRC}/.halo-managed"

if ! command -v node &>/dev/null; then
  echo "✖ node not found. Install Node 20+ first: https://nodejs.org" >&2
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "✖ Node $NODE_MAJOR is too old; need 20+" >&2
  exit 1
fi

if command -v halo &>/dev/null; then
  HALO_BIN=$(command -v halo)
  HALO_REAL=$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$HALO_BIN" 2>/dev/null || true)
  case "$HALO_REAL" in
    "$SRC"/*)
      if [[ -f "$SENTINEL" ]]; then
        echo "  checking managed halo install for updates..."
        halo update
        exit 0
      fi
      ;;
  esac
  # The pre-auto-update installer linked from $TMPDIR/halo-install. Recognize
  # that exact legacy shape (including a now-dangling npm link) and migrate it;
  # arbitrary npm-linked development checkouts remain strictly off-limits.
  GLOBAL_LINK="$(npm root -g 2>/dev/null)/halo-cli"
  GLOBAL_TARGET=$(readlink "$GLOBAL_LINK" 2>/dev/null || true)
  RESOLVED="${HALO_REAL:-$GLOBAL_TARGET}"
  case "$RESOLVED" in
    */halo-install/cli/*|*/halo-install/cli)
      echo "  migrating legacy temporary halo install to $SRC..."
      ;;
    "")
      # Neither realpath nor the npm global-link probe could resolve a target
      # (dangling symlink, restricted/sandboxed filesystem). Say so plainly
      # rather than printing an "unmanaged checkout" line with a blank target.
      echo "halo is already on your PATH at $HALO_BIN, but its install location could not be resolved" >&2
      echo "  (dangling symlink, restricted filesystem, or sandboxed runner)." >&2
      echo "leaving it untouched; remove that halo from your PATH before installing a managed copy." >&2
      exit 0
      ;;
    *)
      echo "halo already resolves to an unmanaged checkout:" >&2
      echo "  $HALO_BIN → $RESOLVED" >&2
      echo "leaving it untouched; remove that npm link before installing a managed copy." >&2
      exit 0
      ;;
  esac
fi

if [[ -f "$SENTINEL" ]]; then
  EXISTING_ORIGIN=$(git -C "$SRC" config --get remote.origin.url 2>/dev/null || true)
  if [[ "$EXISTING_ORIGIN" == "$REMOTE" ]]; then
    # Managed checkout present (sentinel + matching origin). If the build
    # artifact or its dependencies are missing (interrupted build, manual
    # `rm -rf .../dist` or `.../node_modules`, disk cleanup) rebuild in place
    # rather than dead-ending below — the install one-liner is documented as
    # safe to re-run.
    # Check each package's actual resolved entry file, not just its dist/ dir:
    # vault-core builds esm then cjs in sequence and resolves via dist/cjs, so an
    # interrupted cjs stage leaves dist/ present but the entry missing.
    if [[ ! -f "$SRC/cli/dist/index.js" || ! -d "$SRC/cli/node_modules" \
       || ! -f "$SRC/sdk/dist/index.js" || ! -f "$SRC/vault-core/dist/cjs/index.js" ]]; then
      echo "  managed halo checkout at $SRC is missing its build; rebuilding in place..."
      (cd "$SRC/vault-core" && npm ci --ignore-scripts --silent && npm run build --silent)
      (cd "$SRC/sdk" && npm ci --ignore-scripts --silent && npm run build --silent)
      (cd "$SRC/cli" && npm ci --ignore-scripts --silent && npm run build --silent)
    fi
    echo "  recovering managed halo checkout at $SRC..."
    (cd "$SRC/cli" && npm link --silent)
    halo update
    exit 0
  fi
fi

if [[ -e "$SRC" ]]; then
  echo "✖ $SRC already exists but is not an active managed halo install; leaving it untouched." >&2
  exit 1
fi

echo "  resolving latest CLI release..."
LATEST=""
while read -r _hash ref; do
  tag="${ref#refs/tags/}"
  if [[ "$tag" =~ ^cli-v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    LATEST="$tag"
    break
  fi
done < <(git ls-remote --tags --sort=-v:refname "$REMOTE" 'refs/tags/cli-v*')
if [[ -z "$LATEST" ]]; then
  echo "✖ no cli-vX.Y.Z release tag exists yet" >&2
  exit 1
fi

mkdir -p "$HALO_HOME"
STAGING="${HALO_HOME}/src-staging-$$"
trap 'rm -rf "$STAGING"' EXIT
rm -rf "$STAGING"
echo "  cloning halo $LATEST..."
git clone --depth 1 --branch "$LATEST" "$REMOTE" "$STAGING"

echo "  building vault-core → sdk → CLI..."
(cd "$STAGING/vault-core" && npm ci --ignore-scripts --silent && npm run build --silent)
(cd "$STAGING/sdk" && npm ci --ignore-scripts --silent && npm run build --silent)
(cd "$STAGING/cli" && npm ci --ignore-scripts --silent && npm run build --silent)

STAGED_VERSION=$(node "$STAGING/cli/dist/index.js" --version)
if [[ "$STAGED_VERSION" != "$LATEST" ]]; then
  echo "✖ staged CLI reported '$STAGED_VERSION', expected '$LATEST'" >&2
  exit 1
fi
STAGED_HELP=$(node "$STAGING/cli/dist/index.js" --help)
if [[ "$STAGED_HELP" != *"halo — Halo operator + payer CLI"* ]]; then
  echo "✖ staged CLI --help smoke test failed" >&2
  exit 1
fi

node -e '
  const fs = require("fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({ remote: process.argv[2], installedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
' "$STAGING/.halo-managed" "$REMOTE"
mv "$STAGING" "$SRC"
trap - EXIT
node -e '
  const fs = require("fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({ lastCheckedAt: new Date().toISOString(), latestTag: process.argv[2] }, null, 2), { mode: 0o600 });
' "$HALO_HOME/update-check.json" "$LATEST"

echo "  linking halo globally..."
(cd "$SRC/cli" && npm link --silent)

echo ""
echo "✓ halo $LATEST installed at $SRC"
command -v halo
halo --version
