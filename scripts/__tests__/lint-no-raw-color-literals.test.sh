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
SKIP=0
SKIPPED=()

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

# ---------------------------------------------------------------------------
# #7493 — collation. `comm` requires its inputs sorted in ITS OWN collation.
# The lint pinned its sorts to C and left `comm` on the ambient locale, and the
# two disagree: in C, `components/SettingsBar.tsx` precedes
# `components/chat/...` (`S` = 0x53 < `c` = 0x63), while en_US.UTF-8 folds case
# and orders `chat/` first. `comm` walked off the merge and reported
# already-baselined files as NEW offenders — a red Style Lint caused by the
# runner's LANG rather than by the diff.
#
# The fixture below is the real failure in miniature: a baselined file that no
# longer has a literal (`Zebra.tsx`, upper-case) sitting immediately before a
# `chat/` subdirectory, so the two orderings diverge exactly where the merge
# walks. Note that the hazard needs a case-folding locale — `C.UTF-8` orders by
# codepoint like `C` does and cannot reproduce it, which is why the locale is
# PROBED rather than assumed.
# ---------------------------------------------------------------------------

LOC="$TMP/loc"; mkdir -p "$LOC/chat"
echo 'export const x = 1' > "$LOC/Zebra.tsx"                 # baselined, literal since removed
printf "export const a = '#111'\n" > "$LOC/chat/Alpha.tsx"   # baselined, still has one
printf "export const b = '#222'\n" > "$LOC/chat/Beta.tsx"    # baselined, still has one
LOCBASE="$TMP/loc-baseline.txt"
printf '%s\n%s\n%s\n' "$LOC/Zebra.tsx" "$LOC/chat/Alpha.tsx" "$LOC/chat/Beta.tsx" \
  | LC_ALL=C sort > "$LOCBASE"

# Probe for a locale that actually ORDERS these two names differently from C.
# This is the positive control: without a demonstrated divergence the cases
# below would pass for the wrong reason (nothing to reproduce).
HOSTILE=""
for loc in $(locale -a 2>/dev/null | grep -iE '[.]utf-?8$'); do
  if [ "$(printf '%s\n%s\n' "$LOC/Zebra.tsx" "$LOC/chat/Alpha.tsx" | LC_ALL="$loc" sort | head -1)" \
     != "$(printf '%s\n%s\n' "$LOC/Zebra.tsx" "$LOC/chat/Alpha.tsx" | LC_ALL=C sort | head -1)" ]; then
    HOSTILE="$loc"; break
  fi
done

if [ -z "$HOSTILE" ]; then
  # NOT silently skipped: an unavailable case is reported in the summary, so a
  # host that cannot run it says so rather than reading as three more passes.
  SKIP=$((SKIP + 3)); SKIPPED+=("collation cases (no case-folding UTF-8 locale on this host)")
  echo "SKIP - collation cases: no case-folding UTF-8 locale found in \`locale -a\`"
else
  echo "info - collation cases using LC_ALL=$HOSTILE"

  # Case 5 — the reported symptom: every file is baselined, so the lint must be
  # green no matter what the ambient locale is.
  LINT_COLOR_SCAN_DIRS="$LOC" LINT_COLOR_BASELINE="$LOCBASE" \
    env -u LC_ALL LANG="$HOSTILE" LC_COLLATE="$HOSTILE" bash "$LINT" >/dev/null 2>&1
  check "fully-baselined tree is green under a case-folding locale" 0 "$?"

  # Case 6 — the guard still fails. A locale fix that made the lint green by
  # disabling it would pass Case 5 and this is what catches that.
  printf "export const c = '#333'\n" > "$LOC/chat/Gamma.tsx"
  LINT_COLOR_SCAN_DIRS="$LOC" LINT_COLOR_BASELINE="$LOCBASE" \
    env -u LC_ALL LANG="$HOSTILE" LC_COLLATE="$HOSTILE" bash "$LINT" >/dev/null 2>&1
  check "new offender still detected under the same locale" 1 "$?"
  rm -f "$LOC/chat/Gamma.tsx"

  # Case 7 — red-first control. Reconstruct the PRE-#7493 split (sorts pinned to
  # C, comm left ambient) and confirm Case 5's tree fails under it. Without this
  # the case above could be green because the fixture never exercised the merge.
  SPLIT="$TMP/split-collation.sh"
  sed -e 's/^export LC_ALL=C$/: # split-collation control (#7493)/' \
      -e 's/^    | sort$/    | LC_ALL=C sort/' \
      -e 's/^baseline="\$(sort "\$BASELINE")"$/baseline="$(LC_ALL=C sort "$BASELINE")"/' \
      "$LINT" > "$SPLIT"
  if cmp -s "$SPLIT" "$LINT"; then
    # The transform matched nothing, so the "control" would be the fixed script
    # and would pass — a control that cannot fail is not a control.
    FAIL=$((FAIL + 1)); FAILED+=("split-collation control could not be built (the lint's collation lines moved)")
    echo "NOT  - split-collation control could not be built (the lint's collation lines moved — update this test)"
  else
    LINT_COLOR_SCAN_DIRS="$LOC" LINT_COLOR_BASELINE="$LOCBASE" \
      env -u LC_ALL LANG="$HOSTILE" LC_COLLATE="$HOSTILE" bash "$SPLIT" >/dev/null 2>&1
    check "pre-fix split collation IS red on the same tree (control)" 1 "$?"
  fi
fi

# Case 8 — mechanism, and the only collation case that runs on every host: the
# pin must precede every collation-sensitive command, not sit beside one of them.
pin_line="$(grep -n '^export LC_ALL=C$' "$LINT" | head -1 | cut -d: -f1)"
first_use="$(grep -nE '(^|[|[:space:]])(sort|comm)([[:space:]]|$)' "$LINT" | grep -vE ':[[:space:]]*#' | head -1 | cut -d: -f1)"
if [ -n "$pin_line" ] && [ -n "$first_use" ] && [ "$pin_line" -lt "$first_use" ]; then
  ordered=0
else
  ordered=1
fi
check "LC_ALL=C is pinned before the first sort/comm" 0 "$ordered"

echo "----"
if [ "$SKIP" -ne 0 ]; then
  echo "UNAVAILABLE ($SKIP): ${SKIPPED[*]}"
fi
if [ "$FAIL" -ne 0 ]; then
  echo "FAILED ($FAIL): ${FAILED[*]}"
  exit 1
fi
echo "PASS — all $PASS cases"
