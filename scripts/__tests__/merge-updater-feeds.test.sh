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

# Every case below must run. Without this, a harness whose cases stop executing
# prints "Results: 0 passed, 0 failed" and exits 0 — "all cases passed" and "no
# case executed" are the same observable outcome, the second recurring cause in
# docs/false-safety-guards.md (#7653). Asserted EQUAL, not -ge, so removing a
# case is as loud as skipping one.
#
# This suite is the sharpest instance in the repo: its subject is the release
# updater-feed merge, and it already ran in NO workflow for its whole life
# (#7504). A silently-empty run here restores exactly the blind spot that closed.
#
# THE COUNT IS OUTCOME-INDEPENDENT, and #7656 is what made it so.
#
# Four of the six test functions used to short-circuit on a run_merge failure
# (`|| { FAIL++; return; }`), skipping the asserts that followed. A genuine
# SUBJECT regression therefore dropped the count below 14 as well as raising
# FAIL, and the run's headline became "HARNESS BROKEN … a case stopped
# executing" — the wrong diagnosis, and this was the only harness in the repo
# where the two could be confused. Measured before the fix: pointing MERGE at a
# script that exits 3 gave "ran 6 cases, expected 14" alongside the real
# failures.
#
# Each of those four now ASSERTS the exit code and lets its remaining asserts
# run. The trade-off is stated because it is real and was the reason #7653 did
# not fold this in: one subject regression now reports six failures instead of
# one. Every one of them is TRUE — the output really does lack the strings —
# and the count stays fixed either way (currently 23; see #7892 below for why
# it moved from 19), so the floor's message is now always accurate about which
# thing broke.
EXPECTED_CASES=23

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

# Both helpers below test membership with a here-string (`<<<`), never a pipe
# (`producer | grep -q`). This harness runs under `set -uo pipefail` (line
# 15). grep -q exits the instant it finds a match, without draining the rest
# of its stdin; if the producer (`printf`) is still writing when that
# happens, the kernel delivers SIGPIPE to it, and pipefail promotes that
# broken-pipe write error into the whole PIPELINE's exit status — even though
# grep itself matched. That is not hypothetical: PR #7892's CI run failed
# exactly this way —
#   scripts/__tests__/merge-updater-feeds.test.sh: line 84: printf: write
#   error: Broken pipe
#     FAIL: preserves top-level version (expected to find: "version":
#     "v0.9.13")
#       in: { "version": "v0.9.13", ... }
# — the needle WAS in the haystack; assert_contains reported FAIL anyway. The
# same corruption makes assert_not_contains flake GREEN when the forbidden
# text IS present (fail-open — success and not-checking become the same
# observable outcome, docs/false-safety-guards.md's defining shape). A
# here-string hands grep the data directly with no separate writer process,
# so there's nothing for a SIGPIPE to land on. See
# test_grep_helpers_survive_pipefail_sigpipe below for the reproduction.
assert_contains() {
  local name="$1"
  local haystack="$2"
  local needle="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
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
  if grep -qF -- "$needle" <<<"$haystack"; then
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

  local out rc
  out="$(run_merge "$tmp/mac.json" "$tmp/win.json" 2>&1)"; rc=$?
  assert_eq "merges_macos_and_windows: merge exits 0" 0 "$rc"
  [ "$rc" -eq 0 ] || echo "    out: $out"

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

  local rc
  # Captured rather than discarded to /dev/null: on a non-zero exit the output is
  # the only clue why, and every other run_merge case prints it (Copilot, #7683).
  out="$(run_merge --output "$tmp/out.json" "$tmp/mac.json" 2>&1)"; rc=$?
  assert_eq "writes_to_output_file: merge exits 0" 0 "$rc"
  [ "$rc" -eq 0 ] || echo "    out: $out"

  # This BRANCH contributes three cases on both paths (existence + two content
  # asserts), where it used to contribute two when the file existed and one when
  # it did not — the same outcome-dependence #7656 is about, hiding inside a
  # conditional rather than in an early return. The function as a whole
  # contributes FOUR, counting the exit-code assert above; the three here is the
  # branch, not the test. Measured: after the four early returns were fixed a
  # subject regression still landed on 17 of 18, one short, and this was it.
  # Reading an absent file as an empty body lets the same asserts run and fail
  # truthfully.
  local body=""
  local exists="no"
  if [ -f "$tmp/out.json" ]; then
    exists="yes"
    body="$(cat "$tmp/out.json")"
  fi
  assert_eq "writes_to_output_file: output file exists" "yes" "$exists"
  assert_contains "output file has version" "$body" '"version"'
  assert_contains "output file has darwin entry" "$body" '"darwin-aarch64"'

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

  local out rc
  out="$(run_merge "$tmp/mac.json" "$tmp/does-not-exist.json" 2>&1)"; rc=$?
  assert_eq "skips_missing_inputs: merge exits 0" 0 "$rc"
  [ "$rc" -eq 0 ] || echo "    out: $out"

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

  local out rc
  out="$(run_merge "$tmp/a.json" "$tmp/b.json" 2>&1)"; rc=$?
  assert_eq "later_input_overrides_same_platform: merge exits 0" 0 "$rc"
  [ "$rc" -eq 0 ] || echo "    out: $out"

  assert_contains "has NEW signature" "$out" 'NEW'
  assert_not_contains "OLD signature is gone" "$out" '"signature": "OLD"'
  rm -rf "$tmp"
}

# ----------------------------------------------------------------------------
# Self-test: assert_contains / assert_not_contains must survive SIGPIPE under
# `set -o pipefail` (#7892 — see the comment above assert_contains).
#
# A single big `printf '%s' "$var" | grep -q` does not reliably reproduce the
# race on macOS — measured: XNU's pipe write() auto-grows to hold one atomic
# write whole, clean past 50MB in a single call, on this host. The race needs
# the producer to still be writing in SEPARATE syscalls when grep -q exits —
# the same shape real command output takes (built up incrementally) — so the
# haystack below is built the same way: many small writes, the needle in the
# very first one, and a total size well past either platform's fixed pipe
# buffer (16KB macOS / 64KB+ Linux). Measured 10/10 reproductions at ~394KB.
# ----------------------------------------------------------------------------
test_grep_helpers_survive_pipefail_sigpipe() {
  echo "TEST: assert_contains/assert_not_contains survive SIGPIPE under pipefail (#7892)"

  local needle="SIGPIPE-SELFTEST-NEEDLE-AT-START"
  local pad_line="pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp"

  emit_sigpipe_selftest_haystack() {
    printf '%s\n' "$needle"
    local i=0
    while [ "$i" -lt 2000 ]; do
      printf '%s\n' "$pad_line"
      i=$((i + 1))
    done
  }

  # --- Prove the OLD (piped) shape really was broken. Kept ONLY here as
  # evidence — assert_contains/assert_not_contains above no longer pipe a
  # variable into grep. This is supporting evidence for the fix asserted
  # below, not itself the thing under test: a kernel/runner whose pipe
  # buffering doesn't race on this exact haystack shape is an environmental
  # non-repro, not a defect, so it counts as PASS either way (the fixed-form
  # assertions below are what actually gate this test).
  if emit_sigpipe_selftest_haystack | grep -qF -- "$needle" 2>/dev/null; then
    PASS=$((PASS + 1))
    echo "  PASS: NOTE — old piped grep -q form found the needle cleanly on this host; could not reproduce the SIGPIPE race here (environment-dependent, not a failure)"
  else
    PASS=$((PASS + 1))
    echo "  PASS: old piped grep -q form IS corrupted by SIGPIPE under pipefail (needle WAS present; reported as not found) — reproduces PR #7892's failure"
  fi

  # --- Prove the FIXED helpers get the exact same input right.
  local haystack
  haystack="$(emit_sigpipe_selftest_haystack)"
  assert_contains "grep_helpers_survive_pipefail_sigpipe: fixed assert_contains finds a needle at the start of a >128KB haystack" "$haystack" "$needle"
  assert_not_contains "grep_helpers_survive_pipefail_sigpipe: fixed assert_not_contains correctly reports a genuinely absent needle" "$haystack" "NEEDLE-THAT-IS-NOT-PRESENT-XYZ"
}

# ----------------------------------------------------------------------------
# Static guard: no `echo`/`printf` capturing a shell variable and piping it
# into an early-exiting `grep -q` (the shape this file used to have at
# assert_contains/assert_not_contains) may remain in this file's CODE.
# Comment lines (this file quotes the buggy shape as documentation above) are
# excluded so the guard cannot flag its own prose.
#
# Scope: this only matches `echo`/`printf` producers — the only shape this
# file ever had (a captured shell variable re-emitted and piped straight into
# grep). If a future site pipes a large captured variable through some other
# producer into a `-q`-flavored grep, add that producer name here.
#
# The pipe and the grep invocation are matched loosely on purpose: `\|[[:space:]]*grep`
# tolerates zero spaces or a tab around the pipe (`echo "$x"|grep -q`), and
# `-[A-Za-z]*q[A-Za-z]*|--quiet` matches -q with -q in ANY position among other
# short flags (-Eq, -qF, -iq, -Fq, ...) or --quiet — not just a bare `-q`. A
# flag-order variation is exactly the kind of edit someone reaches for without
# thinking of it as touching this pattern (e.g. switching to -Eq for a real
# regex needle), and the earlier literal `grep -q` substring match let every
# one of those through.
# ----------------------------------------------------------------------------
test_no_unsafe_grep_pipe_pattern_remains() {
  echo "TEST: no unsafe producer-piped-into-grep pattern remains in this file"
  local self="$REPO_ROOT/scripts/__tests__/merge-updater-feeds.test.sh"
  local hits
  hits="$(grep -vE '^[[:space:]]*#' "$self" | grep -E '(echo|printf)[^|]*\|[[:space:]]*grep[[:space:]]+(-[A-Za-z]*q[A-Za-z]*|--quiet)' || true)"
  if [ -n "$hits" ]; then
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("no_unsafe_grep_pipe_pattern_remains")
    echo "  FAIL: found unsafe pipe-into-grep pattern(s):"
    echo "$hits"
  else
    PASS=$((PASS + 1))
    echo "  PASS: no unsafe pipe-into-grep pattern remains"
  fi
}

# Run all tests.
test_merges_macos_and_windows
test_writes_to_output_file
test_skips_missing_inputs
test_fails_without_inputs
test_fails_when_all_inputs_missing
test_later_input_overrides_same_platform
test_grep_helpers_survive_pipefail_sigpipe
test_no_unsafe_grep_pipe_pattern_remains

echo
echo "Results: $PASS passed, $FAIL failed"
BROKEN=0
if [ "$FAIL" -gt 0 ]; then
  echo "Failed tests:"
  for t in "${FAILED_TESTS[@]}"; do
    echo "  - $t"
  done
  BROKEN=1
fi
if [ "$((PASS + FAIL))" -ne "$EXPECTED_CASES" ]; then
  echo "HARNESS BROKEN: ran $((PASS + FAIL)) cases, expected $EXPECTED_CASES — a case stopped executing"
  BROKEN=1
fi
[ "$BROKEN" -eq 0 ] || exit 1
exit 0
