#!/usr/bin/env bash
#
# check-dist-drift.test.sh — Golden test for scripts/check-dist-drift.sh
# (#8152, #8163).
#
# The dist-drift step in ci.yml used to be a bare `git diff --exit-code
# <dist-dir>` after a rebuild. `git diff` only looks at TRACKED paths, and
# dist/ is gitignored, so a NEW file the build emits (a new src/foo.ts
# producing dist/foo.js) is untracked AND ignored — invisible to `git diff` —
# and the check stayed green while the file was never committed. This is the
# "cannot check this" == "nothing to check" class in
# docs/false-safety-guards.md.
#
# #8163 — a SECOND blind spot survived #8152: a tracked dist file whose SOURCE
# was deleted. `tsc` never removes output for a source file no longer in its
# program; the old (post-#8152, pre-#8163) one-argument contract only ran
# `git diff` (content) + `git ls-files --others --ignored` (new files) against
# WHATEVER was already sitting in <dist-dir> — it never rebuilt anything
# itself, so an untouched, now-orphaned tracked file matched neither check and
# the step reported clean. scripts/check-dist-drift.sh now OWNS the build: it
# takes a build command, wipes <dist-dir>, reruns the build from scratch, and
# only then diffs — a source file that no longer exists simply produces
# nothing for it, which turns the orphan into an ordinary tracked-file
# DELETION that `git diff --name-status` reports as `D`.
#
# Drives the script against a TEMP git repo (check-dist-drift.sh needs a real
# `git rev-parse --show-toplevel` and a real index — a plain scan dir like the
# LINT_*_SCAN_DIR hook siblings use won't do), so it never touches this repo's
# own dist directories. The fixture's "build" is a tiny shell script that
# copies `src/*.txt` to `dist/*.js` — a stand-in for `tsc` simple enough to
# control deterministically, but faithful to the one property this test
# depends on: deleting a source file means the build no longer produces its
# output. No test framework — matches the sibling scripts/__tests__/*.test.sh
# harnesses.
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
EXPECTED_CASES=15

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
mkdir -p "$REPO/dist" "$REPO/src"
(
  cd "$REPO" || exit 1
  git init -q
  git config user.email "check-dist-drift-test@example.com"
  git config user.name "check-dist-drift-test"
  echo 'dist/' > .gitignore

  # The fixture's "compiler": copies src/*.txt to dist/*.js VERBATIM (content
  # unchanged). nullglob so an empty src/ (the zero-emit case) produces zero
  # files instead of a literal-glob failure, matching what a real `tsc` with
  # nothing left to compile would do — leave outDir as whatever it already
  # has (here: nothing, since check-dist-drift.sh wipes it first).
  cat > build.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob
mkdir -p dist
for f in src/*.txt; do
  base="$(basename "$f" .txt)"
  cp "$f" "dist/$base.js"
done
SH
  chmod +x build.sh

  # src/a.txt -> dist/a.js and src/orphan.txt -> dist/orphan.js are both
  # "currently built" at commit time: every tracked dist file has a real
  # source behind it, exactly like the real packages/protocol and
  # packages/store-core trees. The committed dist/*.js content MUST equal
  # what build.sh's `cp` actually produces from src/*.txt (verbatim), or
  # "clean tree" is never actually clean once the script does a real rebuild.
  echo "a" > src/a.txt
  echo "orphan" > src/orphan.txt
  cp src/a.txt dist/a.js
  cp src/orphan.txt dist/orphan.js

  # A build command that succeeds but writes nothing — the zero-emit floor.
  cat > empty-build.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p dist
SH
  chmod +x empty-build.sh

  # A build command that always fails — fail-closed on a broken build.
  cat > failing-build.sh <<'SH'
#!/usr/bin/env bash
exit 3
SH
  chmod +x failing-build.sh

  git add .gitignore build.sh empty-build.sh failing-build.sh
  # -f: dist/ is gitignored by the line above, mirroring the real
  # packages/protocol and packages/store-core setup, where the committed dist
  # files are force-added past the blanket ignore. src/ is fixture input, not
  # part of what's under test, and is left untracked.
  git add -f dist/a.js dist/orphan.js
  git commit -qm init
)

# run_check <dist-dir-arg> <build-cmd...> -> echoes the script's exit code.
# Run in a subshell so `cd` never leaks into this harness's own cwd.
run_check() {
  ( cd "$REPO" && bash "$CHECK" "$@" ) > /dev/null 2>&1
  echo $?
}

# old_check_pre_8163 <dist-dir> -> echoes the exit code of the ORIGINAL
# (#8152-era, pre-#8163) one-argument contract: a single dist-dir argument, no
# clean rebuild, just `git diff --name-only` (modified) + `git ls-files
# --others --ignored --exclude-standard` (new/untracked) against whatever is
# already sitting on disk. Reproduced here (not sourced from git history) so
# the RED proof is self-contained and stable regardless of what lands on main
# after this fix — this is exactly the contract check-dist-drift.sh had
# before #8163, the same way the file's existing pre-#8152 proof below inlines
# the bare `git diff --exit-code`.
old_check_pre_8163() {
  local dir="$1" modified untracked
  modified="$(cd "$REPO" && git --literal-pathspecs diff --name-only -- "$dir")"
  untracked="$(cd "$REPO" && git --literal-pathspecs ls-files --others --ignored --exclude-standard -- "$dir")"
  if [ -n "$modified" ] || [ -n "$untracked" ]; then
    echo 1
  else
    echo 0
  fi
}

# Case 1 — a clean dist (a fresh build reproduces exactly what's committed,
# byte for byte) passes.
check "clean dist passes" 0 "$(run_check dist ./build.sh)"

# Case 2 — the SOURCE for a tracked file changed (so a fresh rebuild no longer
# matches the committed bytes) fails. This is the case the OLD `git diff
# --exit-code` already caught; it must keep catching it under a clean rebuild.
echo "a-modified" > "$REPO/src/a.txt"
check "modified tracked dist file fails" 1 "$(run_check dist ./build.sh)"
echo "a" > "$REPO/src/a.txt"
check "...and passes again once the source is restored" 0 "$(run_check dist ./build.sh)"

# Case 3 — THE #8152 case. A NEW source produces a file the build emits that
# lands untracked in dist/, which is gitignored, so it's also ignored —
# invisible to `git diff`, visible to `git ls-files --others --ignored
# --exclude-standard`.
echo "b" > "$REPO/src/b.txt"
check "new untracked+ignored dist file fails (#8152 case)" 1 "$(run_check dist ./build.sh)"
# ...and prove the OLD naive check (bare `git diff --exit-code`, pre-#8152)
# stays green on exactly this fixture, which is the whole reason #8152 exists.
old_naive_exit="$( ( cd "$REPO" && git diff --exit-code dist ) > /dev/null 2>&1; echo $? )"
check "the OLD pre-#8152 git-diff-only check falsely passes on the same fixture" 0 "$old_naive_exit"
rm -f "$REPO/src/b.txt" "$REPO/dist/b.js"

# Case 4 — THE #8163 case. The source for a tracked dist file is removed
# (without the corresponding dist file being touched). A clean rebuild simply
# does not reproduce it, which check-dist-drift.sh must report as an orphan —
# and name the file.
rm -f "$REPO/src/orphan.txt"
# Prove the RED case FIRST, against the pristine "source just deleted, dist/
# untouched" state — this is the real #8163 scenario, and the only state in
# which the OLD (post-#8152, pre-#8163) one-argument contract can be shown to
# falsely pass: nothing on disk under dist/ has changed yet (only
# src/orphan.txt was removed), so the old check's bare content/untracked
# comparison sees no difference at all and reports clean. Reproduced here
# (not sourced from git history) so the RED proof is self-contained and
# stable regardless of what lands on main after this fix. Running this AFTER
# the new script below would be meaningless: the new script's own clean
# rebuild already deletes dist/orphan.js from the working tree, and even the
# OLD check's bare `git diff` would then correctly see that as a removal.
check "the OLD pre-#8163 check-dist-drift.sh falsely passes on the same fixture" 0 "$(old_check_pre_8163 dist)"
orphan_output="$( cd "$REPO" && bash "$CHECK" dist ./build.sh 2>&1 )"
orphan_exit=$?
check "orphaned tracked dist file fails (#8163 case)" 1 "$orphan_exit"
case "$orphan_output" in
  *"dist/orphan.js"*) check "...and the failure message names the orphaned file" 0 0 ;;
  *) check "...and the failure message names the orphaned file" 0 1 ;;
esac
# Restore: check-dist-drift.sh's own run above already rebuilt dist/ without
# orphan.js (a real tracked-file deletion in the working tree); put it back
# via the committed blob so later cases start from a known-clean state.
( cd "$REPO" && git show HEAD:dist/orphan.js > dist/orphan.js )
echo "orphan" > "$REPO/src/orphan.txt"
check "clean dist passes again once source+dist are both restored" 0 "$(run_check dist ./build.sh)"

# Case 5 — the zero-emit floor: a build command that exits 0 but writes
# nothing must still fail (docs/false-safety-guards.md: "cannot check" must
# never read as "nothing to check"), and it must leave the pre-existing dist/
# exactly as it found it rather than stranding it wiped.
check "zero-emit build fails closed" 1 "$(run_check dist ./empty-build.sh)"
check "...and dist is left byte-identical to HEAD after a zero-emit build" "" "$( ( cd "$REPO" && git status --short -- dist ) )"

# Case 6 — a build command that fails outright must fail closed, and must
# likewise leave the pre-existing dist/ untouched.
check "failing build command fails closed" 1 "$(run_check dist ./failing-build.sh)"
check "...and dist is left byte-identical to HEAD after a failed build" "" "$( ( cd "$REPO" && git status --short -- dist ) )"

# Case 7 — usage error: fewer than 2 arguments (dist-dir + build command) is
# a usage error, not a silent pass.
check "missing build command is a usage error" 2 "$(run_check dist)"
check "no arguments at all is a usage error" 2 "$(run_check)"

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
