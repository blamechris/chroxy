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
ROOT_PKG="$ROOT/package.json"
TAURI_CONF="$ROOT/packages/desktop/src-tauri/tauri.conf.json"
CARGO_TOML="$ROOT/packages/desktop/src-tauri/Cargo.toml"

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

# Update root package.json
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('$ROOT_PKG', 'utf-8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync('$ROOT_PKG', JSON.stringify(pkg, null, 2) + '\n');
"

# Update tauri.conf.json
node -e "
  const fs = require('fs');
  const conf = JSON.parse(fs.readFileSync('$TAURI_CONF', 'utf-8'));
  conf.version = '$NEW_VERSION';
  fs.writeFileSync('$TAURI_CONF', JSON.stringify(conf, null, 2) + '\n');
"

# Update Cargo.toml (line-based replacement to preserve formatting)
# Read the Cargo.toml version independently — it may differ from CURRENT if synced separately
CARGO_CURRENT=$(grep -m1 '^version = ' "$CARGO_TOML" | sed -n 's/^version = "\([^"]*\)".*/\1/p')
if [ -z "$CARGO_CURRENT" ]; then
  echo "Error: Failed to parse current version from $CARGO_TOML" >&2
  exit 1
fi
sed -i.bak "s/^version = \"$CARGO_CURRENT\"/version = \"$NEW_VERSION\"/" "$CARGO_TOML"
rm -f "$CARGO_TOML.bak"
# Verify the replacement succeeded (catches future silent no-ops)
if ! grep -q "^version = \"$NEW_VERSION\"" "$CARGO_TOML"; then
  echo "Error: Failed to update version in $CARGO_TOML" >&2
  exit 1
fi

# Regenerate Cargo.lock
(cd "$ROOT/packages/desktop/src-tauri" && cargo generate-lockfile 2>/dev/null)

echo "Updated:"
echo "  $ROOT_PKG"
echo "  $SERVER_PKG"
echo "  $APP_PKG"
echo "  $TAURI_CONF"
echo "  $CARGO_TOML"
echo "  Cargo.lock"
echo ""
echo "New version: $NEW_VERSION"
