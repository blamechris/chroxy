#!/usr/bin/env bash
#
# check-dist-drift.test.sh — Golden test for scripts/check-dist-drift.sh (#8152).
#
# The dist-drift step in ci.yml used to be a bare `git diff --exit-code
# <dist-dir>` after a rebuild. `git diff` only looks at TRACKED paths, and
# dist/ is gitignored, so a NEW file the build emits (a new src/foo.ts
# producing dist/foo.js) is untracked AND ignored — invisible to `git diff` —
# and the check stayed green while the file was never committed. This is the
# "cannot check this" == "nothing to check" class in
# docs/false-safety-guards.md.
#
# Drives the script against a TEMP git repo (check-dist-drift.sh needs a real
# `git rev-parse --show-toplevel` and a real index — a plain scan dir like the
# LINT_*_SCAN_DIR hook siblings use won't do), so it never touches this repo's
# own dist directories. No test framework — matches the sibling
# scripts/__tests__/*.test.sh harnesses.
#
# Run from anywhere:  bash scripts/__tests__/check-dist-drift.test.sh
# Exit status: 0 if all cases pass, 1 otherwise.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-dist-drift.sh"

# Every case below must run. Without this, a harness whose cases stop executing
# prints "PASS — all 0 cases" and exits 0 — "all cases passed" and "no case
# executed" are the same observable outcome, the second recurring cause in
# docs/false-safety-guards.md (#7653).
EXPECTED_CASES=6

PASS=0
FAIL=0
FAILED=()

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

REPO="$TMP/fixture-repo"
mkdir -p "$REPO/dist"
(
  cd "$REPO" || exit 1
  git init -q
  git config user.email "check-dist-drift-test@example.com"
  git config user.name "check-dist-drift-test"
  echo 'dist/' > .gitignore
  echo "export const a = 1;" > dist/a.js
  git add .gitignore
  # -f: dist/ is gitignored by the line above, mirroring the real
  # packages/protocol and packages/store-core setup, where the committed dist
  # files are force-added past the blanket ignore.
  git add -f dist/a.js
  git commit -qm init
)

# run_check <dist-dir-arg> -> echoes the script's exit code. Run in a subshell
# so `cd` never leaks into this harness's own cwd.
run_check() {
  ( cd "$REPO" && bash "$CHECK" "$1" ) > /dev/null 2>&1
  echo $?
}

# Case 1 — a clean dist (working tree matches the committed index exactly,
# no stray files) passes.
check "clean dist passes" 0 "$(run_check dist)"

# Case 2 — a tracked dist file whose content was regenerated but not
# recommitted fails. This is the case the OLD `git diff --exit-code` already
# caught; it must keep catching it.
echo "export const a = 2;" > "$REPO/dist/a.js"
check "modified tracked dist file fails" 1 "$(run_check dist)"
# Restore via the committed blob, not `git checkout --` (repo convention: that
# command eats unrelated uncommitted work in a shared tree; here it's just the
# cleanest way to get the exact committed bytes back for the next case).
( cd "$REPO" && git show HEAD:dist/a.js > dist/a.js )
check "...and passes again once restored" 0 "$(run_check dist)"

# Case 3 — THE #8152 case. A NEW file the build emitted lands untracked in
# dist/, which is gitignored, so it's also ignored — invisible to
# `git diff`, visible to `git ls-files --others --ignored --exclude-standard`.
echo "export const b = 1;" > "$REPO/dist/b.js"
check "new untracked+ignored dist file fails (#8152 case)" 1 "$(run_check dist)"
# ...and prove the OLD check (bare `git diff --exit-code`) stays green on
# exactly this fixture, which is the whole reason #8152 exists.
old_check_exit="$( ( cd "$REPO" && git diff --exit-code dist ) > /dev/null 2>&1; echo $? )"
check "the OLD git-diff-only check falsely passes on the same fixture" 0 "$old_check_exit"
rm -f "$REPO/dist/b.js"

# Case 4 — a missing dist directory (build step never ran, or the path
# argument is wrong) fails LOUDLY rather than reporting a silent "clean" —
# docs/false-safety-guards.md: "cannot check" must never read as "nothing to
# check".
check "missing dist directory fails loudly" 1 "$(run_check nonexistent-dist)"

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
