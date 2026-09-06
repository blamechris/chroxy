#!/usr/bin/env bash
#
# parse-check-shell.test.sh — the red proof for scripts/parse-check-shell.sh
# (#7646).
#
# The subject used to be an inline loop in ci.yml, "tested" by three regexes
# over the step's YAML text in
# packages/server/tests/ci-scripts-tests-registration.test.js. All six mutations
# #7646 reported survive those three assertions, four of them SILENTLY —
# including `rc=1` demoted to a `::warning` and `exit "$rc"` replaced by
# `exit 0`, either of which turns the whole sweep into a no-op that reports
# success. Matching a step's spelling is not testing its behaviour.
#
# So every case here RUNS the real script, against a synthetic git repo built
# for the case, and asserts on its EXIT CODE and OUTPUT. The script is copied
# into each fixture at <repo>/scripts/parse-check-shell.sh so that its own
# root-resolution (`dirname "$0"/..`) lands on the fixture — no environment
# override exists, and that is deliberate: a root or floor that CI could
# override is a fail-open surface, and the enumeration this guards is exactly
# what an override would narrow.
#
# The copy is NOT `git add`ed in the fixtures, so the expected file count is
# exactly the number of fillers a case asks for.
#
# Cases 5-7 are the mutation kills the old regexes could not make:
#   * a narrowed pathspec (case 5, a nested subject)
#   * a truncated enumeration (case 6, the alphabetically LAST file broken)
#   * an invocation from a subdirectory silently narrowing the sweep (case 7)
#
# No test framework — matches the sibling scripts/__tests__/*.test.sh.
#
# Run from anywhere:  bash scripts/__tests__/parse-check-shell.test.sh
# Exit status: 0 if all cases pass, 1 otherwise.

set -uo pipefail

# BEFORE the `cd` below, not with the GIT_* scrub further down: an exported
# CDPATH makes `cd` echo the directory it resolved to, so REPO_ROOT becomes a
# TWO-LINE string and every fixture path built from it is wrong. Measured:
# `CDPATH=. bash <this file>` died with "HARNESS BROKEN: could not enumerate the
# real repo", and the first version of this scrub sat below REPO_ROOT and fixed
# nothing.
CDPATH=''

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/parse-check-shell.sh"

# Every case below must run. A harness whose cases stop executing prints
# "PASS - all 0 cases" and exits 0, which is the same false-safety shape the
# subject is here to prevent, so the count is asserted at the bottom — EQUAL,
# not `-ge`, so that removing a case is as loud as skipping one. It earned its
# place immediately: the first run of this file reported 21 against a
# hand-counted 17.
EXPECTED_CASES=25

PASS=0
FAIL=0
FAILED=()

# check <name> <expected> <actual>
check() {
  if [ "$2" = "$3" ]; then
    PASS=$((PASS + 1)); echo "ok   - $1"
  else
    FAIL=$((FAIL + 1)); FAILED+=("$1 (expected '$2', got '$3')"); echo "NOT  - $1 (expected '$2', got '$3')"
  fi
}

# check_contains <name> <needle> <haystack>
# An EMPTY needle would make the `case` below match ANYTHING — `*""*` is
# satisfied by every string — so a needle computed by a command that failed
# would report `ok` for free. Refused rather than allowed to pass.
check_contains() {
  if [ -z "$2" ]; then
    FAIL=$((FAIL + 1)); FAILED+=("$1 (EMPTY needle — the value it came from was never computed)")
    echo "NOT  - $1 (EMPTY needle — vacuous match refused)"
    return
  fi
  case "$3" in
    *"$2"*) PASS=$((PASS + 1)); echo "ok   - $1" ;;
    *) FAIL=$((FAIL + 1)); FAILED+=("$1 (output did not contain '$2')"); echo "NOT  - $1 (output did not contain '$2')" ;;
  esac
}

# A GIT_* variable inherited from the caller redirects or narrows every
# `git ls-files` below — GIT_DIR and GIT_INDEX_FILE most sharply, and a missing
# GIT_INDEX_FILE is read as an EMPTY index at exit 0, which is "found nothing"
# wearing "nothing wrong". The fixtures would then silently describe some other
# repository, so they are scrubbed rather than trusted.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CEILING_DIRECTORIES \
      GIT_LITERAL_PATHSPECS GIT_GLOB_PATHSPECS GIT_NOGLOB_PATHSPECS GIT_ICASE_PATHSPECS


# Status AND emptiness both checked. `set -u` does not help here: a failed
# `mktemp -d` leaves TMP SET-but-empty, so every fixture path below becomes
# absolute — `mkdir -p "$TMP/clean"` would create /clean at the filesystem root
# — and the EXIT trap would run `rm -rf ""`. Fail before any of that happens.
TMP="$(mktemp -d)" || { echo "HARNESS BROKEN: mktemp -d failed"; exit 1; }
[ -n "$TMP" ] && [ -d "$TMP" ] \
  || { echo "HARNESS BROKEN: mktemp -d gave no usable directory ([$TMP])"; exit 1; }
trap 'rm -rf "$TMP"' EXIT

VALID='#!/usr/bin/env bash
echo ok
'
# `if` with no `then`/`fi` is a syntax error every bash reports, and it is
# caught at PARSE time, so `bash -n` sees it without executing anything.
BROKEN='#!/usr/bin/env bash
if [ 1 -eq 1 ]
echo "unterminated
'

# The directories the REAL repo keeps shell scripts in, DERIVED rather than
# typed. Fixtures are built with this shape because a mutation keyed to a REAL
# path is only observable in a fixture that has that path: measured,
# `case "$f" in packages/*) continue ;; esac` skipped 17 of 32 files while
# still reporting "parsed 32", and survived all 23 cases while every fixture
# directory was named `pkg/a/scripts`. Derived, so a new script directory in
# the repo is covered here for free — a typed list beside a growing set is the
# first cause in docs/false-safety-guards.md.
( cd "$REPO_ROOT" && git ls-files -z '*.sh' > "$TMP/realdirs.z" ) \
  || { echo "HARNESS BROKEN: could not enumerate the real repo"; exit 1; }
REAL_DIRS=()
while IFS= read -r d; do
  [ -n "$d" ] && REAL_DIRS+=("$d")
done <<REALDIRS
$(tr '\0' '\n' < "$TMP/realdirs.z" | sed 's|/[^/]*$||' | sort -u)
REALDIRS
[ "${#REAL_DIRS[@]}" -ge 3 ] \
  || { echo "HARNESS BROKEN: derived only ${#REAL_DIRS[@]} script directories from the real repo"; exit 1; }

# make_repo <dir> <n_fillers>
# A git repo with exactly <n_fillers> TRACKED *.sh files, spread over the real
# repo's own directory shape, plus an UNTRACKED copy of the subject at
# <dir>/scripts/parse-check-shell.sh.
make_repo() {
  local dir="$1" n="$2" i sub
  mkdir -p "$dir/scripts"
  for sub in "${REAL_DIRS[@]}"; do mkdir -p "$dir/$sub"; done
  ( cd "$dir" && git init -q . && git config user.email t@example.com && git config user.name t ) \
    || { echo "FIXTURE FAILED: git init in $dir"; exit 1; }
  i=0
  while [ "$i" -lt "$n" ]; do
    sub="${REAL_DIRS[$((i % ${#REAL_DIRS[@]}))]}"
    printf '%s' "$VALID" > "$dir/$sub/f$(printf '%03d' "$i").sh"
    i=$((i + 1))
  done
  cp "$SCRIPT" "$dir/scripts/parse-check-shell.sh"
  # Only the fillers are tracked; the subject copy stays out of the index so
  # the expected count is exactly <n_fillers>.
  # The status is checked: a failed `git add` leaves an EMPTY index, and a
  # fixture with no tracked files still exercises several assertions that then
  # report `ok` against nothing.
  ( cd "$dir" && git add . ':!scripts/parse-check-shell.sh' >/dev/null 2>&1 ) \
    || { echo "FIXTURE FAILED: git add in $dir"; exit 1; }
  local got
  got="$( cd "$dir" && git ls-files '*.sh' | wc -l | tr -d ' ' )"
  [ "$got" = "$n" ] || { echo "FIXTURE FAILED: $dir tracks $got *.sh, expected $n"; exit 1; }
}

# run_check <dir> [cwd] -> sets OUT and RC
run_check() {
  # Split across two `local` lines on purpose. Measured on this repo's macOS
  # bash 3.2: `local dir="$1" cwd="${2:-$dir}"` reads an unset local `dir` and
  # dies under `set -u` ("dir: unbound variable"). Whether a newer bash differs
  # was NOT measured — no other bash is installed here — so the claim is kept to
  # the reading that exists, and the two-line form is correct on both anyway.
  local dir="$1"
  local cwd="${2:-$dir}"
  OUT="$( cd "$cwd" && bash "$dir/scripts/parse-check-shell.sh" 2>&1 )"
  RC=$?
}

# ---- Case 1: a clean tree passes, and reports the count it actually saw ----
R="$TMP/clean"; make_repo "$R" 25
run_check "$R"
check "clean tree of 25 scripts exits 0" 0 "$RC"
check_contains "clean tree reports the real count" "parsed 25 tracked shell script(s)" "$OUT"

# ---- Case 2: THE positive control — a syntax error must fail, exit 1 ----
R="$TMP/broken"; make_repo "$R" 25
printf '%s' "$BROKEN" > "$R/packages/app/.maestro/scripts/f000.sh"
run_check "$R"
check "a syntax error exits 1 (not 0, not 2)" 1 "$RC"
check_contains "the failing file is named in the output" "packages/app/.maestro/scripts/f000.sh" "$OUT"

# ---- Case 3: the floor fires on a short enumeration, exit 2 ----
R="$TMP/short"; make_repo "$R" 5
run_check "$R"
check "5 scripts trips the floor, exit 2" 2 "$RC"
check_contains "the floor says the ENUMERATION is broken" "the enumeration is broken, not the tree" "$OUT"

# ---- Case 4: the floor is exactly 20 — pinned from both sides ----
R="$TMP/at19"; make_repo "$R" 19
run_check "$R"
check "19 scripts is below the floor, exit 2" 2 "$RC"
R="$TMP/at20"; make_repo "$R" 20
run_check "$R"
check "20 scripts clears the floor, exit 0" 0 "$RC"

# ---- Case 5: a NESTED subject is parsed — kills a narrowed pathspec ----
# The narrowing that matters keeps the asserted literal intact, so it has to be
# an EXCLUDE: `git ls-files -z '*.sh' ':!packages/app/*' ':!packages/desktop/*'`
# still spells `'*.sh'` and still satisfied the old regex, while dropping seven
# files and landing at 25 — above the runtime floor, so the job stayed green
# too. (APPENDING a positive pathspec does NOT narrow: git UNIONS pathspecs, so
# `-- scripts` measured 61 files here, not fewer. Both spellings are in the
# mutation record; only the exclude one is a silent narrowing.)
R="$TMP/nested"; make_repo "$R" 25
printf '%s' "$BROKEN" > "$R/packages/desktop/scripts/f001.sh"
run_check "$R"
check "a broken script in a DEEP subdirectory is caught" 1 "$RC"
check_contains "the deep file is named" "packages/desktop/scripts/f001.sh" "$OUT"

# ---- Case 6: the alphabetically LAST file — kills a truncated enumeration ----
# Any `| head`-style truncation drops the tail, and the tail is the only thing
# broken here, so a truncated sweep reports success.
R="$TMP/last"; make_repo "$R" 25
# Derived via a temp file, not a pipe: `git ... | tail` reports TAIL's status,
# so a failed enumeration would yield an empty LAST and a vacuous assertion.
( cd "$R" && git ls-files '*.sh' > "$TMP/last.txt" ) || { echo "FIXTURE FAILED: enumerating $R"; exit 1; }
LAST="$(tail -1 "$TMP/last.txt")"
[ -n "$LAST" ] || { echo "FIXTURE FAILED: no *.sh enumerated in $R"; exit 1; }
printf '%s' "$BROKEN" > "$R/$LAST"
run_check "$R"
check "a broken script LAST in the enumeration is caught" 1 "$RC"
check_contains "the last file is named" "$LAST" "$OUT"

# ---- Case 7: invocation from a SUBDIRECTORY must not narrow the sweep ----
# Measured: `git ls-files '*.sh'` from a subdirectory lists only that subtree.
# The script resolves its root from its own location, so the cwd is irrelevant.
R="$TMP/fromsub"; make_repo "$R" 25
run_check "$R" "$R/packages/desktop/scripts"
check "invoked from a subdirectory, still exits 0" 0 "$RC"
check_contains "invoked from a subdirectory, still sees all 25" "parsed 25 tracked shell script(s)" "$OUT"

# ---- Case 8: not a git repo at all — fails CLOSED, exit 2 ----
# The MESSAGE is asserted, not just the code. Without that, deleting the
# explicit `git ls-files` status check is a surviving mutant: a git failure
# leaves the listing empty, the count reaches the floor at 0, and exit 2 comes
# out of the floor branch instead. Same code, different cause — and "git is
# broken" and "this tree really has four scripts" want different fixes, which is
# the only reason the explicit check earns its place. Measured: it survived
# until this line existed.
R="$TMP/nogit"; mkdir -p "$R/scripts"; cp "$SCRIPT" "$R/scripts/parse-check-shell.sh"
run_check "$R"
check "outside a git repo it exits 2, never 0" 2 "$RC"
check_contains "outside a git repo it blames GIT, not the tree size" "git ls-files failed" "$OUT"

# ---- Case 9: an UNTRACKED broken script is out of scope ----
# The git index is the source of truth, not the filesystem: node_modules, dist
# and every ignored tree are excluded by construction.
R="$TMP/untracked"; make_repo "$R" 25
printf '%s' "$BROKEN" > "$R/packages/server/hooks/not-added.sh"
run_check "$R"
check "an UNTRACKED broken script is ignored (the index is the roster)" 0 "$RC"

# ---- Case 10: scope is by extension — a broken non-.sh file is ignored ----
R="$TMP/ext"; make_repo "$R" 25
printf '%s' "$BROKEN" > "$R/packages/server/hooks/notes.txt"
# Status checked like every other fixture step: an unchecked `git add` here
# leaves the .txt untracked, and the case then passes because the file is out of
# scope for a reason it was not testing.
( cd "$R" && git add packages/server/hooks/notes.txt >/dev/null 2>&1 ) \
  || { echo "FIXTURE FAILED: git add notes.txt in $R"; exit 1; }
( cd "$R" && git ls-files --error-unmatch packages/server/hooks/notes.txt >/dev/null 2>&1 ) \
  || { echo "FIXTURE FAILED: notes.txt is not tracked in $R"; exit 1; }
run_check "$R"
check "a broken NON-.sh tracked file is ignored" 0 "$RC"

# ---- Case 11: every broken file is reported, not just the first ----
R="$TMP/two"; make_repo "$R" 25
printf '%s' "$BROKEN" > "$R/packages/app/.maestro/scripts/f000.sh"
printf '%s' "$BROKEN" > "$R/packages/desktop/scripts/f001.sh"
run_check "$R"
check_contains "the first broken file is named" "packages/app/.maestro/scripts/f000.sh" "$OUT"
check_contains "the second broken file is named too (the loop does not stop)" "packages/desktop/scripts/f001.sh" "$OUT"

# ---- Case 12: a broken enumeration OUTRANKS a parse error ----
# Both are failures; the distinction matters because exit 2 means "do not
# believe this run at all", while exit 1 means "the sweep worked and found a bug".
R="$TMP/both"; make_repo "$R" 5
printf '%s' "$BROKEN" > "$R/packages/app/.maestro/scripts/f000.sh"
run_check "$R"
check "short enumeration + parse error still exits 2" 2 "$RC"

# ---- Case 13: a hostile CDPATH does not derail the script ----
# `cd` ECHOES its resolved directory when CDPATH is set, so the script's own
# `ROOT="$(cd ... && pwd)"` captures two lines and every later use is wrong.
# Measured before the script scrubbed it: exit 3 with a garbled path that never
# named CDPATH. Exported deliberately for this case, and only this case.
# Invoked by a RELATIVE path on purpose. `cd` consults CDPATH only for a
# relative operand, so `bash "$R/scripts/parse-check-shell.sh"` — the absolute
# form every other case uses — cannot reach this bug at all. Measured: the first
# version of this case used the absolute form and passed with the script's
# scrub deleted, which is a case that tests nothing.
R="$TMP/cdpath"; make_repo "$R" 25
OUT="$( cd "$R" && CDPATH=. bash scripts/parse-check-shell.sh 2>&1 )"; RC=$?
check "a hostile CDPATH does not break the sweep" 0 "$RC"
check_contains "a hostile CDPATH does not truncate the sweep" "parsed 25 tracked shell script(s)" "$OUT"

# ---- Case 14/15: the production sweep covers the WHOLE tracked set ----
# Exit 0 alone is not enough, and this is the gap every fixture above shares:
# the fixtures are built under mktemp with directories named `scripts/`,
# `pkg/a/scripts/` and `packages/desktop/scripts/`, so a pathspec narrowed against a
# REAL path — `git ls-files -z '*.sh' ':!packages/server'`, which keeps the
# asserted literal, drops 9 files and still clears the floor — changes nothing
# any of them can observe, and exits 0.
#
# So the count is derived a SECOND time, here, straight from git, and compared
# with the count the script reports. Nothing is hardcoded, so it is not a number
# beside a growing set; it kills every narrowing, every truncation and every
# early `break` against the real tree at once.
#
# Its blind spot, stated rather than implied: a mutation applied identically to
# BOTH derivations is invisible to it. That is why the fixture cases above
# exist — they pin the behaviour against trees this file builds itself.
EXPECTED="$( cd "$REPO_ROOT" && git ls-files -z '*.sh' > "$TMP/prod.z" && tr -cd '\0' < "$TMP/prod.z" | wc -c | tr -d ' ' )"
[ -n "$EXPECTED" ] && [ "$EXPECTED" -gt 0 ] 2>/dev/null \
  || { echo "HARNESS BROKEN: could not enumerate tracked *.sh in $REPO_ROOT"; exit 1; }
OUT="$(bash "$SCRIPT" 2>&1)"; RC=$?
check "production invocation on this repo is green" 0 "$RC"
check_contains "the production sweep covers every tracked *.sh" "parsed $EXPECTED tracked shell script(s)" "$OUT"

echo "----"
if [ "$((PASS + FAIL))" -ne "$EXPECTED_CASES" ]; then
  echo "HARNESS BROKEN: ran $((PASS + FAIL)) cases, expected $EXPECTED_CASES — a case stopped executing"
  exit 1
fi
if [ "$FAIL" -ne 0 ]; then
  echo "FAILED ($FAIL): ${FAILED[*]}"
  exit 1
fi
echo "PASS — all $PASS cases"
