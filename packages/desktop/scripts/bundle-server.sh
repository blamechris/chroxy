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
cp "$SERVER_DIR/package.json" "$STAGING/package.json"
cp "$SERVER_DIR/package-lock.json" "$STAGING/package-lock.json"

# Server source (flat .js files)
cp "$SERVER_DIR/src/"*.js "$STAGING/src/"

# tunnel/ subdirectory
cp -r "$SERVER_DIR/src/tunnel" "$STAGING/src/tunnel"

# Built dashboard (served over HTTP by ws-server.js)
if [ -d "$SERVER_DIR/src/dashboard-next/dist" ]; then
  cp -r "$SERVER_DIR/src/dashboard-next/dist" "$STAGING/src/dashboard-next/dist"
else
  echo "[bundle-server] WARNING: dashboard-next/dist not found — run 'npm run dashboard:build' first"
fi

# hooks/ (permission-hook.sh, loaded by permission-hook.js)
cp "$SERVER_DIR/hooks/permission-hook.sh" "$STAGING/hooks/permission-hook.sh"
chmod +x "$STAGING/hooks/permission-hook.sh"

# Install production dependencies (deterministic via lockfile)
echo "[bundle-server] Installing production dependencies..."
cd "$STAGING"
npm ci --omit=dev --no-audit --no-fund 2>&1

echo "[bundle-server] Bundle complete."
du -sh "$STAGING" 2>/dev/null || true
du -sh "$STAGING/node_modules" 2>/dev/null || true
