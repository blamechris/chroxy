#!/usr/bin/env bash
#
# lint-thinking-level-roster.test.sh — golden test for the second-roster guard (#7730).
#
# The guard's whole job is to fire on a SECOND literal list of thinking levels,
# so it needs a positive control: a lint that never fires and a clean repo are
# the same observable outcome, which is the false-safety shape this repo keeps
# getting bitten by. The specific failures being controlled for here are the
# ones the sibling guards actually hit — a filter whose terms match nothing
# (#7503), and a harness that reports success over ZERO cases (#7653).
#
# Cases:
#   1. a clean tree passes
#   2. an array literal of levels FAILS — the mutation the issue names
#      (re-introducing the store-core `new Set([...])`)
#   3. a TS union of levels FAILS (the dashboard type + the two casts)
#   4. a z.enum of levels FAILS (the protocol schema)
#   5. a codex-flavoured roster (low/medium/high/xhigh) FAILS — the guard is
#      about "a literal list of levels", not about the Claude three
#   6. a lone `'default'` fallback PASSES — `level || 'default'` is not a
#      roster, and a guard that denies everything passes a naive negative test
#      just as surely as one that denies nothing (#7273)
#   7. a TEST file carrying the roster PASSES — deliberate: a test must be free
#      to write the triple by hand rather than deriving its expectation from the
#      constant under test (#7424)
#   8. the min-files floor FAILS a scan that walked too few files — the guard
#      must not report "clean" because it found nothing to look at
#   9. the production invocation over the real repo stays green
#  10. a file the scan could NOT OPEN fails, and does NOT count toward the
#      floor. Counting an unreadable file would let the floor — the check whose
#      only job is to catch a scan that reached nothing — be satisfied by files
#      nothing was read from (#7195/#7210, #7783). This case can only be built
#      as a non-root user, so it SKIPS loudly rather than passing when it
#      cannot be constructed: a case that reports success without running is
#      the shape being guarded against.
#
# Drives the lint against a TEMP tree via LINT_THINKING_SCAN_DIR so it never
# depends on repo state. No test framework — matches the sibling
# scripts/__tests__/*.test.sh.
#
# Run from anywhere:  bash scripts/__tests__/lint-thinking-level-roster.test.sh
# Exit status: 0 if all cases pass, 1 otherwise.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LINT="$REPO_ROOT/scripts/lint-thinking-level-roster.sh"

# Asserted EQUAL, not -ge, so removing a case is as loud as skipping one.
EXPECTED_CASES=10

PASS=0
FAIL=0
SKIP=0
FAILED=()

# run_lint <scan-dir> [min-files] -> echoes the lint's exit code.
run_lint() {
  LINT_THINKING_SCAN_DIR="$1" LINT_THINKING_MIN_FILES="${2:-1}" bash "$LINT" >/dev/null 2>&1
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
SCAN="$TMP/scan"; mkdir -p "$SCAN/src" "$SCAN/tests"

# Case 1 — a clean tree passes. Two files so the min-files floor of 1 is met by
# real content rather than by an accident of counting.
printf "export const x = 1\n" > "$SCAN/src/clean.ts"
printf "export const y = 2\n" > "$SCAN/src/clean2.ts"
check "clean tree passes" 0 "$(run_lint "$SCAN")"

# Case 2 — THE mutation the issue names: the store-core Set, restored.
printf "const VALID = new Set(['default', 'high', 'max'])\n" > "$SCAN/src/roster.ts"
check "an array literal of levels fails (the store-core Set)" 1 "$(run_lint "$SCAN")"
rm -f "$SCAN/src/roster.ts"

# Case 3 — the dashboard union type and the two `as` casts share this shape.
printf "export type L = 'default' | 'high' | 'max'\n" > "$SCAN/src/union.ts"
check "a TS union of levels fails (the dashboard type + casts)" 1 "$(run_lint "$SCAN")"
rm -f "$SCAN/src/union.ts"

# Case 4 — the protocol schema's enum.
printf "const S = z.enum(['default','high','max'])\n" > "$SCAN/src/enum.ts"
check "a z.enum of levels fails (the protocol schema)" 1 "$(run_lint "$SCAN")"
rm -f "$SCAN/src/enum.ts"

# Case 5 — the guard is about literal level ROSTERS, not about the Claude
# three. A codex-flavoured list is the same defect with different words, and
# would be the obvious way to "fix" a codex bug by hardcoding.
printf "const EFFORTS = ['low', 'medium', 'high', 'xhigh']\n" > "$SCAN/src/codex.ts"
check "a codex-flavoured roster fails too" 1 "$(run_lint "$SCAN")"
rm -f "$SCAN/src/codex.ts"

# Case 6 — the negative control that makes the others mean something. A check
# that denies EVERYTHING passes cases 2-5 exactly as well as a correct one, so
# an ordinary single-value fallback must stay legal.
printf "const level = incoming || 'default'\nconst other = ['approve', 'auto', 'plan']\n" > "$SCAN/src/fallback.ts"
check "a lone 'default' fallback passes (and an unrelated string list does too)" 0 "$(run_lint "$SCAN")"
rm -f "$SCAN/src/fallback.ts"

# Case 7 — tests are out of scope on purpose; see the lint header.
printf "expect(levels).toEqual(['default', 'high', 'max'])\n" > "$SCAN/tests/roster.test.ts"
check "a roster inside a test file passes (tests write the triple by hand)" 0 "$(run_lint "$SCAN")"
rm -f "$SCAN/tests/roster.test.ts"

# Case 8 — fail-closed on a scan that walked too little. The two files in the
# tree are real and clean, so ONLY the floor can fail this: it proves the
# "scanned enough to mean anything" check is live, not merely present.
check "a scan below the min-files floor fails" 1 "$(run_lint "$SCAN" 50)"

# Case 9 — production invocation over the real git index stays green.
bash "$LINT" >/dev/null 2>&1
check "default invocation (real repo) green" 0 "$?"

# Case 10 — a file that could not be OPENED must fail the lint, and must not be
# counted toward the min-files floor. The floor is set to 3 here while the tree
# holds exactly two readable files plus the unreadable one: a build that counts
# the unreadable file reaches 3 and reports a clean repo, one that does not
# reaches 2. Either way this case demands exit 1, so it reds on BOTH the
# swallowed-open bug and a regression that stops reporting it.
UNREADABLE="$SCAN/src/unreadable.ts"
printf "export const z = 3\n" > "$UNREADABLE"
chmod 000 "$UNREADABLE" 2>/dev/null || true
if [ -r "$UNREADABLE" ] || cat "$UNREADABLE" >/dev/null 2>&1; then
  # Running as root (or on a filesystem that ignores the mode) — the case
  # cannot be constructed. Say so; never count it as a pass.
  SKIP=$((SKIP + 1))
  echo "SKIP - an unreadable file fails the scan (cannot make a file unreadable as uid $(id -u))"
else
  check "an unreadable file fails the scan and does not count toward the floor" 1 "$(run_lint "$SCAN" 3)"
fi
chmod 644 "$UNREADABLE" 2>/dev/null || true
rm -f "$UNREADABLE"

echo "----"
BROKEN=0
if [ "$FAIL" -ne 0 ]; then
  echo "FAILED ($FAIL): ${FAILED[*]}"
  BROKEN=1
fi
if [ "$((PASS + FAIL + SKIP))" -ne "$EXPECTED_CASES" ]; then
  echo "HARNESS BROKEN: ran $((PASS + FAIL + SKIP)) cases, expected $EXPECTED_CASES — a case stopped executing"
  BROKEN=1
fi
[ "$BROKEN" -eq 0 ] || exit 1
if [ "$SKIP" -ne 0 ]; then
  echo "PASS — $PASS cases, $SKIP SKIPPED (see the SKIP lines above; a skip is not a pass)"
else
  echo "PASS — all $PASS cases"
fi
