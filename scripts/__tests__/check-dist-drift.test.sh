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

# CDPATH= cd --: a bare `cd "$(dirname "$0")/../.."` is CDPATH-sensitive — a
# review found that with CDPATH set to the worktree's own path, `cd` prints
# the match it found instead of changing silently, which corrupts this
# command substitution into a two-line string and fails every case closed
# (every `run_check` call then resolves $CHECK to a nonexistent path and
# exits 127, which happens to still not equal most expected exit codes, so
# the harness fails loud rather than passing for the wrong reason — but loud
# in the wrong way, not the intended one). `CDPATH=` scopes the reset to this
# one command; `--` stops `cd` from re-parsing a leading `-` in the path as an
# option.
# shellcheck disable=SC1007 # deliberate: CDPATH= resets it to empty for this
# one command, the standard idiom — not a mistaken "forgot a value" typo.
REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-dist-drift.sh"

# Every case below must run. Without this, a harness whose cases stop executing
# prints "PASS — all 0 cases" and exits 0 — "all cases passed" and "no case
# executed" are the same observable outcome, the second recurring cause in
# docs/false-safety-guards.md (#7653).
EXPECTED_CASES=120

PASS=0
FAIL=0
FAILED=()

# RESULTLOG: round 3 found a case ("RED PROOF: round-1's prefix-only
# containment accepts the same symlink") whose `check` call ran inside a
# PIPELINE subshell (`cmd | { read x; check ...; }`), so its PASS/FAIL
# increment was silently discarded when that subshell exited — the printed
# "NOT  - ..." line was real (87 of them, forced by the reviewer), but the
# harness still summed to 86 and exited 0. A subshell losing a variable
# INCREMENT is exactly the shape `set -e`/pipe-exit-code bugs take in this
# repo's own experience; a FILE APPEND is not lost the same way, because it
# is a real filesystem side effect rather than shell state scoped to the
# subshell. `check()` now appends its own verdict line here on every call,
# subshell or not, and the final tally (below) is cross-checked against
# THIS file's line count — not only against PASS+FAIL — so a future case
# with the same subshell mistake fails loud instead of silently vanishing.
RESULTLOG="$(mktemp)"

# check <name> <expected-exit> <actual-exit>
check() {
  if [ "$2" = "$3" ]; then
    PASS=$((PASS + 1)); echo "ok   - $1"; echo "ok" >> "$RESULTLOG"
  else
    FAIL=$((FAIL + 1)); FAILED+=("$1 (expected exit $2, got $3)"); echo "NOT  - $1 (expected exit $2, got $3)"; echo "NOT" >> "$RESULTLOG"
  fi
}

TMP="$(mktemp -d)"
# ONE trap: a second `trap ... EXIT` would silently REPLACE the first rather
# than stacking, which would have left either $TMP or $RESULTLOG uncleaned.
trap 'rm -rf "$TMP"; rm -f "$RESULTLOG"' EXIT

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
# check_path_rejected <desc> <dist-dir> [expected-message-substring]
#
# The optional third argument pins WHICH validation layer fired, not just
# that SOME layer did — a round-2 review found that every original case here
# is caught by two or more overlapping layers (the target doesn't exist, the
# basename is wrong, a segment is empty, ...), so deleting any ONE layer left
# this harness green. Asserting the message is what turns "some check still
# rejects this" into "THIS specific check does".
check_path_rejected() {
  local desc="$1" distdir="$2" expect_msg="${3:-}"
  local before after ec out
  before="$(checksum_tree "$SANDBOX")"
  out="$( cd "$SANDBOX/repo" && bash "$CHECK" "$distdir" true 2>&1 )"
  ec=$?
  after="$(checksum_tree "$SANDBOX")"
  check "C1: $desc -> exit 2" 2 "$ec"
  check "C1: $desc -> sandbox byte-identical after" "$before" "$after"
  if [ -n "$expect_msg" ]; then
    case "$out" in
      *"$expect_msg"*) check "C1: $desc -> message names the right layer" 0 0 ;;
      *) check "C1: $desc -> message names the right layer" "0 (wanted: $expect_msg)" "1 (got: $out)" ;;
    esac
  fi
}

check_path_rejected "absolute path" "/pkg/dist" "not absolute"
check_path_rejected "../../outer (contains the repo)" "../../outer" "'..' path component"
check_path_rejected "../sibling" "../sibling" "'..' path component"
check_path_rejected "root (/)" "/" "not absolute"
check_path_rejected "single dot (.)" "." "'..' path component"
check_path_rejected "double dot (..)" ".." "'..' path component"
check_path_rejected "wrong basename" "pkg/distx" "named exactly 'dist'"

# A symlinked dist dir pointing outside the repo, named exactly "dist" (so
# only the symlink check — not the basename check — can reject it).
mkdir -p "$SANDBOX/outside-target"
echo "secret" > "$SANDBOX/outside-target/keep.txt"
mkdir -p "$SANDBOX/repo/pkg2"
ln -s "$SANDBOX/outside-target" "$SANDBOX/repo/pkg2/dist"
check_path_rejected "symlinked dist dir named exactly 'dist'" "pkg2/dist" "must not be a symlink"

# A `<dist-dir>` containing a literal control character (a newline here).
# Round 2: `IFS='/' read -ra` only reads the FIRST LINE of its input, so a
# `..` sitting after an embedded newline was never segment-checked — a real
# on-disk directory literally named "a<newline>", containing a symlink out of
# the repo, reached the physical-containment check with that embedded `..`
# never rejected by the string-level scan. Rejected up front now, before any
# segment scan even runs.
check_path_rejected "embedded newline" "$(printf 'a\n/link/../dist')" "control characters"

# ═══ H1 (round-2 S1): a symlinked INTERMEDIATE component pointing OUTSIDE the
# repo, with the dist dir's OWN basename spelled correctly ("dist"). This is
# the one shape physical containment — not any string-level rule — must
# catch; round 1's harness had no case that isolated it (every symlink case
# used a symlinked dist dir ITSELF, caught by the separate `-L` check before
# containment is even reached).
mkdir -p "$SANDBOX/h1-external/dist"
echo "h1-victim" > "$SANDBOX/h1-external/dist/victim.js"
mkdir -p "$SANDBOX/repo/pkgh1"
ln -s "$SANDBOX/h1-external" "$SANDBOX/repo/pkgh1/outlink"
check_path_rejected "H1: symlinked intermediate resolves outside the repo" "pkgh1/outlink/dist" "outside the repo root"

# ═══ H6 (round-2 S1): `.git/dist` exists and is targeted DIRECTLY (no case
# trick needed — this isolates the `.git` RULE itself, so a mutant that
# removes it is caught regardless of whether this filesystem's case
# sensitivity can reproduce the APFS-specific variant too). Round 3: caught
# by the EARLIER string-level per-segment scan now, not the physical
# containment check's own narrower (top-level-only) `.git` branch — both
# reject it, but the earlier-firing layer's message is what a caller sees.
mkdir -p "$SANDBOX/repo/.git/dist"
check_path_rejected "H6: .git/dist is refused" ".git/dist" "'.git' path component"

# ═══ S4/N2 (round 3): a NESTED `.git` — a non-submodule, vendored/checked-in
# repo sitting inside this repo, e.g. `packages/sub/.git/dist` — is the
# shape the physical containment check's `.git` branch NEVER caught (it only
# ever compared against the TOP-level `$REPO_REAL/.git`), and the ONLY
# shape that isolates the per-segment string rule from the top-level case
# above: deleting just this rule (leaving the top-level-specific physical
# branch intact) still passes the H6 case above but must fail THIS one.
mkdir -p "$SANDBOX/repo/pkgs4/sub/.git/dist"
check_path_rejected "S4: a NESTED .git component (packages/sub/.git/dist) is refused" "pkgs4/sub/.git/dist" "'.git' path component"

# ═══ S3 (round 3): the CASE-VARIANT closure (`/bin/pwd -P` resolving
# through to the filesystem's canonical stored case) only has a sandbox to
# run in on a case-insensitive-but-preserving filesystem — APFS, the macOS
# default, but NOT Linux CI's case-sensitive filesystem. "Cannot check this"
# must never silently read as "nothing to check" (docs/false-safety-
# guards.md): detected at runtime (`touch a; [ -e A ]`), this prints a
# visible SKIP line when it cannot run rather than omitting the case
# silently, and stays COUNT-NEUTRAL either way — exactly one `check` call on
# both branches — so EXPECTED_CASES does not have to differ between a
# case-insensitive Mac and case-sensitive CI.
CASE_PROBE="$TMP/case-probe"
mkdir -p "$CASE_PROBE"
touch "$CASE_PROBE/a"
if [ -e "$CASE_PROBE/A" ]; then
  # Case-insensitive: ".GIT/dist" resolves via case-insensitive lookup to
  # the SAME real "repo/.git/dist" H6 already created; /bin/pwd -P must
  # report it back in its CANONICAL (lowercase) stored case for the
  # physical-containment ".git" branch to recognise it.
  case_variant_output="$( cd "$SANDBOX/repo" && bash "$CHECK" ".GIT/dist" true 2>&1 )"
  case_variant_exit=$?
  case "$case_variant_output" in
    *"inside .git"*) case_variant_msg_ok=0 ;;
    *) case_variant_msg_ok=1 ;;
  esac
  check "S3: case-insensitive fs — '.GIT/dist' resolves to the real .git and is refused" "2 0" "$case_variant_exit $case_variant_msg_ok"

  # NOTE on what is deliberately NOT asserted here: swapping the builtin
  # `pwd -P` back in (the X1 mutant a round-3 review used to prove the
  # external binary is load-bearing) does NOT reliably reopen the bypass on
  # every case-insensitive volume — measured directly on this sandbox's
  # `/private/tmp` (APFS, case-insensitive): the builtin and `/bin/pwd -P`
  # returned the SAME canonical case here, unlike the reviewer's dedicated,
  # freshly-mounted disk image with a cold vnode cache. A mutant assertion
  # that only sometimes reproduces its own claimed finding is worse than no
  # assertion — it would read as proof on a volume where it proves nothing.
  # The reviewer's own methodology (a fresh `hdiutil`-created image,
  # detached and reattached before the first lookup) is what actually
  # isolates this; it is not reproducible as a single portable harness case.
else
  echo "SKIP (case-sensitive filesystem): S3's case-variant closure cannot be exercised here"
  check "S3: case-insensitive fs — '.GIT/dist' resolves to the real .git and is refused" "SKIP (case-sensitive fs)" "SKIP (case-sensitive fs)"
fi

# A directory literally named with git pathspec magic, moved to the FIRST
# path component (round-2 S3): magic is a prefix of the WHOLE pathspec
# string, not of the last component, so `:(glob)pkg3/dist` has an ordinary
# basename and passes validation while still being magic to git — this is
# the shape that actually exercises `--literal-pathspecs`, unlike round 1's
# `pkg3/:(glob)dist` (magic on the LAST component, caught by the basename
# rule alone and never reaching git). This one is accepted by validation and
# verified for real orphan detection in its own case below, not rejected
# here.

# ═══════════════════════════════════════════════════════════════════════
# Case 8b — R2 (round 3), THE ROUND-2 FALSE GREEN, PROPERLY ISOLATED. The
# round-3 review found this case's ORIGINAL fixture — a symlink literally
# NAMED `linked-dist` — never reached the exact-match containment check at
# all: `linked-dist` does not end in a component named `dist`, so the
# BASENAME rule rejects it first (`<dist-dir> must be a path ending in a
# component named exactly 'dist', got: linked-dist`), and reverting the
# exact-match fix to round 1's prefix-only logic left this harness green —
# the one thing round 2 was blocking on would have gone unnoticed.
#
# The corrected fixture matches the ACTUAL npm-workspace shape: the symlink
# is an INTERMEDIATE component (`alias`), and the dist-dir ARGUMENT's own
# LAST component is literally `dist` (`alias/dist`) — passing the basename
# rule and the dist-itself-symlink check, so only the exact-match physical-
# containment comparison can reject it.
# ═══════════════════════════════════════════════════════════════════════
(
  cd "$REPO" || exit 1
  mkdir -p real-pkg/dist
  echo "fg" > src/fg.txt
  echo "fg" > real-pkg/dist/fg.js
  echo "fg-orphan" > real-pkg/dist/fg-orphan.js
  git add -f real-pkg/dist/fg.js real-pkg/dist/fg-orphan.js
  git commit -qm 'add real-pkg with an about-to-be-orphaned file'
  ln -s real-pkg alias
  cat > fg-build.sh <<'SH'
#!/usr/bin/env bash
set -e
mkdir -p real-pkg/dist
echo "fg" > real-pkg/dist/fg.js
# fg-orphan.js deliberately not recreated
SH
  chmod +x fg-build.sh
)
fg_result="$(run_check_capture alias/dist ./fg-build.sh)"
fg_exit="${fg_result%%$'\n'*}"
fg_output="${fg_result#*$'\n'}"
check "R2: an in-repo symlinked INTERMEDIATE, final component literally 'dist', is refused" 2 "$fg_exit"
case "$fg_output" in
  *"does not name its own physical location"*) check "R2: ...with the exact-match message (not basename, not dist-itself-symlink)" 0 0 ;;
  *) check "R2: ...with the exact-match message (not basename, not dist-itself-symlink)" 0 1 ;;
esac
check "...and the real orphan was NEVER touched (still on disk, untouched by any rebuild)" "fg-orphan" "$(cd "$REPO" && cat real-pkg/dist/fg-orphan.js 2>/dev/null | tr -d '\n')"

# MUTANT X2 (R2's own proof): revert the exact-match containment to round
# 1's prefix-only logic and confirm THIS case goes RED against it — proving
# it actually exercises the round-2 fix, not just today's code shape. (S1:
# captured into a variable, never piped into a subshell `check` call, which
# a round-3 review found silently discarded an earlier version of this
# exact proof's result.)
X2_MUTANT="$TMP/mutant-x2-prefix-only.sh"
awk '
  /^case "\$DIST_REAL" in$/ { print; print "  \"$REPO_REAL\"/*) : ;; # MUTANT: prefix-only (round 1)"; skipping=1; next }
  skipping && /^esac$/ { print; skipping=0; next }
  skipping { next }
  { print }
' "$CHECK" > "$X2_MUTANT"
bash -n "$X2_MUTANT" > /dev/null 2>&1
check "MUTANT X2 SANITY: the prefix-only mutant still parses" 0 "$?"
x2_mutant_exit="$( ( cd "$REPO" && git show HEAD:real-pkg/dist/fg-orphan.js > real-pkg/dist/fg-orphan.js 2>/dev/null; bash "$X2_MUTANT" alias/dist ./fg-build.sh ) > /dev/null 2>&1; echo $? )"
check "MUTANT X2: round-1's prefix-only containment gives a FALSE OK (the #8163-round-2 regression)" 0 "$x2_mutant_exit"
( cd "$REPO" && git show HEAD:real-pkg/dist/fg-orphan.js > real-pkg/dist/fg-orphan.js )

# ═══════════════════════════════════════════════════════════════════════
# Case 8c — S3: `--literal-pathspecs` is the ONLY thing defending a
# `<dist-dir>` whose pathspec magic sits on its FIRST component (magic is a
# prefix of the WHOLE pathspec, not of the last path component, so the
# basename rule has nothing to say about it). With a real orphan present:
# the flag intact must report it; the flag removed (a mutant) must not.
# ═══════════════════════════════════════════════════════════════════════
(
  cd "$REPO" || exit 1
  mkdir -p ':(glob)magicpkg/dist'
  echo "mg" > src/mg.txt
  echo "mg-orphan" > ':(glob)magicpkg/dist/mg-orphan.js'
  echo "mg" > ':(glob)magicpkg/dist/mg.js'
  # --literal-pathspecs on the SETUP add too: without it, git's default
  # pathspec parsing interprets the leading ":(glob)" as magic for this `git
  # add` invocation itself ("did not match any files") before the fixture is
  # even built — the identical reason the script under test needs the flag.
  git --literal-pathspecs add -f ':(glob)magicpkg/dist/mg-orphan.js' ':(glob)magicpkg/dist/mg.js'
  git commit -qm 'add pathspec-magic-prefixed package'
  cat > mg-build.sh <<'SH'
#!/usr/bin/env bash
set -e
mkdir -p ':(glob)magicpkg/dist'
echo "mg" > ':(glob)magicpkg/dist/mg.js'
# mg-orphan.js deliberately not recreated
SH
  chmod +x mg-build.sh
)
check "H14: a pathspec-magic-prefixed dist dir still reports a real orphan" 1 "$(run_check ':(glob)magicpkg/dist' ./mg-build.sh)"
( cd "$REPO" && git show HEAD:':(glob)magicpkg/dist/mg-orphan.js' > ':(glob)magicpkg/dist/mg-orphan.js' )

MUTANT_NOFLAG="$TMP/mutant-no-literal-pathspecs.sh"
sed 's/--literal-pathspecs//g' "$CHECK" > "$MUTANT_NOFLAG"
mutant_h14_exit="$( ( cd "$REPO" && bash "$MUTANT_NOFLAG" ':(glob)magicpkg/dist' ./mg-build.sh ) > /dev/null 2>&1; echo $? )"
check "MUTANT H14: --literal-pathspecs removed -> false OK on the same real orphan" 0 "$mutant_h14_exit"
( cd "$REPO" && git show HEAD:':(glob)magicpkg/dist/mg-orphan.js' > ':(glob)magicpkg/dist/mg-orphan.js' )

# ═══════════════════════════════════════════════════════════════════════
# Case 9 — S1/H7/H8: a signal during the build restores the pre-existing
# dist/ rather than leaving it wiped. Round 1 only proved this for SIGTERM;
# a round-2 review pointed out that a BACKGROUNDED job in a non-interactive
# shell has SIGINT (and SIGQUIT) pre-ignored by the shell itself — this is
# standard POSIX behaviour, not a bug, and it means a naive `kill -INT
# "$pid"` against a plain `cmd &` job is silently a no-op: the signal is
# delivered to a process with SIG_IGN already set, so nothing happens and
# the build simply runs to completion. Measured directly: a bare `sleep 5 &`
# in a non-interactive script ran the FULL 5 seconds after `kill -INT` was
# sent to it. `set -m` (job control) in the subshell below is what restores
# normal signal dispositions for its background jobs — confirmed to
# correctly interrupt SIGINT, SIGTERM and SIGHUP alike, verified against the
# real multi-process chain (this subshell's job -> check-dist-drift.sh's own
# exec'd process -> its internal build subshell -> slow-build.sh -> `sleep`)
# by sending the signal to the NEGATIVE pid (the whole process group `set -m`
# creates for the job), which the kernel itself fans out to every member —
# no manual process-tree walk needed. Scoped to its own subshell so `set -m`
# (and the job-control status messages it prints) never leaks into the rest
# of this harness.
# ═══════════════════════════════════════════════════════════════════════

# run_signal_test <signal-name> -> prints "EXIT\nCONTENT\nSTATUS\nSTRAYS", a
# fresh sigrepo each call so one interrupted run never affects the next.
run_signal_test() {
  local sig="$1"
  local sigrepo="$TMP/sig-repo-$sig"
  mkdir -p "$sigrepo/pkg/dist"
  (
    cd "$sigrepo" || exit 1
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
  (
    set -m
    cd "$sigrepo" || exit 1
    bash "$CHECK" pkg/dist ./slow-build.sh > /dev/null 2>&1 &
    sigpid=$!
    sleep 1
    kill "-$sig" -- "-$sigpid" 2> /dev/null
    wait "$sigpid" 2> /dev/null
    ec=$?
    printf '%s\n%s\n%s\n%s' \
      "$ec" \
      "$(cat pkg/dist/a.js 2> /dev/null)" \
      "$(git status --short -- pkg/dist)" \
      "$(find pkg -maxdepth 1 -name '.check-dist-drift-backup*' 2> /dev/null)"
  )
}

for sig_pair in 'INT:130' 'TERM:143' 'HUP:129'; do
  sig="${sig_pair%%:*}"
  expected="${sig_pair#*:}"
  result="$(run_signal_test "$sig")"
  ec="$(printf '%s' "$result" | sed -n '1p')"
  content="$(printf '%s' "$result" | sed -n '2p')"
  status="$(printf '%s' "$result" | sed -n '3p')"
  strays="$(printf '%s' "$result" | sed -n '4p')"
  check "SIG$sig mid-build exits with the conventional 128+N code" "$expected" "$ec"
  check "...and dist is restored to its pre-build content (SIG$sig)" "original" "$content"
  check "...and git status is clean after the signal (SIG$sig)" "" "$status"
  check "...and no backup directory is left behind (SIG$sig)" "" "$strays"
done

# ═══════════════════════════════════════════════════════════════════════
# S2 (round 3): the process-group tests above do not isolate the INT/HUP
# TRAPS specifically. A review found that signalling the whole group still
# runs bash's own default fatal-signal handling regardless of whether this
# script's `trap 'exit N' INT`/`HUP` lines are present — so removing either
# trap survived the group-signalled cases above unnoticed (H7/H8 in the
# round-2 reply were NOT actually isolating, despite the claim). Signalling
# the SCRIPT'S PID ALONE (not the group) is what tells them apart: measured
# directly, with `set -m` still active so the background job's signal
# dispositions are normal (not the SIG_IGN-for-background-jobs state a
# non-job-control shell would otherwise leave it in) —
#   PR head,          SIGINT -> PID alone: 130, restored
#   INT trap removed, SIGINT -> PID alone: exit 1, build runs to
#     completion, the ORIGINAL nested file is lost, no backup remains
#   PR head,          SIGHUP -> PID alone: 129, restored
#   HUP trap removed, SIGHUP -> PID alone: exit 129 (bash's own default
#     disposition for an untrapped HUP is also fatal) but at ~1.2s — the
#     build is still running in the background and OVERWRITES the just-
#     restored dist/ moments later
# The fingerprint is taken several seconds after `wait` returns specifically
# to let an orphaned build (one bash's own trap/signal machinery did not
# actually stop) finish and reveal that overwrite, which asserting
# immediately after `wait` would miss.
# ═══════════════════════════════════════════════════════════════════════
run_signal_test_pid_only() {
  local sig="$1"
  local sigrepo="$TMP/sig-pidonly-repo-$sig"
  mkdir -p "$sigrepo/pkg/dist/sub"
  (
    cd "$sigrepo" || exit 1
    git init -q
    git config user.email t@example.com
    git config user.name t
    echo "original" > pkg/dist/a.js
    echo "nested" > pkg/dist/sub/b.js
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
  (
    set -m
    cd "$sigrepo" || exit 1
    bash "$CHECK" pkg/dist ./slow-build.sh > /dev/null 2>&1 &
    sigpid=$!
    sleep 1
    kill "-$sig" "$sigpid" 2> /dev/null # PID ALONE — no leading dash, no group fanout
    wait "$sigpid" 2> /dev/null
    ec=$?
    sleep 5 # let any orphaned (un-killed) build run to completion
    printf '%s\n%s\n%s\n%s\n%s' \
      "$ec" \
      "$(cat pkg/dist/a.js 2> /dev/null)" \
      "$([ -e pkg/dist/sub/b.js ] && echo present || echo missing)" \
      "$(git status --short -- pkg/dist)" \
      "$(find pkg -maxdepth 1 -name '.check-dist-drift-backup*' 2> /dev/null)"
  )
}

for sig_pair in 'INT:130' 'HUP:129'; do
  sig="${sig_pair%%:*}"
  expected="${sig_pair#*:}"
  result="$(run_signal_test_pid_only "$sig")"
  ec="$(printf '%s' "$result" | sed -n '1p')"
  content="$(printf '%s' "$result" | sed -n '2p')"
  nested="$(printf '%s' "$result" | sed -n '3p')"
  status="$(printf '%s' "$result" | sed -n '4p')"
  strays="$(printf '%s' "$result" | sed -n '5p')"
  check "S2 PID-only SIG$sig: exits with the conventional 128+N code" "$expected" "$ec"
  check "S2 PID-only SIG$sig: dist is restored to its pre-build content" "original" "$content"
  check "S2 PID-only SIG$sig: the nested file survives" "present" "$nested"
  check "S2 PID-only SIG$sig: git status is clean" "" "$status"
  check "S2 PID-only SIG$sig: no backup directory is left behind" "" "$strays"
done

# MUTANT H7 (PID-only INT, trap removed): the run continues to a verdict,
# the nested file is lost, no backup remains.
H7_MUTANT="$TMP/mutant-h7-no-int-trap.sh"
sed "/trap 'exit 130' INT/d" "$CHECK" > "$H7_MUTANT"
bash -n "$H7_MUTANT" > /dev/null 2>&1
check "MUTANT H7 SANITY: the no-INT-trap mutant still parses" 0 "$?"
h7repo="$TMP/mutant-h7-repo"
mkdir -p "$h7repo/pkg/dist/sub"
(
  cd "$h7repo" || exit 1
  git init -q; git config user.email t@example.com; git config user.name t
  echo "original" > pkg/dist/a.js
  echo "nested" > pkg/dist/sub/b.js
  git add -A; git commit -qm init
  cat > slow-build.sh <<'SH'
#!/usr/bin/env bash
sleep 5
mkdir -p pkg/dist
echo changed > pkg/dist/a.js
SH
  chmod +x slow-build.sh
)
h7_result="$(
  set -m
  cd "$h7repo" || exit 1
  bash "$H7_MUTANT" pkg/dist ./slow-build.sh > /dev/null 2>&1 &
  sigpid=$!
  sleep 1
  kill -INT "$sigpid" 2> /dev/null
  wait "$sigpid" 2> /dev/null
  ec=$?
  sleep 5
  printf '%s\n%s\n%s' "$ec" "$(cat pkg/dist/a.js 2> /dev/null)" "$([ -e pkg/dist/sub/b.js ] && echo present || echo missing)"
)"
h7_ec="$(printf '%s' "$h7_result" | sed -n '1p')"
h7_content="$(printf '%s' "$h7_result" | sed -n '2p')"
h7_nested="$(printf '%s' "$h7_result" | sed -n '3p')"
check "MUTANT H7: PID-only SIGINT with the trap removed runs the build to completion" "1 changed missing" "$h7_ec $h7_content $h7_nested"

# MUTANT H8 (PID-only HUP, trap removed): bash's OWN default disposition for
# an untrapped HUP is still fatal, so the EXIT CODE alone does not change —
# but the orphaned build (not actually stopped by anything check-dist-
# drift.sh's own code did) finishes moments later and OVERWRITES the just-
# restored dist/, which is what this isolates.
H8_MUTANT="$TMP/mutant-h8-no-hup-trap.sh"
sed "/trap 'exit 129' HUP/d" "$CHECK" > "$H8_MUTANT"
bash -n "$H8_MUTANT" > /dev/null 2>&1
check "MUTANT H8 SANITY: the no-HUP-trap mutant still parses" 0 "$?"
h8repo="$TMP/mutant-h8-repo"
mkdir -p "$h8repo/pkg/dist"
(
  cd "$h8repo" || exit 1
  git init -q; git config user.email t@example.com; git config user.name t
  echo "original" > pkg/dist/a.js
  git add -A; git commit -qm init
  cat > slow-build.sh <<'SH'
#!/usr/bin/env bash
sleep 5
mkdir -p pkg/dist
echo changed > pkg/dist/a.js
SH
  chmod +x slow-build.sh
)
h8_content_after_overwrite="$(
  set -m
  cd "$h8repo" || exit 1
  bash "$H8_MUTANT" pkg/dist ./slow-build.sh > /dev/null 2>&1 &
  sigpid=$!
  sleep 1
  kill -HUP "$sigpid" 2> /dev/null
  wait "$sigpid" 2> /dev/null
  sleep 5 # the orphaned build finishes here and overwrites the restored file
  cat pkg/dist/a.js 2> /dev/null
)"
check "MUTANT H8: PID-only SIGHUP with the trap removed lets the orphaned build overwrite the restore" "changed" "$h8_content_after_overwrite"

# ═══════════════════════════════════════════════════════════════════════
# Case 10 — H9 (round-2 S1): a restore that itself FAILS keeps the backup
# on disk and prints its path, rather than the EXIT trap discarding the
# only remaining copy — round 1's own regression, re-isolated. A PATH shim
# for `mv` refuses exactly the RESTORE call (source ends in "dist-backup";
# the INITIAL backup-creation call's DESTINATION ends in "dist-backup" but
# its SOURCE does not, so only the restore direction is blocked) in front of
# a build that fails outright.
# ═══════════════════════════════════════════════════════════════════════
H9REPO="$TMP/h9-repo"
mkdir -p "$H9REPO/pkg/dist"
(
  cd "$H9REPO" || exit 1
  git init -q
  git config user.email t@example.com
  git config user.name t
  echo "original" > pkg/dist/a.js
  git add -A
  git commit -qm init
  cat > fail.sh <<'SH'
#!/usr/bin/env bash
exit 7
SH
  chmod +x fail.sh
)
MVSHIM_DIR="$TMP/mvshim"
mkdir -p "$MVSHIM_DIR"
cat > "$MVSHIM_DIR/mv" <<SH
#!/usr/bin/env bash
case "\$1" in
  */dist-backup) echo "SHIMMED-MV-REFUSES-RESTORE" >&2; exit 1 ;;
esac
exec "$(command -v mv)" "\$@"
SH
chmod +x "$MVSHIM_DIR/mv"
h9_output="$( cd "$H9REPO" && PATH="$MVSHIM_DIR:$PATH" bash "$CHECK" pkg/dist ./fail.sh 2>&1 )"
h9_exit=$?
check "H9: a build failure whose restore ALSO fails still exits non-zero" 1 "$h9_exit"
h9_backup_path="$(printf '%s' "$h9_output" | sed -n "s/.*contents are kept at: //p")"
check "H9: the error message names a backup path that actually exists" 0 "$([ -n "$h9_backup_path" ] && [ -e "$h9_backup_path" ] && echo 0 || echo 1)"
check "H9: the kept backup is byte-identical to the original" "original" "$(cat "$h9_backup_path/a.js" 2>/dev/null)"
rm -rf "$(dirname "$h9_backup_path")" 2>/dev/null

# MUTANT H9: restore round-1's bug (the EXIT trap deletes the backup
# unconditionally instead of only after DONE=1 or a verified restore) and
# confirm this isolating case goes RED against it — proving the case
# actually exercises the invariant, not just the current code's shape.
H9_MUTANT="$TMP/mutant-h9-cleanup.sh"
awk '
  /^cleanup\(\) \{$/ { print; print "  rm -rf \"$BACKUP_PARENT\" 2>/dev/null; return"; skipping=1; next }
  skipping && /^\}$/ { print; skipping=0; next }
  skipping { next }
  { print }
' "$CHECK" > "$H9_MUTANT"
# A FRESH repo for the mutant run: the non-mutant H9 case above deliberately
# left pkg/dist absent (the shimmed restore correctly refused to recreate
# it), so re-using the same repo would need its own repair step first.
H9MREPO="$TMP/h9-mutant-repo"
mkdir -p "$H9MREPO/pkg/dist"
(
  cd "$H9MREPO" || exit 1
  git init -q
  git config user.email t@example.com
  git config user.name t
  echo "original" > pkg/dist/a.js
  git add -A
  git commit -qm init
  cp "$H9REPO/fail.sh" .
)
mutant_h9_output="$( cd "$H9MREPO" && PATH="$MVSHIM_DIR:$PATH" bash "$H9_MUTANT" pkg/dist ./fail.sh 2>&1 )"
mutant_h9_backup_path="$(printf '%s' "$mutant_h9_output" | sed -n "s/.*contents are kept at: //p")"
check "MUTANT H9: round-1's unconditional-delete cleanup() loses the backup" "0 (no backup path printed, or it does not exist)" "$([ -z "$mutant_h9_backup_path" ] || [ ! -e "$mutant_h9_backup_path" ] && echo "0 (no backup path printed, or it does not exist)" || echo "1 (backup at $mutant_h9_backup_path survived — mutant did not reproduce the bug)")"

# ═══════════════════════════════════════════════════════════════════════
# Case 11 — H10 (round-2 S1): no backup directory survives a run that
# reaches a real verdict — neither a CLEAN pass nor a DRIFT failure.
# ═══════════════════════════════════════════════════════════════════════
run_check dist ./build.sh > /dev/null
check "H10: no backup left behind after a CLEAN verdict" "" "$(find "$REPO" -maxdepth 1 -name '.check-dist-drift-backup*' 2>/dev/null)"
echo "a-modified-h10" > "$REPO/src/a.txt"
run_check dist ./build.sh > /dev/null
check "H10: no backup left behind after a DRIFT verdict" "" "$(find "$REPO" -maxdepth 1 -name '.check-dist-drift-backup*' 2>/dev/null)"
echo "a" > "$REPO/src/a.txt"
run_check dist ./build.sh > /dev/null

# MUTANT H10: force cleanup() to SKIP the DONE=1 branch's rm -rf (simulating
# a leak after a verdict) and confirm this isolating case goes RED.
H10_MUTANT="$TMP/mutant-h10-cleanup.sh"
# shellcheck disable=SC2016 # deliberate: single-quoted so the sed PATTERN
# matches $CHECK's own literal source text; it must not be shell-expanded.
sed '/\[ -n "\$BACKUP_PARENT" \] && \[ -d "\$BACKUP_PARENT" \] && rm -rf "\$BACKUP_PARENT"/d' "$CHECK" > "$H10_MUTANT"
( cd "$REPO" && bash "$H10_MUTANT" dist ./build.sh ) > /dev/null 2>&1
mutant_h10_leaked="$(find "$REPO" -maxdepth 1 -name '.check-dist-drift-backup*' 2>/dev/null)"
check "MUTANT H10: a cleanup() that never rm -rfs the backup leaks one after a clean verdict" "leaked" "$([ -n "$mutant_h10_leaked" ] && echo leaked || echo "not leaked")"
rm -rf "$REPO"/.check-dist-drift-backup* 2>/dev/null

# ═══════════════════════════════════════════════════════════════════════
# Case 12 — S2: a backup stranded by an earlier, incomplete run (e.g.
# SIGKILL, which no trap can catch) is detected by the NEXT run before it
# creates one of its own, rather than silently proceeding and leaving the
# stray copy on disk forever.
# ═══════════════════════════════════════════════════════════════════════
STRANDREPO="$TMP/strand-repo"
mkdir -p "$STRANDREPO/pkg/dist"
(
  cd "$STRANDREPO" || exit 1
  git init -q
  git config user.email t@example.com
  git config user.name t
  echo "x" > pkg/dist/a.js
  git add -A
  git commit -qm init
  # Reproduces the COMMITTED content ("x"), not the stranded backup's — once
  # the stranded backup is restored and the check is re-run, the clean
  # rebuild compares against the INDEX, not against whatever the recovery
  # command happened to put there.
  cat > keep.sh <<'SH'
#!/usr/bin/env bash
set -e
mkdir -p pkg/dist
echo "x" > pkg/dist/a.js
SH
  chmod +x keep.sh
)
mkdir -p "$STRANDREPO/pkg/.check-dist-drift-backup.strandtest/dist-backup"
echo "stranded-original" > "$STRANDREPO/pkg/.check-dist-drift-backup.strandtest/dist-backup/a.js"
stranded_output="$( cd "$STRANDREPO" && bash "$CHECK" pkg/dist ./keep.sh 2>&1 )"
stranded_exit=$?
check "S2: a stranded backup from an earlier run is detected, not silently proceeded past" 2 "$stranded_exit"
case "$stranded_output" in
  *".check-dist-drift-backup.strandtest"*) check "S2: the error names the stranded backup's path" 0 0 ;;
  *) check "S2: the error names the stranded backup's path" 0 1 ;;
esac
check "S2: the stranded backup itself is untouched" "stranded-original" "$(cat "$STRANDREPO/pkg/.check-dist-drift-backup.strandtest/dist-backup/a.js" 2>/dev/null)"
check "S2: the real dist dir was never touched either (refused before any mv)" "x" "$(cat "$STRANDREPO/pkg/dist/a.js" 2>/dev/null)"

# ═══════════════════════════════════════════════════════════════════════
# Case 13 — R1 (round 3): the stranded-backup glob must stay scoped to the
# LITERAL dist-dir parent path, not word-split or glob-interpreted. The
# first version of this check (`STRAY=($BACKUP_GLOB)`, fully unquoted) broke
# three ways: a SPACE in the parent path silently skipped the check
# entirely (nothing to word-split correctly on); a GLOB CHARACTER in the
# parent path did the same; and — the dangerous direction — a space-
# containing parent with an UNRELATED real sibling directory misread that
# sibling AS a stranded backup and told a developer to `rm -rf` it.
# ═══════════════════════════════════════════════════════════════════════

# R1a — a space in the dist dir's parent path, WITH a real stranded backup:
# must still be detected (exit 2, naming it).
SPACEREPO="$TMP/space repo"
mkdir -p "$SPACEREPO/has space/dist"
(
  cd "$SPACEREPO" || exit 1
  git init -q
  git config user.email t@example.com
  git config user.name t
  echo "x" > "has space/dist/a.js"
  git add -A
  git commit -qm init
  # A real build (not a bare `true`): the stranded check should fire BEFORE
  # this ever runs, but every case below that expects the check to be
  # SKIPPED still needs a build that reproduces the committed content, or
  # the zero-emit floor fires instead and masks what is actually being
  # tested.
  cat > "keep.sh" <<'SH'
#!/usr/bin/env bash
set -e
mkdir -p "has space/dist"
echo "x" > "has space/dist/a.js"
SH
  chmod +x keep.sh
)
mkdir -p "$SPACEREPO/has space/.check-dist-drift-backup.spacetest/dist-backup"
echo "space-stranded" > "$SPACEREPO/has space/.check-dist-drift-backup.spacetest/dist-backup/a.js"
space_output="$( cd "$SPACEREPO" && bash "$CHECK" "has space/dist" ./keep.sh 2>&1 )"
space_exit=$?
check "R1a: a stranded backup is still detected when the parent path has a SPACE" 2 "$space_exit"
case "$space_output" in
  *".check-dist-drift-backup.spacetest"*) check "R1a: ...and the message names it" 0 0 ;;
  *) check "R1a: ...and the message names it" 0 1 ;;
esac

# R1b — a glob character ('[') in the dist dir's parent path, WITH a real
# stranded backup: must still be detected.
GLOBREPO="$TMP/glob-repo"
mkdir -p "$GLOBREPO/pkg[1]/dist"
(
  cd "$GLOBREPO" || exit 1
  git init -q
  git config user.email t@example.com
  git config user.name t
  echo "x" > "pkg[1]/dist/a.js"
  git add -A
  git commit -qm init
  cat > "keep.sh" <<'SH'
#!/usr/bin/env bash
set -e
mkdir -p "pkg[1]/dist"
echo "x" > "pkg[1]/dist/a.js"
SH
  chmod +x keep.sh
)
mkdir -p "$GLOBREPO/pkg[1]/.check-dist-drift-backup.globtest/dist-backup"
echo "glob-stranded" > "$GLOBREPO/pkg[1]/.check-dist-drift-backup.globtest/dist-backup/a.js"
glob_output="$( cd "$GLOBREPO" && bash "$CHECK" "pkg[1]/dist" ./keep.sh 2>&1 )"
glob_exit=$?
check "R1b: a stranded backup is still detected when the parent path has a GLOB CHARACTER" 2 "$glob_exit"
case "$glob_output" in
  *".check-dist-drift-backup.globtest"*) check "R1b: ...and the message names it" 0 0 ;;
  *) check "R1b: ...and the message names it" 0 1 ;;
esac

# R1c — the dangerous direction: a space in the parent path, an UNRELATED
# real sibling directory that happens to share a path PREFIX with the dist
# parent once split on whitespace, and NO stranded backup at all. The buggy
# (unquoted) version misread the sibling as a stranded backup here.
FALSEPOSREPO="$TMP/falsepos-repo"
mkdir -p "$FALSEPOSREPO/has space/dist" "$FALSEPOSREPO/has"
(
  cd "$FALSEPOSREPO" || exit 1
  git init -q
  git config user.email t@example.com
  git config user.name t
  echo "x" > "has space/dist/a.js"
  git add -A
  git commit -qm init
  cat > "keep.sh" <<'SH'
#!/usr/bin/env bash
set -e
mkdir -p "has space/dist"
echo "x" > "has space/dist/a.js"
SH
  chmod +x keep.sh
)
falsepos_exit="$( ( cd "$FALSEPOSREPO" && bash "$CHECK" "has space/dist" ./keep.sh ) > /dev/null 2>&1; echo $? )"
check "R1c: an unrelated sibling dir is NOT misread as a stranded backup" 0 "$falsepos_exit"

# MUTANT R1: revert to the original fully-unquoted glob and confirm these
# three cases go RED against it — proving they actually exercise the fix,
# not just today's code shape.
R1_MUTANT="$TMP/mutant-r1-unquoted-glob.sh"
# shellcheck disable=SC2016 # deliberate: single-quoted so the sed PATTERN
# and REPLACEMENT match/produce $CHECK's own literal source text; neither
# side should be shell-expanded here.
sed 's|STRAY=("\$(dirname "\$ABS_DIST_DIR")"/.check-dist-drift-backup.\*)|BACKUP_GLOB="$(dirname "$ABS_DIST_DIR")/.check-dist-drift-backup."*; STRAY=($BACKUP_GLOB)|' "$CHECK" > "$R1_MUTANT"
bash -n "$R1_MUTANT" > /dev/null 2>&1
check "MUTANT R1 SANITY: the reverted-glob mutant still parses" 0 "$?"
mutant_space_exit="$( ( cd "$SPACEREPO" && bash "$R1_MUTANT" "has space/dist" ./keep.sh ) > /dev/null 2>&1; echo $? )"
check "MUTANT R1a: the unquoted glob silently SKIPS the space-path stranded backup" 0 "$mutant_space_exit"
mutant_glob_exit="$( ( cd "$GLOBREPO" && bash "$R1_MUTANT" "pkg[1]/dist" ./keep.sh ) > /dev/null 2>&1; echo $? )"
check "MUTANT R1b: the unquoted glob silently SKIPS the glob-char-path stranded backup" 0 "$mutant_glob_exit"
mutant_falsepos_exit="$( ( cd "$FALSEPOSREPO" && bash "$R1_MUTANT" "has space/dist" ./keep.sh ) > /dev/null 2>&1; echo $? )"
check "MUTANT R1c: the unquoted glob FALSELY refuses over the unrelated sibling" 2 "$mutant_falsepos_exit"

# R1d (printf '%q' quoting) — the printed recovery commands must be shell-
# safe even when the path contains a space: a raw space in an unquoted
# `rm -rf has space/dist` splits into two separate (wrong) arguments.
case "$space_output" in
  *'has\ space'*) check "R1d: the recovery commands are %q-quoted (space is escaped)" 0 0 ;;
  *) check "R1d: the recovery commands are %q-quoted (space is escaped)" 0 1 ;;
esac

# N1 — running the printed restore command VERBATIM must not leave an empty
# backup-parent directory behind (which would make the NEXT run refuse
# again over nothing). Extract the actual restore command from the message
# and eval it for real, then confirm a follow-up run reports clean.
restore_cmd="$(printf '%s' "$stranded_output" | sed -n "s/.*either '\\(.*\\)' to restore it,.*/\\1/p")"
( cd "$STRANDREPO" && eval "$restore_cmd" ) > /dev/null 2>&1
check "N1: the printed restore command leaves NO empty backup dir behind" "" "$(find "$STRANDREPO/pkg" -maxdepth 1 -name '.check-dist-drift-backup*' 2>/dev/null)"
check "N1: ...and dist is restored to the stranded content" "stranded-original" "$(cat "$STRANDREPO/pkg/dist/a.js" 2>/dev/null)"
followup_exit="$( ( cd "$STRANDREPO" && bash "$CHECK" pkg/dist ./keep.sh ) > /dev/null 2>&1; echo $? )"
check "N1: ...and a FOLLOW-UP run no longer refuses" 0 "$followup_exit"

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

# S1 (round 3): the AUTHORITATIVE count. $PASS/$FAIL are shell variables, and
# a `check` call made inside a pipeline subshell loses its increment to them
# even though its "ok"/"NOT" line still prints for real — measured directly:
# forcing that one case to fail left the printed transcript at 87 lines
# while PASS+FAIL (and EXPECTED_CASES, tuned to match the undercount) stayed
# at 86, and the harness exited 0. $RESULTLOG is a real file append from
# inside `check()` itself, so it cannot go missing the same way. Any
# mismatch here — in EITHER direction — means some case's outcome was not
# correctly tallied, independent of whatever $PASS/$FAIL happen to say.
LOGGED_COUNT="$(wc -l < "$RESULTLOG" | tr -d '[:space:]')"
LOGGED_NOT="$(grep -c '^NOT$' "$RESULTLOG" 2> /dev/null || true)"
if [ "$LOGGED_COUNT" -ne "$EXPECTED_CASES" ] || [ "$LOGGED_COUNT" -ne "$((PASS + FAIL))" ]; then
  echo "HARNESS BROKEN: \$RESULTLOG recorded $LOGGED_COUNT case(s), PASS+FAIL says $((PASS + FAIL)), EXPECTED_CASES is $EXPECTED_CASES — these must all agree"
  BROKEN=1
fi
if [ "${LOGGED_NOT:-0}" -ne "$FAIL" ]; then
  echo "HARNESS BROKEN: \$RESULTLOG recorded $LOGGED_NOT failing case(s) but \$FAIL says $FAIL — a check() call's result was lost to a subshell"
  BROKEN=1
fi
[ "$BROKEN" -eq 0 ] || exit 1
echo "PASS — all $PASS cases"
