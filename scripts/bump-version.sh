#!/usr/bin/env bash
#
# bump-version.sh — Bump the patch version across all package files.
#
# Usage:
#   ./scripts/bump-version.sh          # auto-bump patch (0.3.2 → 0.3.3)
#   ./scripts/bump-version.sh 0.4.0    # set explicit version
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

SERVER_PKG="$ROOT/packages/server/package.json"
APP_PKG="$ROOT/packages/app/package.json"
APP_JSON="$ROOT/packages/app/app.json"
ROOT_PKG="$ROOT/package.json"
DESKTOP_PKG="$ROOT/packages/desktop/package.json"
PROTOCOL_PKG="$ROOT/packages/protocol/package.json"
STORE_CORE_PKG="$ROOT/packages/store-core/package.json"
DASHBOARD_PKG="$ROOT/packages/dashboard/package.json"
TAURI_CONF="$ROOT/packages/desktop/src-tauri/tauri.conf.json"
CARGO_TOML="$ROOT/packages/desktop/src-tauri/Cargo.toml"
ROOT_LOCK="$ROOT/package-lock.json"
SERVER_LOCK="$ROOT/packages/server/package-lock.json"

# Read current version from server package.json (single source of truth)
CURRENT=$(node -e "console.log(require('$SERVER_PKG').version)")

if [ -n "${1:-}" ]; then
  NEW_VERSION="$1"
else
  # Auto-bump patch: 0.3.2 → 0.3.3
  IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
  NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
fi

# Validate version format (semver x.y.z)
if ! echo "$NEW_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: Invalid version format '$NEW_VERSION' — must be x.y.z"
  exit 1
fi

echo "Bumping version: $CURRENT → $NEW_VERSION"

# Update server package.json
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('$SERVER_PKG', 'utf-8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync('$SERVER_PKG', JSON.stringify(pkg, null, 2) + '\n');
"

# Update app package.json
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('$APP_PKG', 'utf-8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync('$APP_PKG', JSON.stringify(pkg, null, 2) + '\n');
"

# Update app.json (Expo config — shown as "App Version" in mobile app)
node -e "
  const fs = require('fs');
  const app = JSON.parse(fs.readFileSync('$APP_JSON', 'utf-8'));
  app.expo.version = '$NEW_VERSION';
  fs.writeFileSync('$APP_JSON', JSON.stringify(app, null, 2) + '\n');
"

# Update root package.json
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('$ROOT_PKG', 'utf-8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync('$ROOT_PKG', JSON.stringify(pkg, null, 2) + '\n');
"

# Update desktop package.json
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('$DESKTOP_PKG', 'utf-8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync('$DESKTOP_PKG', JSON.stringify(pkg, null, 2) + '\n');
"

# Update protocol package.json
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('$PROTOCOL_PKG', 'utf-8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync('$PROTOCOL_PKG', JSON.stringify(pkg, null, 2) + '\n');
"

# Update store-core package.json
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('$STORE_CORE_PKG', 'utf-8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync('$STORE_CORE_PKG', JSON.stringify(pkg, null, 2) + '\n');
"

# Update dashboard package.json
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('$DASHBOARD_PKG', 'utf-8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync('$DASHBOARD_PKG', JSON.stringify(pkg, null, 2) + '\n');
"

# Update tauri.conf.json
node -e "
  const fs = require('fs');
  const conf = JSON.parse(fs.readFileSync('$TAURI_CONF', 'utf-8'));
  conf.version = '$NEW_VERSION';
  fs.writeFileSync('$TAURI_CONF', JSON.stringify(conf, null, 2) + '\n');
"

# Update Cargo.toml (line-based replacement to preserve formatting)
# Read the Cargo.toml version from [package] section only — avoid matching dependency version lines
CARGO_CURRENT=$(awk '/^\[package\]/{f=1; next} /^\[/{f=0} f' "$CARGO_TOML" | sed -n 's/^version = "\([^"]*\)".*/\1/p')
if [ -z "$CARGO_CURRENT" ]; then
  echo "Error: Failed to parse current version from $CARGO_TOML [package] section" >&2
  exit 1
fi
sed -i.bak "/^\[package\]/,/^\[/s/^version = \"$CARGO_CURRENT\"/version = \"$NEW_VERSION\"/" "$CARGO_TOML"
rm -f "$CARGO_TOML.bak"
# Verify the replacement succeeded — scope check to [package] section to avoid false-passing
# on a dependency that happens to share the same version string
CARGO_VERIFY=$(awk '/^\[package\]/{f=1; next} /^\[/{f=0} f' "$CARGO_TOML" | grep -c "^version = \"$NEW_VERSION\"" || true)
if [ "$CARGO_VERIFY" -ne 1 ]; then
  echo "Error: Failed to update version in $CARGO_TOML [package] section" >&2
  exit 1
fi

# Update package-lock.json version fields.
# The root lockfile has nested entries for every workspace (packages/app,
# packages/dashboard, packages/desktop, packages/protocol, packages/server,
# packages/store-core) in addition to the top-level version + packages[""].
# Audit discovered on 2026-04-11 (docs/audit-results/eas-cng-config/) that
# all six workspace entries were silently drifted 2+ versions behind because
# a prior iteration of this script only touched packages[""]. The loop below
# walks every lock.packages[k] where k starts with "packages/" and rewrites
# the version. Other lockfile fields (resolved, integrity, deps) are left
# untouched and will be regenerated by the next `npm install`.
for LOCK in "$ROOT_LOCK" "$SERVER_LOCK"; do
  if [ -f "$LOCK" ]; then
    node -e "
      const fs = require('fs');
      const lock = JSON.parse(fs.readFileSync('$LOCK', 'utf-8'));
      lock.version = '$NEW_VERSION';
      if (lock.packages) {
        if (lock.packages['']) {
          lock.packages[''].version = '$NEW_VERSION';
        }
        for (const key of Object.keys(lock.packages)) {
          // Only rewrite workspace entries (packages/<name>), never their nested node_modules paths.
          if (key.startsWith('packages/') && !key.includes('/node_modules/')) {
            lock.packages[key].version = '$NEW_VERSION';
          }
        }
      }
      fs.writeFileSync('$LOCK', JSON.stringify(lock, null, 2) + '\n');
    "
  fi
done

# Update packages/app/ios/Chroxy/Info.plist CFBundleShortVersionString.
# Committed iOS native project is not regenerated by CNG; every bump must
# sync this manually or the iOS bundle ships with a stale version string.
# Audit 2026-04-11 found this file had been at 0.2.0 for 4+ minor releases.
IOS_INFO_PLIST="$ROOT/packages/app/ios/Chroxy/Info.plist"
if [ -f "$IOS_INFO_PLIST" ]; then
  # Replace the string immediately following CFBundleShortVersionString.
  # awk is chosen over plutil because plutil rewrites the whole file
  # (changing indentation and field order) and we only want a minimal diff.
  # getline is guarded: if the key somehow lands on the last line (malformed
  # file, unexpected reformatting), we don't silently no-op — the script
  # fails loudly via the post-run verification grep below.
  awk -v new="$NEW_VERSION" '
    /<key>CFBundleShortVersionString<\/key>/ {
      print
      if ((getline next_line) > 0) {
        sub(/>[^<]*</, ">" new "<", next_line)
        print next_line
      }
      next
    }
    { print }
  ' "$IOS_INFO_PLIST" > "$IOS_INFO_PLIST.tmp" && mv "$IOS_INFO_PLIST.tmp" "$IOS_INFO_PLIST"

  # Verify the replacement actually landed — catches the "getline returned 0"
  # case above, any regex mismatch (e.g., Info.plist reformatted to put the
  # <string> on a non-adjacent line), and future schema drift.
  if ! grep -q "<string>$NEW_VERSION</string>" "$IOS_INFO_PLIST"; then
    echo "Error: Failed to update CFBundleShortVersionString in $IOS_INFO_PLIST to $NEW_VERSION" >&2
    echo "Current CFBundleShortVersionString block:" >&2
    grep -A 1 "CFBundleShortVersionString" "$IOS_INFO_PLIST" >&2 || true
    exit 1
  fi
fi

# Regenerate Cargo.lock
(cd "$ROOT/packages/desktop/src-tauri" && cargo generate-lockfile 2>/dev/null)

echo "Updated:"
echo "  $ROOT_PKG"
echo "  $SERVER_PKG"
echo "  $APP_PKG"
echo "  $APP_JSON"
echo "  $DESKTOP_PKG"
echo "  $PROTOCOL_PKG"
echo "  $STORE_CORE_PKG"
echo "  $TAURI_CONF"
echo "  $CARGO_TOML"
echo "  $ROOT_LOCK (top-level + all workspace entries)"
echo "  $SERVER_LOCK (standalone server package lockfile — no workspace entries)"
echo "  Cargo.lock"
echo "  $IOS_INFO_PLIST"
echo ""
echo "New version: $NEW_VERSION"
