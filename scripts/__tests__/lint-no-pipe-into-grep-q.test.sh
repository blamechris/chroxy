#!/usr/bin/env bash
#
# lint-no-pipe-into-grep-q.test.sh — Golden test for the producer-into-grep-q
# guard (#7907).
#
# #7907: under `set -o pipefail`, `echo/printf/cat "$x" | grep -q PATTERN` can
# report "not found" when PATTERN genuinely is present — grep -q exits on its
# first match without draining the rest of its stdin, and if the producer is
# still writing when that happens, pipefail promotes the producer's SIGPIPE
# write error into the whole pipeline's exit status. #7908 fixed the two test
# harnesses that had this shape; this issue fixed the production sites
# (scripts/bump-version.sh x2, scripts/docker-entrypoint.sh,
# scripts/require-review-before-merge.sh — the pre-merge review gate,
# packages/desktop/scripts/verify-entitlements.sh, and
# scripts/lint-no-raw-color-literals.sh) and this lint is the structural guard
# against the shape reappearing anywhere else tracked.
#
# Drives the lint against TEMP trees via LINT_PIPE_GREP_Q_SCAN_DIR so it never
# depends on — or mutates — real repo state. No test framework — matches the
# sibling scripts/__tests__/*.test.sh harnesses.
#
# Note on fixture-writing: several cases below WRITE a literal
# "producer | grep -q" line into a throwaway fixture file. That literal text
# is assembled from a $PIPE variable rather than typed as a contiguous
# `producer | grep -q` substring in THIS file's own source — if it were typed
# literally, this harness (which itself enables pipefail below) would trip the
# very lint it is testing when the repo's own Scripts Tests job scans
# scripts/__tests__/*.sh.
#
# Run from anywhere:  bash scripts/__tests__/lint-no-pipe-into-grep-q.test.sh
# Exit status: 0 if all cases pass, 1 otherwise.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LINT="$REPO_ROOT/scripts/lint-no-pipe-into-grep-q.sh"

# Every case below must run. Without this, a harness whose cases stop executing
# prints "PASS — all 0 cases" and exits 0 — "all cases passed" and "no case
# executed" are the same observable outcome, the second recurring cause in
# docs/false-safety-guards.md (#7653). Asserted EQUAL, not -ge, so removing a
# case is as loud as skipping one.
EXPECTED_CASES=12

PASS=0
FAIL=0
FAILED=()

# The literal pipe character, indirected through a variable — see the note in
# the header above.
PIPE='|'

run_lint() {
  LINT_PIPE_GREP_Q_SCAN_DIR="$1" bash "$LINT" >/tmp/lint-no-pipe-into-grep-q.out 2>&1
  echo $?
}

check() {
  if [ "$2" = "$3" ]; then
    PASS=$((PASS + 1)); echo "ok   - $1"
  else
    FAIL=$((FAIL + 1)); FAILED+=("$1 (expected exit $2, got $3)")
    echo "NOT  - $1 (expected exit $2, got $3)"
    sed 's/^/       /' /tmp/lint-no-pipe-into-grep-q.out
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- Case 1 — a clean tree of only SAFE forms passes ------------------------
SAFE_DIR="$TMP/safe"; mkdir -p "$SAFE_DIR"
{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  echo ''
  echo '# File-backed forms — a small, single-shot read cannot race.'
  echo 'grep -q x "$f"'
  echo "head -1 \"\$f\" $PIPE grep -q pattern"
  echo "awk '{print}' \"\$f\" $PIPE grep -qx line"
  echo "ps aux $PIPE grep -q name"
  echo "curl -s \"\$url\" $PIPE grep -q '\"status\":\"ok\"'"
  echo ''
  echo '# The actual FIX shape — here-strings, no producer process at all.'
  echo "grep -q 'pr merge' <<<\"\$COMMAND\""
  echo "grep -qE '^[0-9]+\\.[0-9]+\\.[0-9]+\$' <<<\"\$NEW_VERSION\""
} > "$SAFE_DIR/safe.sh"
check "a tree of only safe forms (file-backed + here-string) passes" 0 "$(run_lint "$SAFE_DIR")"

# --- Case 2 — the core positive control: a basic offense fails --------------
BASIC_DIR="$TMP/basic"; mkdir -p "$BASIC_DIR"
{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  echo "echo \"\$a\" $PIPE grep -q needle"
} > "$BASIC_DIR/bad.sh"
check "echo-into-grep-q in a pipefail script FAILS (core positive control)" 1 "$(run_lint "$BASIC_DIR")"

# --- Case 3 — flag/spacing variations are all caught, not just a bare -q ----
# #7908's own widening: -Eq, -qF, --quiet, no-space pipe, and options BEFORE
# -q (-E -q) all reintroduce the identical race and must all be caught.
VARIANTS_DIR="$TMP/variants"; mkdir -p "$VARIANTS_DIR"
{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  echo "echo \"\$a\"${PIPE}grep -q needle1"
  echo "printf '%s' \"\$b\" $PIPE grep -Eq needle2"
  echo "printf '%s' \"\$c\" $PIPE grep -qF needle3"
  echo "cat \"\$d\" $PIPE grep -q needle4"
  echo "echo \"\$e\" $PIPE grep --quiet needle5"
  echo "echo \"\$f\" $PIPE grep -E -q needle6"
} > "$VARIANTS_DIR/bad.sh"
check "flag/spacing variations (-Eq, -qF, --quiet, no-space, -E -q) all FAIL" 1 "$(run_lint "$VARIANTS_DIR")"

# --- Case 4 — file-backed forms alone must NOT be flagged (no over-reach) ---
FILEBACKED_DIR="$TMP/filebacked"; mkdir -p "$FILEBACKED_DIR"
{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  echo 'grep -q x "$f"'
  echo "head -1 \"\$f\" $PIPE grep -q pattern"
  echo "awk '{print}' \"\$f\" $PIPE grep -qx line"
} > "$FILEBACKED_DIR/ok.sh"
check "file-backed forms (grep -q x \"\$f\", head|grep -q, awk|grep -q) are NOT flagged" 0 "$(run_lint "$FILEBACKED_DIR")"

# --- Case 5 — a non-echo/printf/cat producer (curl) is NOT flagged ----------
# Documented scope limit: curl/head/awk read a small, single-shot, or
# externally-sourced stream and are out of scope by design (see the lint's
# own header comment).
CURL_DIR="$TMP/curl"; mkdir -p "$CURL_DIR"
{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  echo "curl -s \"\$url\" $PIPE grep -q 'ok'"
} > "$CURL_DIR/ok.sh"
check "a curl-into-grep-q pipe (non echo/printf/cat producer) is NOT flagged" 0 "$(run_lint "$CURL_DIR")"

# --- Case 6 — a script that never enables pipefail is out of scope ----------
# The identical unsafe shape, in a script with only `set -e`, cannot exhibit
# this failure mode (pipefail is what promotes the producer's SIGPIPE to the
# pipeline's exit status) and must not be scanned.
NOPIPEFAIL_DIR="$TMP/nopipefail"; mkdir -p "$NOPIPEFAIL_DIR"
{
  echo '#!/usr/bin/env bash'
  echo 'set -e'
  echo "echo \"\$a\" $PIPE grep -q needle"
} > "$NOPIPEFAIL_DIR/ok.sh"
check "a script without pipefail is out of scope even with the unsafe shape" 0 "$(run_lint "$NOPIPEFAIL_DIR")"

# --- Case 7 — a comment-only mention of the shape is NOT flagged -----------
# This file's own header (above) and #7908's harnesses document the buggy
# shape in prose; a full-comment line must never be mistaken for a finding.
COMMENT_DIR="$TMP/comment"; mkdir -p "$COMMENT_DIR"
{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  echo "# example of the bad shape: echo \"\$x\" $PIPE grep -q PATTERN"
  echo 'grep -q x "$f"'
} > "$COMMENT_DIR/ok.sh"
check "a comment-only mention of the shape is NOT flagged" 0 "$(run_lint "$COMMENT_DIR")"

# --- Case 8 — allowlist comment on the line ABOVE suppresses a real match ---
ALLOW_ABOVE_DIR="$TMP/allow_above"; mkdir -p "$ALLOW_ABOVE_DIR"
{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  echo '# lint-ignore-pipe-grep-q: reviewed, bounded fixture producer, cannot race'
  echo "echo \"\$a\" $PIPE grep -q needle"
} > "$ALLOW_ABOVE_DIR/ok.sh"
check "an allowlist comment on the line above suppresses the finding" 0 "$(run_lint "$ALLOW_ABOVE_DIR")"

# --- Case 9 — allowlist comment TRAILING on the same line suppresses too ---
ALLOW_TRAILING_DIR="$TMP/allow_trailing"; mkdir -p "$ALLOW_TRAILING_DIR"
{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  echo "echo \"\$a\" $PIPE grep -q needle  # lint-ignore-pipe-grep-q: reviewed"
} > "$ALLOW_TRAILING_DIR/ok.sh"
check "a trailing allowlist comment on the same line suppresses the finding" 0 "$(run_lint "$ALLOW_TRAILING_DIR")"

# --- Case 10 — reintroducing the review-gate's exact shape fails -----------
# The literal #7907 acceptance bar: reintroducing ONE fixed site must turn
# the lint red.
REGRESSION_DIR="$TMP/regression"; mkdir -p "$REGRESSION_DIR"
{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  echo "if ! echo \"\$COMMAND\" $PIPE grep -q 'pr merge'; then"
  echo '  exit 0'
  echo 'fi'
} > "$REGRESSION_DIR/require-review-before-merge.sh"
check "reintroducing the review-gate's exact pre-fix shape FAILS" 1 "$(run_lint "$REGRESSION_DIR")"

# --- Case 11 — the lint's own source file does not self-match --------------
# Verified property (not just asserted): the PAT variable's own definition
# line contains literal '|' characters as regex metacharacters, not as real
# shell pipe syntax next to echo/printf/cat — confirm the lint agrees when
# scanning ITS OWN directory.
SELF_DIR="$TMP/self"; mkdir -p "$SELF_DIR"
cp "$LINT" "$SELF_DIR/"
check "the lint's own source file does not self-match its own pattern" 0 "$(run_lint "$SELF_DIR")"

# --- Case 12 — zero *.sh files found is a loud failure, not a silent pass --
# An enumeration that finds nothing to scan must not report the same "OK" as
# a genuinely clean tree — same shape as #7504/#7646's file-enumeration class.
EMPTY_DIR="$TMP/empty"; mkdir -p "$EMPTY_DIR"
check "an empty scan dir (nothing to scan) exits 2, not a silent 0" 2 "$(run_lint "$EMPTY_DIR")"

echo "----"
BROKEN=0
if [ "$FAIL" -ne 0 ]; then
  echo "FAILED ($FAIL): ${FAILED[*]}"
  BROKEN=1
fi
if [ "$((PASS + FAIL))" -ne "$EXPECTED_CASES" ]; then
  echo "HARNESS BROKEN: ran $((PASS + FAIL)) cases, expected $EXPECTED_CASES — a case stopped executing"
  BROKEN=1
fi
[ "$BROKEN" -eq 0 ] || exit 1
echo "PASS — all $PASS cases"
