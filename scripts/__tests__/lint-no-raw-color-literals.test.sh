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

# Every case below must be ACCOUNTED FOR. Without this, a harness whose cases
# stop executing prints "PASS — all 0 cases" and exits 0 — "all cases passed"
# and "no case executed" are the same observable outcome, the second recurring
# cause in docs/false-safety-guards.md (#7653). Asserted EQUAL, not -ge, so
# removing a case is as loud as skipping one.
#
# SKIP is part of the sum, and that is not cosmetic: cases 5-7 run only on a
# host with a case-folding UTF-8 locale, so PASS+FAIL alone is 8 on macOS and 5
# on the Linux runner this suite actually runs on. Measured — a PASS+FAIL floor
# of 8 here would have been red in CI and green for whoever wrote it.
EXPECTED_CASES=8

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

# skip_case <name> — a case this host cannot run. Counted, so PASS+FAIL+SKIP
# stays equal to the number of cases the file declares.
skip_case() {
  SKIP=$((SKIP + 1)); SKIPPED+=("$1")
  echo "SKIP - $1 (no case-folding UTF-8 locale on this host)"
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
#
# AND THE PROBE ITSELF NOW HAS ONE (#7655). The header above argues the probe is
# the control for cases 5-7; nothing controlled the probe. Break its pattern —
# `grep -iE '[.]utf-?8$'` mutated to match nothing — and HOSTILE stays empty,
# the three cases become three skips, PASS+FAIL+SKIP still reaches 8, and every
# floor is satisfied. #7653's floors are blind to a case that stops executing
# while still being COUNTED, and this is the live instance.
#
# What makes it undetectable by a count is that the skipping state is the NORMAL
# state: the Linux runner genuinely skips these three every run, so "no
# case-folding locale here" and "the probe stopped matching locales" look
# identical from outside. The distinction lives inside the probe, so the probe
# is where it has to be drawn — count the candidates it EXAMINED, separately
# from whether any of them case-folds.
# `tr -d '\r'` because the pattern anchors at end-of-line: one CRLF and every
# entry stops matching while still counting as a listed locale, which would fire
# the abort below on a host that has perfectly good locales. Found in review of
# #7682 by stubbing `locale -a` with CRLF output — a real shape for an ssh/pty
# transport or a `script`/tee wrapper, and this file invites being run anywhere.
ALL_LOCALES="$(locale -a 2>/dev/null | tr -d '\r' || true)"
LOCALE_COUNT="$(printf '%s\n' "$ALL_LOCALES" | grep -c . || true)"
UTF8_CANDIDATES="$(printf '%s\n' "$ALL_LOCALES" | grep -iE '[.]utf-?8$' || true)"
CANDIDATE_COUNT="$(printf '%s\n' "$UTF8_CANDIDATES" | grep -c . || true)"
# A LOOSER reading of the same list, and it is what makes the check below
# precise. "Zero candidates" alone cannot tell a broken pattern from a host that
# genuinely ships no UTF-8 locale — `C`/`POSIX` only is a real Debian without
# locales-all, and the first version of this check failed it (Copilot, #7682).
# Anything mentioning utf at all is the loose set: if the loose set is non-empty
# while the anchored one is empty, the ANCHOR has stopped matching. If both are
# empty, the host simply has none.
UTF8_LOOSE_COUNT="$(printf '%s\n' "$ALL_LOCALES" | grep -ic 'utf' || true)"

# ONE-SIDED, and that is the whole design (#7682 review). This asked whether a
# locale sorted a pair DIFFERENTLY FROM C — two sides, and equalising them is a
# one-line edit that leaves candidates > 0 while HOSTILE can never be set. The
# three cases then become three ordinary skips, indistinguishable from the Linux
# runner's normal state: exactly the defect #7655 exists to close, reproduced
# one line deeper than the candidate count reaches.
#
# `B` before `a` is byte order; `a` before `B` is case-folding collation. Asking
# the locale directly has no second side to equalise, so that mutation cannot be
# written. The C control below is the sanity check the old shape smuggled in.
if [ "$(printf 'B\na\n' | LC_ALL=C sort | head -1)" != "B" ]; then
  echo "PROBE BROKEN: LC_ALL=C did not sort 'B' before 'a' — byte ordering itself"
  echo "  is not behaving, so nothing this probe reports can be trusted (#7682)."
  exit 1
fi

HOSTILE=""
for loc in $UTF8_CANDIDATES; do
  if [ "$(printf 'B\na\n' | LC_ALL="$loc" sort 2>/dev/null | head -1)" = "a" ]; then
    HOSTILE="$loc"; break
  fi
done

# The probe's own control, and the ORDER matters: this is checked before the
# skip branch, because the skip branch is what the broken probe hides behind.
#
#   candidates > 0, none case-folds  -> the documented, legitimate skip
#   candidates == 0, no locales at all -> nothing to examine; also legitimate
#                                         (a minimal image, or no `locale`)
#   candidates == 0 while locales EXIST -> the pattern has stopped matching,
#                                         which is a finding, not a skip
#
# It ABORTS rather than counting a failure, and that is deliberate: this is a
# harness-integrity check in the same family as the HARNESS BROKEN line below,
# not one of the eight cases the file declares. Counting it made the total 9
# against EXPECTED_CASES=8, so a broken probe reported BOTH its own finding and
# a spurious "a case stopped executing" — two diagnoses for one fault, the
# second of them wrong.
PROBE_BROKEN=0
if [ "$CANDIDATE_COUNT" -eq 0 ] && [ "$UTF8_LOOSE_COUNT" -gt 0 ]; then
  PROBE_BROKEN=1
  echo "PROBE BROKEN: the anchored pattern matched 0 locales while $UTF8_LOOSE_COUNT of the"
  echo "  $LOCALE_COUNT listed mention utf. The anchor has stopped matching, so cases 5-7"
  echo "  would report as three ordinary skips rather than as a fault (#7655)."
fi

# The SECOND discriminator, and it exists because the first one does not reach
# far enough. Review of #7682 broke the probe one line deeper — the candidate
# list stays full while the comparison can no longer find a hostile locale — and
# the result was three silent skips again, which is the whole defect.
#
# No probe can prove a negative about its own host: "no locale case-folds" and
# "I can no longer tell" are the same observation from inside. What IS decidable
# is PLAUSIBILITY, and it is decidable because the shapes are far apart:
#
#   measured on this machine  83 UTF-8 candidates, 82 of them case-fold
#   measured on the CI runner en_US.utf8 case-folds (from a real run log)
#   a minimal container       1-3 candidates (C.UTF-8 and friends), none folds
#
# A host carrying five or more UTF-8 locales while NOT ONE of them case-folds is
# not a real system; it is a broken comparison. Under five, the legitimate
# C.UTF-8-only shape is indistinguishable and this stays silent — that residual
# blind spot is stated rather than papered over.
PROBE_MIN_SUSPICIOUS=5
if [ -z "$HOSTILE" ] && [ "$CANDIDATE_COUNT" -ge "$PROBE_MIN_SUSPICIOUS" ]; then
  PROBE_BROKEN=1
  echo "PROBE BROKEN: examined $CANDIDATE_COUNT UTF-8 locales and NONE case-folds."
  echo "  A host with that many UTF-8 locales and no case-folding collation among"
  echo "  them is not a real shape — the comparison has stopped working, not the"
  echo "  host. Cases 5-7 would otherwise report as three ordinary skips (#7682)."
fi

# The legitimate skip PRINTS ITS EVIDENCE, so a reader can audit the judgement
# rather than trusting it: a run that examined one candidate is a container, one
# that examined eighty is a fault the threshold above should have caught.
if [ -z "$HOSTILE" ] && [ "$PROBE_BROKEN" -eq 0 ]; then
  echo "info - collation probe examined $CANDIDATE_COUNT UTF-8 locale(s) of $LOCALE_COUNT listed; none case-folds"
fi

if [ -z "$HOSTILE" ]; then
  # NOT silently skipped: an unavailable case is reported in the summary, so a
  # host that cannot run it says so rather than reading as three more passes.
  #
  # Once PER CASE, naming the case it stands in for, rather than one
  # `SKIP=$((SKIP + 3))`. A literal 3 beside three cases is a count that has to
  # be remembered: add a fourth collation case below and the total is 9 on a
  # host that runs them and 8 on one that skips them, so EXPECTED_CASES would be
  # right for whoever wrote it and wrong on the runner. Three calls cannot drift
  # from three cases.
  skip_case "fully-baselined tree is green under a case-folding locale"
  skip_case "new offender still detected under the same locale"
  skip_case "pre-fix split collation IS red on the same tree (control)"
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
BROKEN=0
if [ "$FAIL" -ne 0 ]; then
  echo "FAILED ($FAIL): ${FAILED[*]}"
  BROKEN=1
fi
if [ "$((PASS + FAIL + SKIP))" -ne "$EXPECTED_CASES" ]; then
  echo "HARNESS BROKEN: ran $((PASS + FAIL + SKIP)) cases, expected $EXPECTED_CASES — a case stopped executing"
  BROKEN=1
fi
# The probe finding is carried here rather than exiting where it was detected.
# It is not one of the declared cases, so it must not touch the count — but
# aborting on the spot ALSO discarded case 8, which has no locale dependency and
# could still have run and reported. Losing an orthogonal check to a probe fault
# is coverage thrown away for nothing (#7682 review).
if [ "$PROBE_BROKEN" -ne 0 ]; then
  echo "PROBE BROKEN (see above): the locale probe could not be trusted, so cases 5-7 mean nothing this run"
  BROKEN=1
fi
[ "$BROKEN" -eq 0 ] || exit 1
echo "PASS — all $PASS cases"
