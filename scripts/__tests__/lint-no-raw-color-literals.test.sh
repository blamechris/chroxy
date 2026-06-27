#!/usr/bin/env bash
#
# lint-no-raw-color-literals.test.sh — Golden test for the ratchet hex-lint's
# comment-strip recheck (#6441, pinning the #6439 / #6423 fix).
#
# The lint strips // and /* */ comments before its hex re-check so that #NNNN
# issue references (3-4 hex digits) in comments don't false-positive as color
# literals, while real '#222' / '#123456' literals in code still fail. This test
# pins that behaviour so a future regex/recheck tweak can't silently regress it.
#
# Drives the lint against a TEMP scan-root + baseline (LINT_COLOR_SCAN_DIRS /
# LINT_COLOR_BASELINE) so it never mutates real source dirs. No test framework —
# keeps the CI dep surface zero, matching the sibling scripts/__tests__/*.test.sh.
#
# Run from anywhere:  bash scripts/__tests__/lint-no-raw-color-literals.test.sh
# Exit status: 0 if all cases pass, 1 otherwise.
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LINT="$REPO_ROOT/scripts/lint-no-raw-color-literals.sh"

PASS=0
FAIL=0
FAILED=()

# run_lint <scan-dir> <baseline> -> echoes the lint's exit code.
run_lint() {
  LINT_COLOR_SCAN_DIRS="$1" LINT_COLOR_BASELINE="$2" bash "$LINT" >/dev/null 2>&1
  echo $?
}

# check <name> <expected-exit> <actual-exit>
check() {
  if [ "$2" = "$3" ]; then
    PASS=$((PASS + 1)); echo "ok   - $1"
  else
    FAIL=$((FAIL + 1)); FAILED+=("$1 (expected exit $2, got $3)"); echo "NOT  - $1 (expected exit $2, got $3)"
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SCAN="$TMP/scan"; mkdir -p "$SCAN"
BASE="$TMP/baseline.txt"; : > "$BASE"   # empty baseline → any offender is "new"

# Case 1 — #NNNN issue refs in // and /* */ comments must NOT trip the lint
# (the exact #6423 false-positive the comment-strip recheck fixed). #fff/#abcd
# are 3-4 hex digits and would trip the raw pattern, but live only in comments.
cat > "$SCAN/comments-only.tsx" <<'TSX'
// see #6439 and #1234 for context
/* relates to #6423 — looks like #abcd #fff across
   multiple lines */
export const x = 1
TSX
check "#NNNN refs in comments pass" 0 "$(run_lint "$SCAN" "$BASE")"

# Case 2 — real hex literals in code must FAIL (new offender vs empty baseline).
cat > "$SCAN/real-literal.tsx" <<'TSX'
export const bg = '#222'
const border = '#123456'
TSX
check "real hex literal in code fails" 1 "$(run_lint "$SCAN" "$BASE")"

# Case 3 — the same real-literal file, grandfathered into the baseline, passes
# (the ratchet only fails NEW offenders).
printf '%s\n' "$SCAN/real-literal.tsx" > "$BASE"
check "baselined real-literal file passes" 0 "$(run_lint "$SCAN" "$BASE")"

# Case 4 — the production invocation (default scan dirs + committed baseline)
# stays green: pins that the env-override refactor did not change default
# behaviour (the lint cd's to repo root from its own location).
bash "$LINT" >/dev/null 2>&1
check "default invocation (committed baseline) green" 0 "$?"

echo "----"
if [ "$FAIL" -ne 0 ]; then
  echo "FAILED ($FAIL): ${FAILED[*]}"
  exit 1
fi
echo "PASS — all $PASS cases"
