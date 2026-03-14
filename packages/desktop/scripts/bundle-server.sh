#!/usr/bin/env bash
# bundle-server.sh — Stage server files for Tauri resource bundling.
#
# Creates a self-contained server directory at src-tauri/server-bundle/
# with production dependencies only. Tauri's bundle.resources copies this
# into Chroxy.app/Contents/Resources/server/ at build time.
#
# The directory layout preserves all __dirname-relative paths used by the
# server source (../package.json, ../node_modules/, etc.).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SERVER_DIR="$REPO_ROOT/packages/server"
STAGING="$REPO_ROOT/packages/desktop/src-tauri/server-bundle"

echo "[bundle-server] Staging server to $STAGING"

# Clean previous bundle
rm -rf "$STAGING"
mkdir -p "$STAGING/src/dashboard-next" "$STAGING/hooks"

# package.json + lockfile — reproducible installs via npm ci
# If dependencies change in package.json, regenerate the lockfile:
#   cd packages/server && npm install --package-lock-only
# Must be run from packages/server/ (not repo root) to avoid workspace protocol refs.
cp "$SERVER_DIR/package.json" "$STAGING/package.json"
cp "$SERVER_DIR/package-lock.json" "$STAGING/package-lock.json"

# Server source (flat .js files)
cp "$SERVER_DIR/src/"*.js "$STAGING/src/"

# tunnel/ subdirectory
cp -r "$SERVER_DIR/src/tunnel" "$STAGING/src/tunnel"

# utils/ subdirectory
if [ -d "$SERVER_DIR/src/utils" ]; then
  cp -r "$SERVER_DIR/src/utils" "$STAGING/src/utils"
fi

# Built dashboard (served over HTTP by ws-server.js)
if [ -d "$SERVER_DIR/src/dashboard-next/dist" ]; then
  cp -r "$SERVER_DIR/src/dashboard-next/dist" "$STAGING/src/dashboard-next/dist"
else
  echo "[bundle-server] WARNING: dashboard-next/dist not found — run 'npm run dashboard:build' first"
fi

# hooks/ (permission-hook.sh, loaded by permission-hook.js)
cp "$SERVER_DIR/hooks/permission-hook.sh" "$STAGING/hooks/permission-hook.sh"
chmod +x "$STAGING/hooks/permission-hook.sh"

# Copy workspace packages that aren't on npm
PROTOCOL_DIR="$REPO_ROOT/packages/protocol"
if [ -d "$PROTOCOL_DIR/dist" ]; then
  mkdir -p "$STAGING/node_modules/@chroxy/protocol"
  cp "$PROTOCOL_DIR/package.json" "$STAGING/node_modules/@chroxy/protocol/"
  cp -r "$PROTOCOL_DIR/dist/"* "$STAGING/node_modules/@chroxy/protocol/"
  echo "[bundle-server] Copied @chroxy/protocol workspace package"
fi

STORE_CORE_DIR="$REPO_ROOT/packages/store-core"
if [ -d "$STORE_CORE_DIR/dist" ]; then
  mkdir -p "$STAGING/node_modules/@chroxy/store-core"
  cp "$STORE_CORE_DIR/package.json" "$STAGING/node_modules/@chroxy/store-core/"
  cp -r "$STORE_CORE_DIR/dist/"* "$STAGING/node_modules/@chroxy/store-core/"
  echo "[bundle-server] Copied @chroxy/store-core workspace package"
fi

# Remove workspace deps from package.json before npm ci (they're already copied)
cd "$STAGING"
node -e "
const pkg = require('./package.json');
for (const key of Object.keys(pkg.dependencies || {})) {
  if (key.startsWith('@chroxy/')) delete pkg.dependencies[key];
}
require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Install production dependencies (deterministic via lockfile)
echo "[bundle-server] Installing production dependencies..."
npm install --omit=dev --no-audit --no-fund 2>&1

echo "[bundle-server] Bundle complete."
du -sh "$STAGING" 2>/dev/null || true
du -sh "$STAGING/node_modules" 2>/dev/null || true
