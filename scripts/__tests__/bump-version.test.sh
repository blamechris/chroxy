#!/usr/bin/env bash
#
# bump-version.test.sh — Self-contained test harness for scripts/bump-version.sh.
#
# Runs in a temp dir with a minimal fake monorepo skeleton (just the file paths
# bump-version.sh writes to). Each test case asserts an observable behavior of
# the script. No external test framework — keeps CI dep surface zero.
#
# Run from repo root:
#   bash scripts/__tests__/bump-version.test.sh
#
# Exit status: 0 if all tests pass, 1 otherwise.
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUMP="$REPO_ROOT/scripts/bump-version.sh"

PASS=0
FAIL=0
FAILED_TESTS=()

# --- helpers -----------------------------------------------------------------

# Build a minimal fake repo at $1 that satisfies every path bump-version.sh
# touches. Versions all start at $2.
build_fake_repo() {
  local dir="$1"
  local v="$2"
  mkdir -p "$dir/packages/server" "$dir/packages/app/ios/Chroxy" \
           "$dir/packages/desktop/src-tauri" "$dir/packages/protocol" \
           "$dir/packages/store-core" "$dir/packages/dashboard"

  for pkg in server app desktop protocol store-core dashboard; do
    printf '{"name":"%s","version":"%s"}\n' "$pkg" "$v" \
      > "$dir/packages/$pkg/package.json"
  done
  printf '{"name":"chroxy","version":"%s"}\n' "$v" > "$dir/package.json"
  printf '{"expo":{"name":"chroxy","version":"%s"}}\n' "$v" \
    > "$dir/packages/app/app.json"
  printf '{"version":"%s"}\n' "$v" \
    > "$dir/packages/desktop/src-tauri/tauri.conf.json"
  cat > "$dir/packages/desktop/src-tauri/Cargo.toml" <<EOF
[package]
name = "chroxy-desktop"
version = "$v"
edition = "2021"
EOF
  cat > "$dir/packages/app/ios/Chroxy/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>$v</string>
</dict>
</plist>
EOF
  printf '{"version":"%s","packages":{"":{"version":"%s"}}}\n' "$v" "$v" \
    > "$dir/package-lock.json"
  printf '{"version":"%s","packages":{"":{"version":"%s"}}}\n' "$v" "$v" \
    > "$dir/packages/server/package-lock.json"
}

# Copy bump-version.sh into the fake repo, neutralizing the calls to external
# binaries we don't want to actually run (cargo, the live grep on iOS plist is
# fine — the stub Info.plist above is realistic enough).
install_bump_script() {
  local dir="$1"
  mkdir -p "$dir/scripts"
  # Replace `cargo generate-lockfile` with a no-op so the test doesn't require
  # a Rust toolchain. Everything else runs as-is.
  sed 's|cargo generate-lockfile|true|g' "$BUMP" > "$dir/scripts/bump-version.sh"
  chmod +x "$dir/scripts/bump-version.sh"
}

# Write a minimal CHANGELOG.md (header + one prior section).
write_changelog() {
  local file="$1"
  local prev_version="$2"
  local prev_body="$3"
  cat > "$file" <<EOF
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [$prev_version] - 2026-01-01

$prev_body
EOF
}

run_test() {
  local name="$1"
  shift
  if "$@"; then
    PASS=$((PASS + 1))
    echo "  PASS  $name"
  else
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$name")
    echo "  FAIL  $name"
  fi
}

# --- test cases --------------------------------------------------------------

test_scaffolds_new_section() {
  local dir
  dir=$(mktemp -d)
  trap "rm -rf '$dir'" RETURN
  build_fake_repo "$dir" "0.1.0"
  install_bump_script "$dir"
  write_changelog "$dir/CHANGELOG.md" "0.1.0" "### Fixed

- Some prior fix (#1)"

  (cd "$dir" && ./scripts/bump-version.sh 0.2.0) > /dev/null 2>&1 || return 1

  # New section header present, on its own line, with today's date
  local today
  today=$(date +%Y-%m-%d)
  grep -q "^## \[0.2.0\] - $today\$" "$dir/CHANGELOG.md" || {
    echo "    expected: ## [0.2.0] - $today" >&2
    return 1
  }

  # All three placeholder sections present
  grep -q "^### Added\$" "$dir/CHANGELOG.md" || return 1
  grep -q "^### Changed\$" "$dir/CHANGELOG.md" || return 1
  grep -q "^### Fixed\$" "$dir/CHANGELOG.md" || return 1

  # TODO markers present (drift guard fodder)
  [ "$(grep -c '^- TODO:' "$dir/CHANGELOG.md")" -eq 3 ] || return 1

  # Prior section preserved
  grep -q "^## \[0.1.0\] - 2026-01-01" "$dir/CHANGELOG.md" || return 1
  grep -q "Some prior fix" "$dir/CHANGELOG.md" || return 1

  # New section appears BEFORE the prior section (Keep-a-Changelog ordering)
  local new_line prev_line
  new_line=$(grep -n "^## \[0.2.0\]" "$dir/CHANGELOG.md" | head -1 | cut -d: -f1)
  prev_line=$(grep -n "^## \[0.1.0\]" "$dir/CHANGELOG.md" | head -1 | cut -d: -f1)
  [ "$new_line" -lt "$prev_line" ]
}

test_preserves_header_preamble() {
  local dir
  dir=$(mktemp -d)
  trap "rm -rf '$dir'" RETURN
  build_fake_repo "$dir" "0.1.0"
  install_bump_script "$dir"
  write_changelog "$dir/CHANGELOG.md" "0.1.0" "### Added

- Initial release"

  (cd "$dir" && ./scripts/bump-version.sh 0.2.0) > /dev/null 2>&1 || return 1

  # The Keep-a-Changelog preamble lines must still be the first non-blank lines
  head -5 "$dir/CHANGELOG.md" | grep -q "^# Changelog\$" || return 1
  head -10 "$dir/CHANGELOG.md" | grep -q "Keep a Changelog" || return 1
}

test_idempotent_when_section_exists() {
  local dir
  dir=$(mktemp -d)
  trap "rm -rf '$dir'" RETURN
  build_fake_repo "$dir" "0.1.0"
  install_bump_script "$dir"
  cat > "$dir/CHANGELOG.md" <<'EOF'
# Changelog

## [0.2.0] - 2026-05-15

### Added

- Already documented this release manually

## [0.1.0] - 2026-01-01

### Added

- Initial release
EOF

  (cd "$dir" && ./scripts/bump-version.sh 0.2.0) > /dev/null 2>&1 || return 1

  # The pre-existing 0.2.0 section must survive untouched — no duplicate
  # header, no TODO injection.
  [ "$(grep -c '^## \[0.2.0\]' "$dir/CHANGELOG.md")" -eq 1 ] || return 1
  ! grep -q "^- TODO:" "$dir/CHANGELOG.md" || return 1
  grep -q "Already documented this release manually" "$dir/CHANGELOG.md" || return 1
}

test_blocks_when_prior_todo_unresolved() {
  local dir
  dir=$(mktemp -d)
  trap "rm -rf '$dir'" RETURN
  build_fake_repo "$dir" "0.1.0"
  install_bump_script "$dir"
  cat > "$dir/CHANGELOG.md" <<'EOF'
# Changelog

## [0.1.0] - 2026-01-01

### Added

- TODO: describe additions for this release (or delete this section)
EOF

  local output
  output=$(cd "$dir" && ./scripts/bump-version.sh 0.2.0 2>&1)
  local status=$?

  # Script must exit non-zero
  [ "$status" -ne 0 ] || {
    echo "    expected non-zero exit, got 0" >&2
    return 1
  }

  # Error message must reference the TODO placeholder
  echo "$output" | grep -q "TODO" || {
    echo "    error message did not mention TODO: $output" >&2
    return 1
  }

  # CHANGELOG must be unchanged (no 0.2.0 section)
  ! grep -q "^## \[0.2.0\]" "$dir/CHANGELOG.md" || return 1
}

test_no_changelog_flag_skips_scaffold() {
  local dir
  dir=$(mktemp -d)
  trap "rm -rf '$dir'" RETURN
  build_fake_repo "$dir" "0.1.0"
  install_bump_script "$dir"
  # Deliberately set up a CHANGELOG with an unresolved TODO — the flag must
  # still allow the bump to proceed.
  cat > "$dir/CHANGELOG.md" <<'EOF'
# Changelog

## [0.1.0] - 2026-01-01

### Added

- TODO: describe additions for this release (or delete this section)
EOF

  (cd "$dir" && ./scripts/bump-version.sh --no-changelog 0.2.0) > /dev/null 2>&1 || return 1

  # Version files updated
  grep -qE '"version":\s*"0.2.0"' "$dir/packages/server/package.json" || return 1
  # CHANGELOG.md untouched (still no 0.2.0 section)
  ! grep -q "^## \[0.2.0\]" "$dir/CHANGELOG.md" || return 1
}

test_no_changelog_flag_before_version() {
  # Flag order must not matter — --no-changelog can come before or after the
  # version positional.
  local dir
  dir=$(mktemp -d)
  trap "rm -rf '$dir'" RETURN
  build_fake_repo "$dir" "0.1.0"
  install_bump_script "$dir"
  write_changelog "$dir/CHANGELOG.md" "0.1.0" "### Added

- Initial release"

  (cd "$dir" && ./scripts/bump-version.sh 0.2.0 --no-changelog) > /dev/null 2>&1 || return 1
  ! grep -q "^## \[0.2.0\]" "$dir/CHANGELOG.md" || return 1
}

test_auto_bump_patch_with_scaffold() {
  local dir
  dir=$(mktemp -d)
  trap "rm -rf '$dir'" RETURN
  build_fake_repo "$dir" "0.5.7"
  install_bump_script "$dir"
  write_changelog "$dir/CHANGELOG.md" "0.5.7" "### Fixed

- A real fix (#42)"

  (cd "$dir" && ./scripts/bump-version.sh) > /dev/null 2>&1 || return 1

  # Auto-bumped to 0.5.8 and scaffolded
  grep -qE '"version":\s*"0.5.8"' "$dir/packages/server/package.json" || return 1
  grep -q "^## \[0.5.8\] - " "$dir/CHANGELOG.md" || return 1
}

test_only_checks_most_recent_section_for_todo() {
  # A stale TODO in an OLD section (older than the most-recent) must NOT block
  # the bump — otherwise every bump after a missed CHANGELOG update would be
  # permanently blocked.
  local dir
  dir=$(mktemp -d)
  trap "rm -rf '$dir'" RETURN
  build_fake_repo "$dir" "0.2.0"
  install_bump_script "$dir"
  cat > "$dir/CHANGELOG.md" <<'EOF'
# Changelog

## [0.2.0] - 2026-02-01

### Added

- Properly documented this one

## [0.1.0] - 2026-01-01

### Added

- TODO: describe additions for this release (or delete this section)
EOF

  (cd "$dir" && ./scripts/bump-version.sh 0.3.0) > /dev/null 2>&1 || {
    echo "    bump unexpectedly failed despite stale TODO being in OLD section" >&2
    return 1
  }
  grep -q "^## \[0.3.0\]" "$dir/CHANGELOG.md" || return 1
}

test_help_prints_full_header() {
  # The header comment block expanded from 9 lines to 16+ in this PR. Earlier
  # versions of --help printed a hardcoded line range (2,11) and silently
  # truncated. Lock the contract: --help must include both the usage block
  # AND the CHANGELOG scaffolding paragraph.
  local dir
  dir=$(mktemp -d)
  trap "rm -rf '$dir'" RETURN
  build_fake_repo "$dir" "0.1.0"
  install_bump_script "$dir"

  local output
  output=$(cd "$dir" && ./scripts/bump-version.sh --help 2>&1)
  [ $? -eq 0 ] || return 1

  echo "$output" | grep -q "Usage:" || {
    echo "    --help missing 'Usage:'" >&2
    return 1
  }
  echo "$output" | grep -q "no-changelog" || {
    echo "    --help missing '--no-changelog' line" >&2
    return 1
  }
  echo "$output" | grep -q "CHANGELOG scaffolding" || {
    echo "    --help truncated before CHANGELOG scaffolding paragraph" >&2
    return 1
  }
}

test_rejects_unknown_flag() {
  local dir
  dir=$(mktemp -d)
  trap "rm -rf '$dir'" RETURN
  build_fake_repo "$dir" "0.1.0"
  install_bump_script "$dir"
  write_changelog "$dir/CHANGELOG.md" "0.1.0" "### Fixed

- prior"

  (cd "$dir" && ./scripts/bump-version.sh --bogus-flag 0.2.0) > /dev/null 2>&1
  [ $? -ne 0 ]
}

# --- runner ------------------------------------------------------------------

echo "Running bump-version.sh tests"
echo "============================="
run_test "scaffolds a new CHANGELOG section with today's date" \
  test_scaffolds_new_section
run_test "preserves the Keep-a-Changelog header preamble" \
  test_preserves_header_preamble
run_test "is idempotent when a section for the new version already exists" \
  test_idempotent_when_section_exists
run_test "blocks the bump when the prior section still has a TODO" \
  test_blocks_when_prior_todo_unresolved
run_test "--no-changelog flag skips the scaffold and TODO check" \
  test_no_changelog_flag_skips_scaffold
run_test "--no-changelog flag works in either argument order" \
  test_no_changelog_flag_before_version
run_test "auto-bumps patch version and scaffolds the new section" \
  test_auto_bump_patch_with_scaffold
run_test "TODO check is scoped to the most-recent section only" \
  test_only_checks_most_recent_section_for_todo
run_test "--help prints the full header (Usage + CHANGELOG scaffolding)" \
  test_help_prints_full_header
run_test "rejects unknown flags" \
  test_rejects_unknown_flag

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "Failed tests:"
  for t in "${FAILED_TESTS[@]}"; do
    echo "  - $t"
  done
  exit 1
fi
