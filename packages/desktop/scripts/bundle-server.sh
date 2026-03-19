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
DASHBOARD_DIR="$REPO_ROOT/packages/dashboard"
STAGING="$REPO_ROOT/packages/desktop/src-tauri/server-bundle"

echo "[bundle-server] Staging server to $STAGING"

# Clean previous bundle
rm -rf "$STAGING"
mkdir -p "$STAGING/src" "$STAGING/hooks"

# package.json + lockfile for dependency installation.
# Workspace deps (@chroxy/*) are stripped before install and copied manually after.
cp "$SERVER_DIR/package.json" "$STAGING/package.json"
cp "$SERVER_DIR/package-lock.json" "$STAGING/package-lock.json"

# Server source (flat .js files)
cp "$SERVER_DIR/src/"*.js "$STAGING/src/"

# All JS subdirectories (cli/, tunnel/, utils/, handlers/, ws-file-ops/, etc.)
for subdir in "$SERVER_DIR/src"/*/; do
  dirname="$(basename "$subdir")"
  cp -r "$subdir" "$STAGING/src/$dirname"
done

# Built dashboard from @chroxy/dashboard workspace package.
# Copied to src/dashboard-next/dist/ so http-routes.js __dirname-relative path resolves.
if [ -d "$DASHBOARD_DIR/dist" ]; then
  mkdir -p "$STAGING/src/dashboard-next"
  cp -r "$DASHBOARD_DIR/dist" "$STAGING/src/dashboard-next/dist"
else
  echo "[bundle-server] WARNING: packages/dashboard/dist not found — run 'npm run build' in packages/dashboard first"
fi

# hooks/ (permission-hook.sh, loaded by permission-hook.js)
cp "$SERVER_DIR/hooks/permission-hook.sh" "$STAGING/hooks/permission-hook.sh"
chmod +x "$STAGING/hooks/permission-hook.sh"

# Remove workspace deps from package.json before npm install
# (workspace packages are copied into node_modules AFTER npm install)
cd "$STAGING"
node -e "
const pkg = require('./package.json');
for (const key of Object.keys(pkg.dependencies || {})) {
  if (key.startsWith('@chroxy/')) delete pkg.dependencies[key];
}
require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Install production dependencies
echo "[bundle-server] Installing production dependencies..."
npm install --omit=dev --no-audit --no-fund 2>&1

# Copy workspace packages AFTER npm install (npm wipes node_modules during install).
# Preserve the dist/ directory structure so "main": "./dist/index.js" resolves correctly.
PROTOCOL_DIR="$REPO_ROOT/packages/protocol"
if [ -d "$PROTOCOL_DIR/dist" ]; then
  mkdir -p "$STAGING/node_modules/@chroxy/protocol/dist"
  cp "$PROTOCOL_DIR/package.json" "$STAGING/node_modules/@chroxy/protocol/"
  cp -r "$PROTOCOL_DIR/dist/"* "$STAGING/node_modules/@chroxy/protocol/dist/"
  echo "[bundle-server] Copied @chroxy/protocol workspace package"
fi

echo "[bundle-server] Bundle complete."
du -sh "$STAGING" 2>/dev/null || true
du -sh "$STAGING/node_modules" 2>/dev/null || true
