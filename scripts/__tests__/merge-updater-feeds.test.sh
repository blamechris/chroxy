#!/usr/bin/env bash
#
# merge-updater-feeds.test.sh — Self-contained test harness for
# scripts/merge-updater-feeds.mjs.
#
# Runs in a temp dir and writes per-platform Tauri updater feeds, then
# asserts the merged output combines them into a single latest.json with
# all platforms preserved.
#
# Run from repo root:
#   bash scripts/__tests__/merge-updater-feeds.test.sh
#
# Exit status: 0 if all tests pass, 1 otherwise.
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MERGE="$REPO_ROOT/scripts/merge-updater-feeds.mjs"

PASS=0
FAIL=0
FAILED_TESTS=()

# Find a Node binary. Prefer Node 22 (project minimum) when available;
# otherwise fall back to whatever the runner provides.
if [ -x "/opt/homebrew/opt/node@22/bin/node" ]; then
  NODE="/opt/homebrew/opt/node@22/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
else
  echo "FATAL: no node binary found"
  exit 1
fi

assert_eq() {
  local name="$1"
  local expected="$2"
  local actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "  PASS: $name"
  else
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$name")
    echo "  FAIL: $name"
    echo "    expected: $expected"
    echo "    actual:   $actual"
  fi
}

assert_contains() {
  local name="$1"
  local haystack="$2"
  local needle="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    PASS=$((PASS + 1))
    echo "  PASS: $name"
  else
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$name")
    echo "  FAIL: $name (expected to find: $needle)"
    echo "    in: $haystack"
  fi
}

assert_not_contains() {
  local name="$1"
  local haystack="$2"
  local needle="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$name")
    echo "  FAIL: $name (expected NOT to find: $needle)"
    echo "    in: $haystack"
  else
    PASS=$((PASS + 1))
    echo "  PASS: $name"
  fi
}

run_merge() {
  # Run the merge script with provided args, capture stdout.
  "$NODE" "$MERGE" "$@"
}

# ----------------------------------------------------------------------------
# Test: merges two single-platform feeds into one multi-platform feed.
# ----------------------------------------------------------------------------
test_merges_macos_and_windows() {
  echo "TEST: merges macOS and Windows feeds"
  local tmp; tmp="$(mktemp -d)"
  cat >"$tmp/mac.json" <<'JSON'
{
  "version": "v0.9.13",
  "notes": "Release notes",
  "pub_date": "2026-06-01T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "MAC-SIG-AA",
      "url": "https://example.com/mac.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "MAC-SIG-XX",
      "url": "https://example.com/mac.app.tar.gz"
    }
  }
}
JSON

  cat >"$tmp/win.json" <<'JSON'
{
  "version": "v0.9.13",
  "notes": "Release notes",
  "pub_date": "2026-06-01T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "WIN-SIG-XX",
      "url": "https://example.com/chroxy.msi.zip"
    }
  }
}
JSON

  local out
  out="$(run_merge "$tmp/mac.json" "$tmp/win.json" 2>&1)" || {
    FAIL=$((FAIL + 1)); FAILED_TESTS+=("merges_macos_and_windows: exit nonzero"); echo "    out: $out"; return
  }

  assert_contains "contains darwin-aarch64" "$out" '"darwin-aarch64"'
  assert_contains "contains darwin-x86_64"  "$out" '"darwin-x86_64"'
  assert_contains "contains windows-x86_64" "$out" '"windows-x86_64"'
  assert_contains "preserves macOS signature" "$out" 'MAC-SIG-AA'
  assert_contains "preserves windows signature" "$out" 'WIN-SIG-XX'
  assert_contains "preserves top-level version" "$out" '"version": "v0.9.13"'

  rm -rf "$tmp"
}

# ----------------------------------------------------------------------------
# Test: --output flag writes to disk instead of stdout.
# ----------------------------------------------------------------------------
test_writes_to_output_file() {
  echo "TEST: --output flag writes to file"
  local tmp; tmp="$(mktemp -d)"
  cat >"$tmp/mac.json" <<'JSON'
{
  "version": "v0.1.0",
  "notes": "n",
  "pub_date": "2026-01-01T00:00:00Z",
  "platforms": {
    "darwin-aarch64": { "signature": "S", "url": "https://e/x" }
  }
}
JSON

  run_merge --output "$tmp/out.json" "$tmp/mac.json" >/dev/null 2>&1 || {
    FAIL=$((FAIL + 1)); FAILED_TESTS+=("writes_to_output_file: exit nonzero"); return
  }

  if [ -f "$tmp/out.json" ]; then
    local body; body="$(cat "$tmp/out.json")"
    assert_contains "output file has version" "$body" '"version"'
    assert_contains "output file has darwin entry" "$body" '"darwin-aarch64"'
  else
    FAIL=$((FAIL + 1)); FAILED_TESTS+=("writes_to_output_file: file missing")
    echo "  FAIL: writes_to_output_file: $tmp/out.json was not created"
  fi

  rm -rf "$tmp"
}

# ----------------------------------------------------------------------------
# Test: gracefully ignores missing input files (so the workflow can pass a
# glob/path that didn't exist when one of the jobs ran without signing).
# ----------------------------------------------------------------------------
test_skips_missing_inputs() {
  echo "TEST: skips missing input files"
  local tmp; tmp="$(mktemp -d)"
  cat >"$tmp/mac.json" <<'JSON'
{
  "version": "v0.1.0",
  "notes": "n",
  "pub_date": "2026-01-01T00:00:00Z",
  "platforms": {
    "darwin-aarch64": { "signature": "S", "url": "https://e/x" }
  }
}
JSON

  local out
  out="$(run_merge "$tmp/mac.json" "$tmp/does-not-exist.json" 2>&1)" || {
    FAIL=$((FAIL + 1)); FAILED_TESTS+=("skips_missing_inputs: exit nonzero"); echo "    out: $out"; return
  }

  assert_contains "still emits mac platform" "$out" '"darwin-aarch64"'
  assert_not_contains "no windows entry" "$out" '"windows-x86_64"'

  rm -rf "$tmp"
}

# ----------------------------------------------------------------------------
# Test: fails with non-zero exit when called with no inputs.
# ----------------------------------------------------------------------------
test_fails_without_inputs() {
  echo "TEST: fails without inputs"
  if run_merge >/dev/null 2>&1; then
    FAIL=$((FAIL + 1)); FAILED_TESTS+=("fails_without_inputs: should have failed")
    echo "  FAIL: fails_without_inputs (expected nonzero exit)"
  else
    PASS=$((PASS + 1))
    echo "  PASS: fails_without_inputs"
  fi
}

# ----------------------------------------------------------------------------
# Test: fails when all provided files are missing (no platforms collected).
# ----------------------------------------------------------------------------
test_fails_when_all_inputs_missing() {
  echo "TEST: fails when all inputs missing"
  local tmp; tmp="$(mktemp -d)"
  if run_merge "$tmp/nope1.json" "$tmp/nope2.json" >/dev/null 2>&1; then
    FAIL=$((FAIL + 1)); FAILED_TESTS+=("fails_when_all_inputs_missing: should have failed")
    echo "  FAIL: fails_when_all_inputs_missing (expected nonzero exit)"
  else
    PASS=$((PASS + 1))
    echo "  PASS: fails_when_all_inputs_missing"
  fi
  rm -rf "$tmp"
}

# ----------------------------------------------------------------------------
# Test: later platforms override earlier ones for the same key (last wins).
# ----------------------------------------------------------------------------
test_later_input_overrides_same_platform() {
  echo "TEST: later input overrides same platform"
  local tmp; tmp="$(mktemp -d)"
  cat >"$tmp/a.json" <<'JSON'
{
  "version": "v0.1.0",
  "notes": "n",
  "pub_date": "2026-01-01T00:00:00Z",
  "platforms": {
    "darwin-aarch64": { "signature": "OLD", "url": "https://e/old" }
  }
}
JSON

  cat >"$tmp/b.json" <<'JSON'
{
  "version": "v0.1.0",
  "notes": "n",
  "pub_date": "2026-01-01T00:00:00Z",
  "platforms": {
    "darwin-aarch64": { "signature": "NEW", "url": "https://e/new" }
  }
}
JSON

  local out
  out="$(run_merge "$tmp/a.json" "$tmp/b.json" 2>&1)" || {
    FAIL=$((FAIL + 1)); FAILED_TESTS+=("later_input_overrides_same_platform: exit nonzero"); return
  }

  assert_contains "has NEW signature" "$out" 'NEW'
  assert_not_contains "OLD signature is gone" "$out" '"signature": "OLD"'
  rm -rf "$tmp"
}

# Run all tests.
test_merges_macos_and_windows
test_writes_to_output_file
test_skips_missing_inputs
test_fails_without_inputs
test_fails_when_all_inputs_missing
test_later_input_overrides_same_platform

echo
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "Failed tests:"
  for t in "${FAILED_TESTS[@]}"; do
    echo "  - $t"
  done
  exit 1
fi
exit 0
