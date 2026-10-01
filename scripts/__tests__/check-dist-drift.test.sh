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
EXPECTED_CASES=86

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
# sensitivity can reproduce the APFS-specific variant too).
mkdir -p "$SANDBOX/repo/.git/dist"
check_path_rejected "H6: .git/dist is refused" ".git/dist" "inside .git"

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
# Case 8b — THE ROUND-2 FALSE GREEN. An IN-REPO symlinked component (the
# shape of a real npm-workspace link, e.g.
# `node_modules/@chroxy/protocol/dist` -> `../../packages/protocol/dist`)
# physically resolves to somewhere legitimately inside the repo — round 1's
# prefix-only containment check accepted it — while git's pathspecs cannot
# see through the symlink at all, so a REAL orphan sitting behind it is
# invisible to both `git diff` and `git ls-files`, and the clean rebuild
# silently deletes it from the working tree while reporting "OK". The
# round-2 exact-match fix closes this: the symlink's physical target differs
# from the literal argument string, so it is refused before the build (and
# the deletion) ever runs.
# ═══════════════════════════════════════════════════════════════════════
(
  cd "$REPO" || exit 1
  mkdir -p real-pkg/dist
  echo "fg" > src/fg.txt
  echo "fg" > real-pkg/dist/fg.js
  echo "fg-orphan" > real-pkg/dist/fg-orphan.js
  git add -f real-pkg/dist/fg.js real-pkg/dist/fg-orphan.js
  git commit -qm 'add real-pkg with an about-to-be-orphaned file'
  ln -s real-pkg/dist linked-dist
  cat > fg-build.sh <<'SH'
#!/usr/bin/env bash
set -e
mkdir -p real-pkg/dist
echo "fg" > real-pkg/dist/fg.js
# fg-orphan.js deliberately not recreated
SH
  chmod +x fg-build.sh
)
fg_result="$(run_check_capture linked-dist ./fg-build.sh)"
fg_exit="${fg_result%%$'\n'*}"
check "H-symlink: an in-repo symlinked dist dir is refused, not silently resolved" 2 "$fg_exit"
check "...and the real orphan was NEVER touched (still on disk, untouched by any rebuild)" "fg-orphan" "$(cd "$REPO" && cat real-pkg/dist/fg-orphan.js 2>/dev/null | tr -d '\n')"
# Prove the ROUND-1 (prefix-only) logic specifically would have accepted
# this and let the rebuild silently delete the orphan — reproduced inline,
# not sourced from git history, the same way the #8163/#8152 RED proofs are.
(
  cd "$REPO" || exit 1
  REPO_REAL_R1="$(cd "$PWD" && pwd -P)"
  ABS_R1="$PWD/linked-dist"
  DIST_REAL_R1="$(cd "$ABS_R1" && pwd -P)"
  case "$DIST_REAL_R1" in
    "$REPO_REAL_R1"/*) echo accepted ;;
    *) echo rejected ;;
  esac
) | { read -r r1_verdict; check "RED PROOF: round-1's prefix-only containment accepts the same symlink" "accepted" "$r1_verdict"; }

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
)
mkdir -p "$STRANDREPO/pkg/.check-dist-drift-backup.strandtest/dist-backup"
echo "stranded-original" > "$STRANDREPO/pkg/.check-dist-drift-backup.strandtest/dist-backup/a.js"
stranded_output="$( cd "$STRANDREPO" && bash "$CHECK" pkg/dist true 2>&1 )"
stranded_exit=$?
check "S2: a stranded backup from an earlier run is detected, not silently proceeded past" 2 "$stranded_exit"
case "$stranded_output" in
  *".check-dist-drift-backup.strandtest"*) check "S2: the error names the stranded backup's path" 0 0 ;;
  *) check "S2: the error names the stranded backup's path" 0 1 ;;
esac
check "S2: the stranded backup itself is untouched" "stranded-original" "$(cat "$STRANDREPO/pkg/.check-dist-drift-backup.strandtest/dist-backup/a.js" 2>/dev/null)"
check "S2: the real dist dir was never touched either (refused before any mv)" "x" "$(cat "$STRANDREPO/pkg/dist/a.js" 2>/dev/null)"

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
