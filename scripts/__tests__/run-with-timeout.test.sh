#!/usr/bin/env bash
#
# run-with-timeout.test.sh — tests for scripts/lib/run-with-timeout.sh (#8145).
#
# scripts/docker-image-smoke.sh called bare `timeout` throughout while its own
# header claimed the script "runs locally the same way" as CI. Neither a
# stock macOS nor its Homebrew `coreutils` cask installs a bare `timeout`
# (coreutils prefixes it `gtimeout` on purpose, to avoid shadowing BSD's own
# utilities) — so every bounded call in that script failed with exit 127 on
# this Mac, and the exit-127-vs-124 handling downstream read that as an
# internal scan error rather than what it actually was: the bound itself
# never ran. run_with_timeout() replaces every direct `timeout` call with a
# small wrapper that falls back through `timeout` -> `gtimeout` -> a `perl`
# alarm/exec implementation, and this harness proves each of the three things
# that matter about it:
#
#   1. it returns the command's own exit code;
#   2. it returns 124 on a timeout (scripts/docker-image-smoke.sh's own
#      `import_rc -ne 124` check relies on this exact convention);
#   3. the perl fallback path specifically works, forced by a PATH with
#      neither `timeout` nor `gtimeout` on it.
#
# No external test framework — same zero-dep convention as
# docker-entrypoint.test.sh / bump-version.test.sh.
#
# Run from repo root:
#   bash scripts/__tests__/run-with-timeout.test.sh
#
# Exit status: 0 if all tests pass, 1 otherwise.
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="$REPO_ROOT/scripts/lib/run-with-timeout.sh"

# Every case below must run. Without this, a harness whose cases stop
# executing prints "passed: 0  failed: 0" and exits 0 — "all cases passed" and
# "no case executed" are the same observable outcome (#7653).
EXPECTED_CASES=7

PASS=0
FAIL=0
FAILED_TESTS=()

pass() { PASS=$((PASS + 1)); echo "  ok   - $1"; }
fail() {
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("$1")
  echo "  FAIL - $1"
  [ -n "${2:-}" ] && echo "         $2"
}

echo "run-with-timeout.sh (#8145)"

# A PATH with only what every case here needs (a shell, perl, and the plain
# coreutils `true`/`false`/`sleep`) and specifically NEITHER `timeout` NOR
# `gtimeout` — this is what forces cases 5-7 down the perl fallback, and it
# is also representative of a stock macOS dev machine, which is the whole
# reason this file exists.
NO_TIMEOUT_PATH="/usr/bin:/bin"

# --- 1. Passthrough: a successful command's exit code (0) ------------------
out=$(env -i PATH="$PATH" HOME="$HOME" bash -c "source '$LIB'; run_with_timeout 5 true"; echo "rc=$?")
rc="${out##*rc=}"
if [ "$rc" = "0" ]; then
  pass "returns 0 for a command that exits 0"
else
  fail "returns 0 for a command that exits 0" "got rc='$rc'"
fi

# --- 2. Passthrough: a failing command's own nonzero exit code -------------
out=$(env -i PATH="$PATH" HOME="$HOME" bash -c "source '$LIB'; run_with_timeout 5 bash -c 'exit 7'"; echo "rc=$?")
rc="${out##*rc=}"
if [ "$rc" = "7" ]; then
  pass "returns the command's own exit code (7), not a fixed value"
else
  fail "returns the command's own exit code (7), not a fixed value" "got rc='$rc'"
fi

# --- 3. Timeout: exit 124, under whichever backend is on the real PATH -----
start=$(date +%s)
env -i PATH="$PATH" HOME="$HOME" bash -c "source '$LIB'; run_with_timeout 1 sleep 5"
rc=$?
elapsed=$(( $(date +%s) - start ))
if [ "$rc" -eq 124 ] && [ "$elapsed" -lt 5 ]; then
  pass "returns 124 on a timeout (backend: whatever the real PATH provides)"
else
  fail "returns 124 on a timeout (backend: whatever the real PATH provides)" "rc=$rc elapsed=${elapsed}s"
fi

# --- 4. CONTROL: the same command does NOT time out with a longer bound ----
# Without this, a wrapper that always returned 124 would pass case 3 for the
# wrong reason.
env -i PATH="$PATH" HOME="$HOME" bash -c "source '$LIB'; run_with_timeout 5 sleep 0.1"
rc=$?
if [ "$rc" -eq 0 ]; then
  pass "CONTROL: a command that finishes well inside the bound does not report 124"
else
  fail "CONTROL: a command that finishes well inside the bound does not report 124" "got rc=$rc"
fi

# --- 5-7. Forced perl fallback: PATH carries neither timeout nor gtimeout --
found="$(env -i PATH="$NO_TIMEOUT_PATH" HOME="$HOME" bash -c 'command -v timeout; command -v gtimeout' 2>/dev/null)"
if [ -z "$found" ]; then
  pass "forced-fallback setup: NO_TIMEOUT_PATH has neither timeout nor gtimeout"
else
  fail "forced-fallback setup: NO_TIMEOUT_PATH ($NO_TIMEOUT_PATH) unexpectedly resolves one of them" \
       "found: $found — adjust NO_TIMEOUT_PATH for this host"
fi

out=$(env -i PATH="$NO_TIMEOUT_PATH" HOME="$HOME" bash -c "source '$LIB'; run_with_timeout 5 true"; echo "rc=$?")
rc="${out##*rc=}"
if [ "$rc" = "0" ]; then
  pass "perl fallback: returns 0 for a command that exits 0"
else
  fail "perl fallback: returns 0 for a command that exits 0" "got rc='$rc' out='$out'"
fi

start=$(date +%s)
env -i PATH="$NO_TIMEOUT_PATH" HOME="$HOME" bash -c "source '$LIB'; run_with_timeout 1 sleep 5"
rc=$?
elapsed=$(( $(date +%s) - start ))
if [ "$rc" -eq 124 ] && [ "$elapsed" -lt 5 ]; then
  pass "perl fallback: returns 124 on a timeout, forced by a PATH without timeout/gtimeout"
else
  fail "perl fallback: returns 124 on a timeout, forced by a PATH without timeout/gtimeout" \
       "rc=$rc elapsed=${elapsed}s"
fi

echo ""
echo "passed: $PASS  failed: $FAIL"
BROKEN=0
if [ "$FAIL" -gt 0 ]; then
  for t in "${FAILED_TESTS[@]}"; do echo "  - $t"; done
  BROKEN=1
fi
if [ "$((PASS + FAIL))" -ne "$EXPECTED_CASES" ]; then
  echo "HARNESS BROKEN: ran $((PASS + FAIL)) cases, expected $EXPECTED_CASES — a case stopped executing"
  BROKEN=1
fi
[ "$BROKEN" -eq 0 ] || exit 1
exit 0
