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
#  10. a file the scan could NOT OPEN fails BY NAME, and does NOT count toward
#      the floor. Counting an unreadable file would let the floor — the check whose
#      only job is to catch a scan that reached nothing — be satisfied by files
#      nothing was read from (#7195/#7210, #7783). This case can only be built
#      as a non-root user, so it SKIPS loudly rather than passing when it
#      cannot be constructed: a case that reports success without running is
#      the shape being guarded against.
#  11. the PRODUCTION `git ls-files` path, in a throwaway git repo: a clean
#      tracked tree passes
#  12. ... a roster planted in a tracked packages/*/src file fails BY PATH
#  13. ... a tracked file the scan cannot open fails BY NAME (skips as root)
#      Cases 2-8 and 10 reach the lint only through the find-based
#      LINT_THINKING_SCAN_DIR hook; case 9 proved the real branch green and
#      nothing could turn it red (#7783, #7633). Case 7 is split in two
#      (suffix rule / directory rule), hence extra checks beyond the numbered cases.
#  14. the DEFAULT floor (900) fails a 400-file scan — only the built-in floor
#      can fail it, so a floor slackened back toward 300 goes red
#  15-16. LINT_THINKING_MIN_FILES / LINT_THINKING_SCAN_DIR are IGNORED without
#      --test (a workflow-level env: must not be able to blind the guard)
#  17-18. .mts and .cts files are in scope
#  Every harness call passes --test; case 9 (real repo) passes no flag.
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
EXPECTED_CASES=21

PASS=0
FAIL=0
SKIP=0
FAILED=()

# run_lint <scan-dir> [min-files] -> echoes the lint's exit code.
run_lint() {
  LINT_THINKING_SCAN_DIR="$1" LINT_THINKING_MIN_FILES="${2:-1}" bash "$LINT" --test >/dev/null 2>&1
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

# Case 7 — tests are out of scope on purpose; see the lint header. Two
# INDEPENDENT exclusions (a `*.test.*` suffix, and a tests/ directory), so one
# file per rule: a single tests/roster.test.ts satisfied both and left either
# rule deletable with the case still green (#7783). Two checks; see the total
# in EXPECTED_CASES.
printf "expect(levels).toEqual(['default', 'high', 'max'])\n" > "$SCAN/src/roster.test.ts"
check "a roster in a *.test.ts OUTSIDE tests/ passes (suffix rule alone)" 0 "$(run_lint "$SCAN")"
rm -f "$SCAN/src/roster.test.ts"
printf "export const fixtureLevels = ['default', 'high', 'max']\n" > "$SCAN/tests/fixture.ts"
check "a roster in a non-.test file UNDER tests/ passes (directory rule alone)" 0 "$(run_lint "$SCAN")"
rm -f "$SCAN/tests/fixture.ts"

# Case 8 — fail-closed on a scan that walked too little. The two files in the
# tree are real and clean, so ONLY the floor can fail this: it proves the
# "scanned enough to mean anything" check is live, not merely present.
check "a scan below the min-files floor fails" 1 "$(run_lint "$SCAN" 50)"

# Case 9 — production invocation over the real git index stays green.
bash "$LINT" >/dev/null 2>&1
check "default invocation (real repo) green" 0 "$?"

# Case 10 — a file that could not be OPENED must fail the lint, by NAME, and
# must not be counted toward the min-files floor.
#
# The floor is 2 here, not 3, and the difference is the whole case. The tree
# holds exactly two readable files plus the unreadable one, so at floor 2 the
# readable files already satisfy the floor and the ONLY remaining source of
# exit 1 is the unreadable REPORT. At floor 3 the floor itself supplied the
# exit 1: measured against a scratch copy of the lint, the pre-fix code
# (`$scanned++` before the open, no report) exited 1 at floor 3 and the case
# stayed green, so the reporting block — the load-bearing half — had no red-able
# coverage at all. At floor 2 that same regression exits 0 (`OK — scanned 2`)
# and the case goes red, and so does a lint that counts correctly but drops the
# report.
#
# The naming half rides on the same `check` rather than adding an eleventh call,
# so the EXPECTED_CASES arithmetic keeps meaning what it says: a lint that exits
# 1 without ever saying WHICH file it could not read fails an operator at the
# only moment this guard fires, so it fails the case too.
UNREADABLE="$SCAN/src/unreadable.ts"
printf "export const z = 3\n" > "$UNREADABLE"
chmod 000 "$UNREADABLE" 2>/dev/null || true
if [ -r "$UNREADABLE" ] || cat "$UNREADABLE" >/dev/null 2>&1; then
  # Running as root (or on a filesystem that ignores the mode) — the case
  # cannot be constructed. Say so; never count it as a pass.
  SKIP=$((SKIP + 1))
  echo "SKIP - an unreadable file fails the scan (cannot make a file unreadable as uid $(id -u))"
else
  # Not run_lint: this case asserts on the lint's OUTPUT as well as its exit
  # code, and run_lint discards it.
  unreadable_out="$(LINT_THINKING_SCAN_DIR="$SCAN" LINT_THINKING_MIN_FILES=2 bash "$LINT" --test 2>&1)"
  unreadable_rc=$?
  case "$unreadable_out" in
    *"$UNREADABLE"*) unreadable_actual="$unreadable_rc" ;;
    *) unreadable_actual="$unreadable_rc (output never NAMED $UNREADABLE)" ;;
  esac
  check "an unreadable file fails the scan BY NAME and does not count toward the floor" 1 "$unreadable_actual"
fi
chmod 644 "$UNREADABLE" 2>/dev/null || true
rm -f "$UNREADABLE"

# Cases 11-13 — the PRODUCTION path. Build a throwaway git repo, copy the lint
# into its scripts/ (the lint cd's to its own parent), UNSET the test hook, and
# drive the real `git ls-files` branch: negative control, positive control,
# unreadable tracked file.
PROD="$TMP/prod"
PROD_FILE="packages/dashboard/src/store/types.ts"
mkdir -p "$PROD/scripts" "$PROD/packages/dashboard/src/store"
git -C "$PROD" init -q
cp "$LINT" "$PROD/scripts/lint-thinking-level-roster.sh"
printf "export const ok = 1\n" > "$PROD/$PROD_FILE"
git -C "$PROD" add scripts/lint-thinking-level-roster.sh "$PROD_FILE"

# run_prod -> the lint's combined output, then "RC=<exit>" as the last line.
run_prod() {
  local out rc
  out="$(cd "$PROD" && env -u LINT_THINKING_SCAN_DIR LINT_THINKING_MIN_FILES=1 bash scripts/lint-thinking-level-roster.sh --test 2>&1)"
  rc=$?
  printf '%s\nRC=%s\n' "$out" "$rc"
}
# prod_actual <needle> <output> -> the exit code, annotated when the output never named the needle.
prod_actual() {
  local rc
  rc="$(printf '%s\n' "$2" | tail -n 1 | sed 's/^RC=//')"
  case "$2" in
    *"$1"*) echo "$rc" ;;
    *) echo "$rc (output never NAMED $1)" ;;
  esac
}

# Case 11 — negative control: a clean tracked tree is green on the real branch.
prod_out="$(run_prod)"
check "production path: a clean tracked tree passes" 0 "$(prod_actual "OK" "$prod_out")"

# Case 12 — positive control: a roster in a tracked packages/*/src file.
printf "export type L = 'default' | 'high' | 'max'\n" > "$PROD/$PROD_FILE"
prod_out="$(run_prod)"
check "production path: a roster in a tracked packages/*/src file fails BY PATH" 1 "$(prod_actual "$PROD_FILE:1" "$prod_out")"
printf "export const ok = 1\n" > "$PROD/$PROD_FILE"

# Case 13 — a tracked file the production scan cannot open fails by name.
chmod 000 "$PROD/$PROD_FILE" 2>/dev/null || true
if [ -r "$PROD/$PROD_FILE" ] || cat "$PROD/$PROD_FILE" >/dev/null 2>&1; then
  SKIP=$((SKIP + 1))
  echo "SKIP - production path: an unreadable tracked file fails the scan (cannot make a file unreadable as uid $(id -u))"
else
  prod_out="$(run_prod)"
  check "production path: an unreadable tracked file fails BY NAME" 1 "$(prod_actual "$PROD_FILE" "$prod_out")"
fi
chmod 644 "$PROD/$PROD_FILE" 2>/dev/null || true

# Case 14 — the DEFAULT floor is tight. 400 clean files clear the old floor of
# 300 but are far below a real tree (~985), i.e. the shape of "a whole package's
# src went missing". --test is passed but LINT_THINKING_MIN_FILES is NOT, so
# only the built-in floor can fail this.
BIG="$TMP/big"; mkdir -p "$BIG"
for i in $(seq 1 400); do printf "export const v%s = %s\n" "$i" "$i" > "$BIG/f$i.ts"; done
big_rc=0
LINT_THINKING_SCAN_DIR="$BIG" bash "$LINT" --test >/dev/null 2>&1 || big_rc=$?
check "the default floor fails a 400-file scan (a package's src gone missing)" 1 "$big_rc"

# Cases 15-16 — the env hooks are IGNORED without --test. Neither passes the
# flag; both set the env vars a workflow-level `env:` could set. If an env var
# were honoured, the floor would be 1 (case 15) or the scan would walk the
# clean temp tree (case 16) — either way the output below would not report the
# production scan's count of 1 file against the real floor.
prod_out="$(cd "$PROD" && LINT_THINKING_MIN_FILES=1 bash scripts/lint-thinking-level-roster.sh 2>&1; echo "RC=$?")"
check "LINT_THINKING_MIN_FILES alone is ignored without --test" 1 "$(prod_actual "scanned only 1 files (floor: 900)" "$prod_out")"
prod_out="$(cd "$PROD" && LINT_THINKING_SCAN_DIR="$BIG" bash scripts/lint-thinking-level-roster.sh 2>&1; echo "RC=$?")"
check "LINT_THINKING_SCAN_DIR alone is ignored without --test" 1 "$(prod_actual "scanned only 1 files (floor: 900)" "$prod_out")"

# Case 19 — the warning for an ignored env hook is actually printed. Cases 15-16
# assert only the exit code and the floor, so dropping the warning stayed green.
prod_out="$(cd "$PROD" && LINT_THINKING_MIN_FILES=1 bash scripts/lint-thinking-level-roster.sh 2>&1; echo "RC=$?")"
check "an env hook set without --test prints the ::warning::" 1 "$(prod_actual "::warning::LINT_THINKING_MIN_FILES" "$prod_out")"

# Case 20 — an unknown argument is refused, by name. A silent `*) ;;` would
# turn a typo'd flag into a normal run.
bogus_out="$(bash "$LINT" --bogus 2>&1; echo "RC=$?")"
check "an unknown argument exits 1 with ::error:: naming it" 1 "$(prod_actual "::error::lint-thinking-level-roster.sh: unknown argument '--bogus'" "$bogus_out")"

# Cases 17-18— the module extensions .mts / .cts are in scope.
MX="$TMP/mx"; mkdir -p "$MX/src"
printf "export const A = 1\n" > "$MX/src/a.ts"
printf "export const L = ['default', 'high', 'max']\n" > "$MX/src/roster.mts"
check "a roster in a .mts file fails" 1 "$(run_lint "$MX")"
rm -f "$MX/src/roster.mts"
printf "export const L = ['default', 'high', 'max']\n" > "$MX/src/roster.cts"
check "a roster in a .cts file fails" 1 "$(run_lint "$MX")"

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
