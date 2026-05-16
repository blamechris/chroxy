#!/usr/bin/env bash
#
# bump-version.sh — Bump the patch version across all package files.
#
# Usage:
#   ./scripts/bump-version.sh                 # auto-bump patch (0.3.2 → 0.3.3)
#   ./scripts/bump-version.sh 0.4.0           # set explicit version
#   ./scripts/bump-version.sh --no-changelog  # skip CHANGELOG.md scaffold
#
# CHANGELOG scaffolding:
#   This script prepends a placeholder section to CHANGELOG.md for the new
#   version. The placeholder contains a `- TODO:` marker the author is expected
#   to replace. If the most recent CHANGELOG section still contains a `TODO`
#   marker from a prior bump, the script aborts — this is the mechanical guard
#   that prevents the v0.7.0–v0.7.17 backfill problem (#3803, #3974) from
#   recurring. Pass --no-changelog to override (e.g. for hotfix bumps where
#   the changelog will land in a separate PR).
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

SKIP_CHANGELOG=0
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --no-changelog)
      SKIP_CHANGELOG=1
      ;;
    -h|--help)
      # Print the contiguous comment header (line 2 through the last `#`-led
      # line before `set -euo pipefail`). Computed dynamically so the help
      # output never goes out of sync when the header is expanded.
      help_end=$(awk 'NR==1 {next} /^#/ {last=NR; next} {exit} END {print last}' "$0")
      sed -n "2,${help_end}p" "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --*)
      echo "Error: Unknown flag '$arg'" >&2
      exit 1
      ;;
    *)
      POSITIONAL+=("$arg")
      ;;
  esac
done

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
IOS_INFO_PLIST="$ROOT/packages/app/ios/Chroxy/Info.plist"
CHANGELOG="$ROOT/CHANGELOG.md"

# Clean up any orphan .tmp siblings created by the awk-into-place pattern
# below. With `set -euo pipefail` an awk failure (disk full, killed process,
# permission flip) aborts before the `mv`, leaving a stale `.tmp` next to
# the real file. The next bump run would silently ignore the orphan and
# hide the previous partial failure (#3886).
#
# Scope is deliberately tight: each awk-into-place call registers its `.tmp`
# path via `track_tmp` immediately before the write, and the EXIT trap only
# removes paths that were registered in this run. Pre-existing `.tmp` files
# from other tooling are never touched.
TMP_FILES=()
track_tmp() {
  TMP_FILES+=("$1")
}
cleanup_tmp_files() {
  local f
  for f in "${TMP_FILES[@]:-}"; do
    [ -n "$f" ] && rm -f "$f" 2>/dev/null
  done
  return 0
}
trap cleanup_tmp_files EXIT

# Read current version from server package.json (single source of truth)
CURRENT=$(node -e "console.log(require('$SERVER_PKG').version)")

if [ "${#POSITIONAL[@]}" -gt 1 ]; then
  echo "Error: Too many positional arguments. Expected at most one version." >&2
  exit 1
fi

if [ "${#POSITIONAL[@]}" -eq 1 ]; then
  NEW_VERSION="${POSITIONAL[0]}"
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
# An audit on 2026-04-11 found that all six workspace entries had silently
# drifted 2+ versions behind because a prior iteration of this script only
# touched packages[""]. The loop below
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
if [ -f "$IOS_INFO_PLIST" ]; then
  # Replace the string immediately following CFBundleShortVersionString.
  # awk is chosen over plutil because plutil rewrites the whole file
  # (changing indentation and field order) and we only want a minimal diff.
  # getline is guarded: if the key somehow lands on the last line (malformed
  # file, unexpected reformatting), we don't silently no-op — the script
  # fails loudly via the post-run verification grep below.
  track_tmp "$IOS_INFO_PLIST.tmp"
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

# Scaffold a CHANGELOG.md section for the new version.
#
# Idempotency: skip if a section for $NEW_VERSION already exists (the author
# may have prepared it ahead of the bump).
#
# Drift guard: if the most-recent prior section still contains the literal
# `- TODO:` marker emitted by a previous bump, abort. This is the mechanical
# barrier against the v0.7.x backfill scenario (#3803, #3974) — devs must
# replace the placeholder before bumping again. Pass --no-changelog to
# override.
CHANGELOG_UPDATED=0
if [ "$SKIP_CHANGELOG" -eq 0 ] && [ -f "$CHANGELOG" ]; then
  if grep -qE "^## \[$NEW_VERSION\]" "$CHANGELOG"; then
    echo "Note: CHANGELOG.md already has a section for $NEW_VERSION — leaving it untouched."
  else
    # Extract just the most-recent prior section (between the first `## [` line
    # and the next one) to scope the TODO check. Without this scoping a stale
    # TODO from any historical version would block every future bump.
    PRIOR_SECTION=$(awk '
      /^## \[/ {
        if (seen) exit
        seen = 1
        next
      }
      seen { print }
    ' "$CHANGELOG")
    if echo "$PRIOR_SECTION" | grep -qE "^- TODO:"; then
      echo "Error: Previous CHANGELOG.md section still contains a '- TODO:' placeholder." >&2
      echo "       Fill it in before bumping again, or re-run with --no-changelog to override." >&2
      exit 1
    fi

    TODAY=$(date +%Y-%m-%d)

    # Build the new entry in its own tempfile so we can splice it in without
    # passing a multi-line string through `awk -v`. macOS BSD awk rejects
    # newlines inside -v strings ("newline in string"), so we feed the entry
    # via getline from a side file instead.
    track_tmp "$CHANGELOG.entry.tmp"
    cat > "$CHANGELOG.entry.tmp" <<EOF
## [$NEW_VERSION] - $TODAY

### Added

- TODO: describe additions for this release (or delete this section)

### Changed

- TODO: describe changes for this release (or delete this section)

### Fixed

- TODO: describe fixes for this release (or delete this section)

EOF

    # Insert the new section before the first `## [` line. The header (title +
    # "Keep a Changelog" preamble) sits above that line and must be preserved.
    track_tmp "$CHANGELOG.tmp"
    awk -v entry_file="$CHANGELOG.entry.tmp" '
      !inserted && /^## \[/ {
        while ((getline line < entry_file) > 0) print line
        close(entry_file)
        inserted = 1
      }
      { print }
    ' "$CHANGELOG" > "$CHANGELOG.tmp" && mv "$CHANGELOG.tmp" "$CHANGELOG"
    rm -f "$CHANGELOG.entry.tmp"

    # Verify the new section actually landed — guards against an empty
    # CHANGELOG, missing prior `## [` lines, or other awk no-ops.
    if ! grep -qE "^## \[$NEW_VERSION\] - " "$CHANGELOG"; then
      echo "Error: Failed to scaffold CHANGELOG.md section for $NEW_VERSION" >&2
      exit 1
    fi
    CHANGELOG_UPDATED=1
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
if [ "$CHANGELOG_UPDATED" -eq 1 ]; then
  echo "  $CHANGELOG (scaffolded section for $NEW_VERSION — replace the TODO lines before commit)"
fi
echo ""
echo "New version: $NEW_VERSION"
if [ "$CHANGELOG_UPDATED" -eq 1 ]; then
  echo ""
  echo "Next step: edit CHANGELOG.md and replace the '- TODO:' placeholders"
  echo "           under [$NEW_VERSION] with the actual changes for this release."
fi
