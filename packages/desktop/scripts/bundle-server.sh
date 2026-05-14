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
  # rm -rf first — cp -r merges directories, leaving stale hashed files
  rm -rf "$STAGING/src/dashboard-next/dist"
  mkdir -p "$STAGING/src/dashboard-next"
  cp -r "$DASHBOARD_DIR/dist" "$STAGING/src/dashboard-next/dist"
else
  echo "[bundle-server] WARNING: packages/dashboard/dist not found — run 'npm run build' in packages/dashboard first"
fi

# hooks/ (permission-hook.sh, loaded by permission-hook.js)
cp "$SERVER_DIR/hooks/permission-hook.sh" "$STAGING/hooks/permission-hook.sh"
chmod +x "$STAGING/hooks/permission-hook.sh"

# Remove workspace deps and postinstall script from package.json before
# npm install. The postinstall (fix-node-pty-helper.js) lives under
# packages/server/scripts/ which we don't stage — and we don't need it
# anyway because build.rs handles node-pty chmod + codesign at Tauri
# bundle time (#3902).
cd "$STAGING"
node -e "
const pkg = require('./package.json');
for (const key of Object.keys(pkg.dependencies || {})) {
  if (key.startsWith('@chroxy/')) delete pkg.dependencies[key];
}
if (pkg.scripts) delete pkg.scripts.postinstall;
require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Install production dependencies
echo "[bundle-server] Installing production dependencies..."
npm install --omit=dev --no-audit --no-fund 2>&1

# Prune Bare-runtime prebuilds.
#
# `bare-fs`, `bare-url`, `bare-os` and friends ship `.bare` native binaries for
# the Holepunch Bare runtime. They arrive as transitive deps of
# `tar-fs@3 → bare-fs`, pulled in by `@kubernetes/client-node`. When the server
# runs on Node.js (always, for us), `bare-fs` is never required — `tar-fs`
# uses Node's native `fs` directly. The prebuilds are pure dead weight (~3 MB)
# AND they fail Apple notarization because they're unsigned native binaries
# embedded inside the Tauri app bundle.
echo "[bundle-server] Pruning Bare-runtime prebuilds (unused under Node.js)..."
# -print emits each matched dir before -exec deletes it, so we can count
# in a single pass without re-traversing. tr -d ' ' strips the leading
# space BSD `wc -l` prefixes (GNU wc doesn't). #3824 — if this drops to 0
# in a future bump, the workaround has become unnecessary and the prune
# can be removed; if it changes, the dep graph drifted and notarization
# may be at risk.
PRUNED_COUNT=$(find "$STAGING/node_modules" -type d -name prebuilds -path "*/bare-*/prebuilds" -prune -print -exec rm -rf {} + | wc -l | tr -d ' ')
echo "[bundle-server] Pruned $PRUNED_COUNT bare-runtime prebuilds dir(s)"

# Copy workspace packages AFTER npm install (npm wipes node_modules during install).
# Preserve the dist/ directory structure so "main": "./dist/index.js" resolves correctly.
PROTOCOL_DIR="$REPO_ROOT/packages/protocol"
if [ -d "$PROTOCOL_DIR/dist" ]; then
  mkdir -p "$STAGING/node_modules/@chroxy/protocol/dist"
  cp "$PROTOCOL_DIR/package.json" "$STAGING/node_modules/@chroxy/protocol/"
  cp -r "$PROTOCOL_DIR/dist/"* "$STAGING/node_modules/@chroxy/protocol/dist/"
  echo "[bundle-server] Copied @chroxy/protocol workspace package"
fi

STORECORE_DIR="$REPO_ROOT/packages/store-core"
if [ -d "$STORECORE_DIR/dist" ]; then
  mkdir -p "$STAGING/node_modules/@chroxy/store-core/dist"
  cp "$STORECORE_DIR/package.json" "$STAGING/node_modules/@chroxy/store-core/"
  cp -r "$STORECORE_DIR/dist/crypto.js" "$STAGING/node_modules/@chroxy/store-core/dist/"
  cp -r "$STORECORE_DIR/dist/crypto.d.ts" "$STAGING/node_modules/@chroxy/store-core/dist/"
  echo "[bundle-server] Copied @chroxy/store-core workspace package (crypto)"
fi

# Defensive: after ALL node_modules mutations (npm install + bare-runtime
# prune + workspace package copies), the bundle must not contain any
# unsigned native binaries. The prune above only targets a specific path
# pattern (`*/bare-*/prebuilds`); if a future dep upgrade ships native code
# outside that layout — e.g. a `.bare` under a non-`bare-*` package name,
# a `.node` Node addon, or a `.dylib`/`.so` from a transitive dep — Apple
# notarization will silently fail weeks later when we cut a release. This
# guard converts that ~5-minute release-time feedback loop into a 30-second
# build-time failure with the exact offending paths printed (#3825).
#
# IMPORTANT: this check runs AFTER the workspace package copies above, so
# the workspace dist/ trees are also covered if anyone ever lands a native
# binary inside `@chroxy/*`. Reordering the prune or workspace-copy blocks
# above this guard is fine; moving the guard above either of them is NOT.
echo "[bundle-server] Verifying no unsigned native binaries remain..."
NATIVE_BINS=$(find "$STAGING/node_modules" -type f \( \
  -name "*.bare" -o \
  -name "*.node" -o \
  -name "*.dylib" -o \
  -name "*.so" \
\) 2>/dev/null || true)
if [ -n "$NATIVE_BINS" ]; then
  echo "[bundle-server] ERROR: server bundle contains unsigned native binaries" >&2
  echo "[bundle-server] These will be rejected by Apple notarization (Tauri only" >&2
  echo "[bundle-server] signs the main app binary; transitive native deps are not signed):" >&2
  # shellcheck disable=SC2001 # parameter expansion can't insert a per-line prefix on multi-line strings
  echo "$NATIVE_BINS" | sed 's/^/[bundle-server]   /' >&2
  echo "[bundle-server] " >&2
  echo "[bundle-server] To resolve: identify the dep that pulled this in (npm ls" >&2
  echo "[bundle-server] <pkg>) and either remove it, replace it with a JS-only" >&2
  echo "[bundle-server] alternative, or extend the prune block above to drop the" >&2
  echo "[bundle-server] native binaries from the bundle." >&2
  exit 1
fi
echo "[bundle-server] OK: no unsigned native binaries detected."

echo "[bundle-server] Bundle complete."
du -sh "$STAGING" 2>/dev/null || true
du -sh "$STAGING/node_modules" 2>/dev/null || true
