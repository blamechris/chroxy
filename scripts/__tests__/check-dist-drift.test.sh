#!/usr/bin/env bash
#
# check-dist-drift.test.sh — Golden test for scripts/check-dist-drift.sh
# (#8152, #8163, and the #8163 PR review).
#
# The dist-drift step in ci.yml used to be a bare `git diff --exit-code
# <dist-dir>` after a rebuild. `git diff` only looks at TRACKED paths, and
# dist/ is gitignored, so a NEW file the build emits (a new src/foo.ts
# producing dist/foo.js) is untracked — invisible to `git diff` — and the
# check stayed green while the file was never committed. This is the "cannot
# check this" == "nothing to check" class in docs/false-safety-guards.md.
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
# THE #8163 PR REVIEW found three more problems, all covered below:
#   C1. Owning the build means owning `mv`/`rm -rf` on a caller-supplied path.
#       An unvalidated `<dist-dir>` let a reviewer permanently delete the
#       directory CONTAINING the repo (`../../outer`) and a sibling directory
#       (`../sibling`) in reproducible sandboxes. `validate_dist_dir()` in the
#       script now rejects every such shape before anything is moved; the
#       cases below prove each rejection, in a disposable sandbox, with a
#       canary file checksummed before and after.
#   C2. (Fixed in packages/server/tests/helpers/workflow-reader.js, not here —
#       the CI npm-resolve-budget guard needed to learn this script's argv
#       shape, which is a workflow-reader concern, not this script's.)
#   C3. The untracked-file check used to list only IGNORED untracked files
#       (`git ls-files --others --ignored --exclude-standard`), which misses
#       an untracked file that matches a package's own `!dist/<file>`
#       negation — store-core's real shape. Fixed by dropping `--ignored
#       --exclude-standard` entirely; Case 3b below reproduces the real
#       false-green and proves the fix closes it.
#
# Drives the script against TEMP git repos (check-dist-drift.sh needs a real
# `git rev-parse --show-toplevel` and a real index — a plain scan dir like the
# LINT_*_SCAN_DIR hook siblings use won't do), so it never touches this repo's
# own dist directories, and NEVER passes this script a path outside its own
# throwaway fixtures. The fixture's "build" is a tiny shell script that copies
# `src/*.txt` to `dist/*.js` — a stand-in for `tsc` simple enough to control
# deterministically, but faithful to the one property this test depends on:
# deleting a source file means the build no longer produces its output. No
# test framework — matches the sibling scripts/__tests__/*.test.sh harnesses.
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
EXPECTED_CASES=48

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
  # `dist/*` (not the blanket `dist/`), mirroring the real
  # packages/store-core .gitignore exactly: git's own documented negation
  # limitation is "it is not possible to re-include a file if a parent
  # directory of that file is excluded" — a bare `dist/` pattern excludes the
  # DIRECTORY itself, so a later `!dist/keep.js` negation (Case 3b, C3) would
  # silently fail to take effect and the fixture would not reproduce the real
  # bug. `dist/*` excludes only the CONTENTS, which is what makes per-file
  # negation work at all.
  echo 'dist/*' > .gitignore

  # The fixture's "compiler": copies src/*.txt to dist/*.js VERBATIM (content
  # unchanged). nullglob so an empty src/ produces zero files instead of a
  # literal-glob failure, matching what a real `tsc` with nothing left to
  # compile would do — leave outDir as whatever it already has (here:
  # nothing, since check-dist-drift.sh wipes it first).
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

  # A build command that succeeds but writes nothing — the zero-emit floor,
  # exercised here against a fixture that ALSO has tracked files (so the
  # ordinary orphan/`D` mechanism would independently fail this case too;
  # Case 5b below isolates the floor itself against a dist dir with NO
  # tracked files at all, where nothing else could catch it).
  cat > empty-build.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p dist
SH
  chmod +x empty-build.sh

  # A build command that fails WITHOUT emitting anything.
  cat > failing-build-empty.sh <<'SH'
#!/usr/bin/env bash
exit 3
SH
  chmod +x failing-build-empty.sh

  # A build command that emits EVERYTHING the real build would (so the
  # zero-emit floor cannot be what catches it) and THEN fails. This is the
  # `tsc` shape a review found untested: `noEmitOnError: false` means a type
  # error still produces full output before `tsc` exits non-zero. A mutant
  # that replaces `|| BUILD_OK=0` with `|| true` passes the empty-build case
  # above (zero-emit floor still fires) but NOT this one, where the floor is
  # satisfied and only the build's own exit status can fail the check.
  cat > failing-build-full.sh <<'SH'
#!/usr/bin/env bash
set -e
shopt -s nullglob
mkdir -p dist
for f in src/*.txt; do
  base="$(basename "$f" .txt)"
  cp "$f" "dist/$base.js"
done
exit 2
SH
  chmod +x failing-build-full.sh

  git add .gitignore build.sh empty-build.sh failing-build-empty.sh failing-build-full.sh
  # -f: dist/ is gitignored by the line above, mirroring the real
  # packages/protocol and packages/store-core setup, where the committed dist
  # files are force-added past the blanket ignore. src/ is fixture input, not
  # part of what's under test, and is left untracked.
  git add -f dist/a.js dist/orphan.js
  git commit -qm init

  # A directory that EXISTS on disk but has zero tracked (or untracked)
  # content under it at all — git does not track empty directories, ignored
  # or not, so this survives the commit above untouched. Its own basename
  # must still be "dist" to pass validation; nested one level down so it does
  # not collide with the main fixture's dist/.
  mkdir -p emptypkg/dist
)

# run_check <dist-dir-arg> <build-cmd...> -> echoes the script's exit code.
# Run in a subshell so `cd` never leaks into this harness's own cwd.
run_check() {
  ( cd "$REPO" && bash "$CHECK" "$@" ) > /dev/null 2>&1
  echo $?
}

# run_check_capture <dist-dir-arg> <build-cmd...> -> prints "EXIT\nOUTPUT".
run_check_capture() {
  local out ec
  out="$( cd "$REPO" && bash "$CHECK" "$@" 2>&1 )"
  ec=$?
  printf '%s\n%s' "$ec" "$out"
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

# checksum_tree <dir> -> a stable, order-independent content fingerprint of
# every file under <dir>, used to prove a REJECTED path never touched
# anything (C1's sandbox cases run against a throwaway tree built just for
# them, never against this harness's own fixture or $REPO_ROOT).
checksum_tree() {
  find "$1" -type f -exec shasum {} \; 2> /dev/null | sort
}

# ═══════════════════════════════════════════════════════════════════════
# Case 1 — a clean dist (a fresh build reproduces exactly what's committed,
# byte for byte) passes.
# ═══════════════════════════════════════════════════════════════════════
check "clean dist passes" 0 "$(run_check dist ./build.sh)"

# ═══════════════════════════════════════════════════════════════════════
# Case 2 — the SOURCE for a tracked file changed (so a fresh rebuild no
# longer matches the committed bytes) fails.
# ═══════════════════════════════════════════════════════════════════════
echo "a-modified" > "$REPO/src/a.txt"
check "modified tracked dist file fails" 1 "$(run_check dist ./build.sh)"
echo "a" > "$REPO/src/a.txt"
check "...and passes again once the source is restored" 0 "$(run_check dist ./build.sh)"

# ═══════════════════════════════════════════════════════════════════════
# Case 3 — THE #8152 case. A NEW source produces a file the build emits
# that lands untracked (and ignored) in dist/.
# ═══════════════════════════════════════════════════════════════════════
echo "b" > "$REPO/src/b.txt"
check "new untracked+ignored dist file fails (#8152 case)" 1 "$(run_check dist ./build.sh)"
old_naive_exit="$( ( cd "$REPO" && git diff --exit-code dist ) > /dev/null 2>&1; echo $? )"
check "the OLD pre-#8152 git-diff-only check falsely passes on the same fixture" 0 "$old_naive_exit"
rm -f "$REPO/src/b.txt" "$REPO/dist/b.js"
check "...and passes again once cleaned up" 0 "$(run_check dist ./build.sh)"

# ═══════════════════════════════════════════════════════════════════════
# Case 3b — THE C3 REVIEW FINDING. An untracked file that matches a
# package's own `!dist/<file>` negation is NOT ignored (git considers a
# negated path un-ignored by definition), so `--ignored --exclude-standard`
# never lists it either. Reproduced against the fixture's OWN negation
# shape, mirroring the real store-core `!dist/crypto.d.ts` case.
# ═══════════════════════════════════════════════════════════════════════
(
  cd "$REPO" || exit 1
  echo '!dist/keep.js' >> .gitignore
  echo "keep" > src/keep.txt
  echo "keep" > dist/keep.js
  git add .gitignore
  git add -f dist/keep.js
  git commit -qm 'add negated dist/keep.js'
)
check "clean dist (with a negated file) passes" 0 "$(run_check dist ./build.sh)"
(cd "$REPO" && git rm --cached -q dist/keep.js)
untracked_not_ignored="$(cd "$REPO" && git --literal-pathspecs ls-files --others --ignored --exclude-standard -- dist)"
case "$untracked_not_ignored" in
  *dist/keep.js*) check "RED PROOF: the OLD --ignored check misses the negated file once un-indexed" missed found ;;
  *) check "RED PROOF: the OLD --ignored check misses the negated file once un-indexed" missed missed ;;
esac
check "an untracked-but-not-ignored negated file now fails (C3)" 1 "$(run_check dist ./build.sh)"
# Re-add to the INDEX only — `git diff`/`git status` compare against the
# index, not HEAD, so there is nothing new to commit here: the re-added blob
# is byte-identical to the one HEAD already has. `git commit` at this point
# would have nothing staged relative to HEAD and print its own "nothing to
# commit" notice despite `-q`.
(cd "$REPO" && git add -f dist/keep.js)
check "...and passes again once the negated file is re-tracked" 0 "$(run_check dist ./build.sh)"

# ═══════════════════════════════════════════════════════════════════════
# Case 4 — THE #8163 case. The source for a tracked dist file is removed
# (without the corresponding dist file being touched).
# ═══════════════════════════════════════════════════════════════════════
rm -f "$REPO/src/orphan.txt"
# Prove the RED case FIRST, against the pristine "source just deleted, dist/
# untouched" state — the only state in which the OLD (post-#8152, pre-#8163)
# one-argument contract can be shown to falsely pass. Running this AFTER the
# new script below would be meaningless: the new script's own clean rebuild
# already deletes dist/orphan.js from the working tree.
check "the OLD pre-#8163 check-dist-drift.sh falsely passes on the same fixture" 0 "$(old_check_pre_8163 dist)"
orphan_result="$(run_check_capture dist ./build.sh)"
orphan_exit="${orphan_result%%$'\n'*}"
orphan_output="${orphan_result#*$'\n'}"
check "orphaned tracked dist file fails (#8163 case)" 1 "$orphan_exit"
# The combined substring, not "dist/orphan.js" anywhere in the output: a
# review found that collapsing the D) bucket into the modified (M) bucket in
# the SCRIPT survives an assertion that only looks for the filename, since
# the filename still appears under the wrong header. This requires BOTH the
# distinguishing header text and the filename together.
case "$orphan_output" in
  *"Orphaned tracked file(s)"*"dist/orphan.js"*) check "...and the failure names it as ORPHANED, not modified" 0 0 ;;
  *) check "...and the failure names it as ORPHANED, not modified" 0 1 ;;
esac
# Restore: check-dist-drift.sh's own run above already rebuilt dist/ without
# orphan.js (a real tracked-file deletion in the working tree); put it back
# via the committed blob so later cases start from a known-clean state.
( cd "$REPO" && git show HEAD:dist/orphan.js > dist/orphan.js )
echo "orphan" > "$REPO/src/orphan.txt"
check "clean dist passes again once source+dist are both restored" 0 "$(run_check dist ./build.sh)"

# ═══════════════════════════════════════════════════════════════════════
# Case 5 — the zero-emit floor, against a fixture that ALSO has tracked
# files (so the `D` mechanism alone would independently catch this too).
# ═══════════════════════════════════════════════════════════════════════
check "zero-emit build fails closed" 1 "$(run_check dist ./empty-build.sh)"
check "...and dist is left byte-identical to the index after a zero-emit build" "" "$( ( cd "$REPO" && git status --short -- dist ) )"

# ═══════════════════════════════════════════════════════════════════════
# Case 5b — the zero-emit floor ISOLATED: a dist dir with NO tracked files
# at all, where `git diff`/`git ls-files --others` both report nothing
# either way. Without the explicit file-count floor, this fixture would
# read as clean — the review's point that the original empty-build case
# was "killed only through the byte-identical restore assertion", never
# through a fixture where the floor is the ONLY thing that can fail it.
# ═══════════════════════════════════════════════════════════════════════
(
  cd "$REPO" || exit 1
  cat > empty-build2.sh <<'SH'
#!/usr/bin/env bash
set -e
mkdir -p emptypkg/dist
SH
  chmod +x empty-build2.sh
)
diff_empty="$(cd "$REPO" && git --literal-pathspecs diff --name-only -- emptypkg/dist)"
ls_empty="$(cd "$REPO" && git --literal-pathspecs ls-files --others -- emptypkg/dist)"
check "CONTROL: an empty dist dir shows no diff at all (isolating the floor)" "" "$diff_empty$ls_empty"
check "zero-emit floor fires even with ZERO tracked files to diff against" 1 "$(run_check emptypkg/dist ./empty-build2.sh)"

# ═══════════════════════════════════════════════════════════════════════
# Case 6 — a build command that fails, in TWO shapes: emitting nothing (the
# original case) and emitting everything and THEN failing (S2: the `tsc`
# shape, which the zero-emit floor cannot catch — only the build's own exit
# status can).
# ═══════════════════════════════════════════════════════════════════════
check "failing build (emits nothing) fails closed" 1 "$(run_check dist ./failing-build-empty.sh)"
check "...and dist is left byte-identical after a failed empty build" "" "$( ( cd "$REPO" && git status --short -- dist ) )"
check "failing build (emits everything first) STILL fails closed" 1 "$(run_check dist ./failing-build-full.sh)"
check "...and dist is left byte-identical after a failed full build" "" "$( ( cd "$REPO" && git status --short -- dist ) )"

# ═══════════════════════════════════════════════════════════════════════
# Case 6b — a git failure mid-check aborts non-zero rather than reporting
# clean. A PATH-shimmed `git` that fails specifically on `diff`, with a
# real orphan present so there is something a passing check would have to
# see and report.
# ═══════════════════════════════════════════════════════════════════════
GITSHIM_DIR="$TMP/gitshim"
mkdir -p "$GITSHIM_DIR"
cat > "$GITSHIM_DIR/git" <<SH
#!/usr/bin/env bash
for a in "\$@"; do
  if [ "\$a" = "diff" ]; then
    echo "SHIMMED-GIT-DIFF-FAILURE" >&2
    exit 128
  fi
done
exec "$(command -v git)" "\$@"
SH
chmod +x "$GITSHIM_DIR/git"
rm -f "$REPO/src/orphan.txt"
shim_exit="$( ( cd "$REPO" && PATH="$GITSHIM_DIR:$PATH" bash "$CHECK" dist ./build.sh ) > /dev/null 2>&1; echo $? )"
check "a git failure mid-check aborts non-zero, not a false clean" "nonzero" "$([ "$shim_exit" -ne 0 ] && echo nonzero || echo zero)"
( cd "$REPO" && git show HEAD:dist/orphan.js > dist/orphan.js )
echo "orphan" > "$REPO/src/orphan.txt"
check "...and dist is restored after the shimmed-git abort" 0 "$(run_check dist ./build.sh)"

# ═══════════════════════════════════════════════════════════════════════
# Case 7 — usage errors: fewer than 2 arguments, or a <dist-dir> that fails
# validation, are usage errors (exit 2), never a silent pass.
# ═══════════════════════════════════════════════════════════════════════
check "missing build command is a usage error" 2 "$(run_check dist)"
check "no arguments at all is a usage error" 2 "$(run_check)"

# ═══════════════════════════════════════════════════════════════════════
# Case 8 — C1: path validation. Every one of these must be rejected with
# exit 2 BEFORE anything is moved or deleted, proven with a throwaway
# sandbox tree and a canary file checksummed before and after. This is the
# review's reproduced data-loss set: an unvalidated `<dist-dir>` permanently
# deleted the directory containing the repo and a sibling directory in
# disposable sandboxes built for exactly this purpose.
# ═══════════════════════════════════════════════════════════════════════
SANDBOX="$TMP/c1-sandbox"
mkdir -p "$SANDBOX/repo/pkg/dist" "$SANDBOX/repo/.git-marker"
echo "canary" > "$SANDBOX/canary.txt"
(
  cd "$SANDBOX/repo" || exit 1
  git init -q
  git config user.email t@example.com
  git config user.name t
  echo "x" > pkg/dist/a.js
  git add -A
  git commit -qm init
)
check_path_rejected() {
  local desc="$1" distdir="$2"
  local before after ec
  before="$(checksum_tree "$SANDBOX")"
  ( cd "$SANDBOX/repo" && bash "$CHECK" "$distdir" true ) > /dev/null 2>&1
  ec=$?
  after="$(checksum_tree "$SANDBOX")"
  check "C1: $desc -> exit 2" 2 "$ec"
  check "C1: $desc -> sandbox byte-identical after" "$before" "$after"
}

check_path_rejected "absolute path" "/pkg/dist"
check_path_rejected "../../outer (contains the repo)" "../../outer"
check_path_rejected "../sibling" "../sibling"
check_path_rejected "root (/)" "/"
check_path_rejected "single dot (.)" "."
check_path_rejected "double dot (..)" ".."
check_path_rejected "wrong basename" "pkg/distx"

# A symlinked dist dir pointing outside the repo, named exactly "dist" (so
# only the symlink check — not the basename check — can reject it).
mkdir -p "$SANDBOX/outside-target"
echo "secret" > "$SANDBOX/outside-target/keep.txt"
mkdir -p "$SANDBOX/repo/pkg2"
ln -s "$SANDBOX/outside-target" "$SANDBOX/repo/pkg2/dist"
check_path_rejected "symlinked dist dir named exactly 'dist'" "pkg2/dist"

# A directory literally named with git pathspec magic — used to demonstrate
# the (now moot) `--literal-pathspecs` scenario a review found untested: the
# basename validation rejects it outright before that flag ever matters.
mkdir -p "$SANDBOX/repo/pkg3/:(glob)dist"
check_path_rejected "pathspec-magic directory name" "pkg3/:(glob)dist"

# ═══════════════════════════════════════════════════════════════════════
# Case 9 — S1: a signal during the build restores the pre-existing dist/
# rather than leaving it wiped. SIGTERM to the check script's own process
# (bash waits for the foreground build child before running the trap).
# ═══════════════════════════════════════════════════════════════════════
SIGREPO="$TMP/sig-repo"
mkdir -p "$SIGREPO/pkg/dist"
(
  cd "$SIGREPO" || exit 1
  git init -q
  git config user.email t@example.com
  git config user.name t
  echo "original" > pkg/dist/a.js
  git add -A
  git commit -qm init
  cat > slow-build.sh <<'SH'
#!/usr/bin/env bash
sleep 5
mkdir -p pkg/dist
echo changed > pkg/dist/a.js
SH
  chmod +x slow-build.sh
)
# killtree <pid> — SIGTERM every descendant of <pid>, deepest first, then
# <pid> itself. Needed because the process chain here is FOUR deep (this
# harness's background job -> check-dist-drift.sh -> its internal build
# subshell -> slow-build.sh's `sleep`), and bash defers running its own EXIT/
# TERM trap until its current FOREGROUND command finishes. Signalling only
# the top PID leaves the actual `sleep` untouched, so check-dist-drift.sh
# would not observe the pending signal until the 5-second sleep ended on its
# own — a false pass that looks identical to a correctly-fast restore in a
# harness that does not bound the wait. No process-group / job-control setup
# (`set -m`) is assumed, since it is unavailable in some non-interactive
# shells this harness runs under; walking `pgrep -P` down to the real leaf
# process is portable without it.
killtree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2> /dev/null); do
    killtree "$child"
  done
  kill -TERM "$pid" 2> /dev/null
}

# `exec` inside the subshell replaces it with check-dist-drift.sh itself
# (rather than leaving a `cd && bash ...` wrapper process on top of it), so
# $! is the script's own PID and `killtree` starts one level higher than it
# would otherwise need to.
( cd "$SIGREPO" && exec bash "$CHECK" pkg/dist ./slow-build.sh ) > /dev/null 2>&1 &
SIGPID=$!
sleep 1
killtree "$SIGPID"
wait "$SIGPID" 2>/dev/null
SIGEC=$?
check "SIGTERM mid-build exits with the conventional 128+15 code" 143 "$SIGEC"
check "...and dist is restored to its pre-build content" "original" "$(cat "$SIGREPO/pkg/dist/a.js" 2> /dev/null)"
check "...and git status is clean after the signal" "" "$( ( cd "$SIGREPO" && git status --short -- pkg/dist ) )"
check "...and no backup directory is left behind" "" "$(find "$SIGREPO/pkg" -maxdepth 1 -name '.check-dist-drift-backup*' 2> /dev/null)"

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
