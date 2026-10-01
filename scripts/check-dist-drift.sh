#!/usr/bin/env bash
#
# check-dist-drift.sh — fail if a package's committed dist/ doesn't match a
# CLEAN fresh build (#8152, #8163).
#
# The naive check this replaces was `git diff --exit-code <dist-dir>` after a
# rebuild. That only diffs TRACKED paths. `dist/` is gitignored (with narrow
# negations for the few files each package commits), so a build that emits a
# NEW file — e.g. a new packages/protocol/src/foo.ts producing
# packages/protocol/dist/foo.js — leaves that file both untracked and IGNORED.
# `git diff` never sees an ignored/untracked path, so the check stayed at exit
# 0 while the new file was never committed. Downstream (the published package,
# the Docker image build in #8133) silently ships without it. This is the
# "cannot check this" == "nothing to check" class in docs/false-safety-guards.md.
#
# #8163 — a SECOND, narrower blind spot survived #8152: a tracked dist file
# whose SOURCE was deleted. A non-clean `tsc` build never touches (and never
# removes) output for a source file that no longer exists in the program — it
# just leaves the old, now-orphaned file sitting on disk, byte-identical to
# what's committed. That matches neither of the two checks above: it isn't
# modified (content is unchanged) and it isn't new/untracked (it's still
# tracked). The only way to see it is to rebuild into an EMPTY dist dir and
# notice the file the fresh build didn't recreate.
#
# So this script now OWNS the build, not just the diff. It takes the build
# command as arguments, wipes the existing dist dir, runs that command fresh,
# and only then compares the result against git. Deriving "what's expected"
# from a real clean build — rather than a hardcoded file list — is also what
# keeps this from becoming the "hardcoded list next to a growing set" false-
# safety cause (docs/false-safety-guards.md): the set of files a package is
# supposed to ship is whatever its OWN build emits, intersected with whatever
# its OWN .gitignore negations allow to be tracked — never typed into this
# script.
#
# This script checks THREE drift shapes, all against a clean rebuild:
#   1. A tracked dist file whose content no longer matches the INDEX — `git
#      diff` (working tree vs. the index; the same thing as HEAD in CI, where
#      nothing is ever staged, but not necessarily identical to HEAD on a
#      local checkout with staged-but-uncommitted dist changes) reports these
#      as `M` (modified).
#   2. A tracked dist file the clean rebuild did NOT reproduce at all — the
#      #8163 orphan case. Deleting the dist dir before rebuilding turns this
#      into an ordinary working-tree deletion of a tracked path, which
#      `git diff --name-status` reports as `D` — no separate enumeration of
#      "expected files" needed. `D` means only that the clean rebuild did not
#      produce this file; a deleted source is the common cause, but a hand-
#      committed file the build never emitted, or a build-config change (e.g.
#      dropping `--declaration`), reads identically here.
#   3. An untracked file sitting under the dist dir, WHETHER OR NOT it is
#      gitignored — the #8152 blind spot, widened by a real false-green a
#      review found in this PR (see the `git ls-files` invocation below):
#      `git diff` (tracked paths only) never sees an untracked path, ignored
#      or not.
#
# Usage (run from the repo root):
#   scripts/check-dist-drift.sh <dist-dir> <build-cmd> [build-cmd-arg ...]
#     e.g. scripts/check-dist-drift.sh packages/protocol/dist \
#            npm run build -w packages/protocol
#          scripts/check-dist-drift.sh packages/store-core/dist \
#            npm run build:crypto -w @chroxy/store-core
#
# <build-cmd ...> is executed as an argv array (never through `sh -c`/`eval`),
# from the repo root, with <dist-dir> already removed — it must be a command
# that builds <dist-dir> from scratch (the package's own build script; see
# CLAUDE.md's "NEVER run an emitting tsc on packages/store-core directly" —
# this is exactly why the caller supplies the build command instead of this
# script inventing its own tsc invocation).
#
# <dist-dir> IS VALIDATED BEFORE ANYTHING IS MOVED OR DELETED. This script
# wipes <dist-dir> and later restores it from a backup on most failure paths
# (see below), which makes an unvalidated caller-supplied path a real data-
# loss risk, not a hypothetical one: an unvalidated `../../outer` or `/` moved
# the repository's enclosing directory, `.git` included, out of the way and
# then failed to move it back. A SECOND round of review found that checking
# the physical location is inside the repo is not the same claim as checking
# that <dist-dir> NAMES that location — an npm-workspace symlink
# (`node_modules/@chroxy/protocol/dist`), any other in-repo symlinked
# intermediate component, and (on a case-preserving filesystem such as APFS)
# a wrong-case spelling of a real path all physically resolve somewhere
# legitimate while naming something git's pathspecs cannot see through, each
# a silent false-clean. See `validate_dist_dir()` and the physical-containment
# check below for the exact rules; a path failing any of them is a usage
# error (exit 2), refused before the first `mv`.
#
# This script OWNS the build now, so it must leave the working tree no worse
# off than it found it when it can't complete the check: the pre-existing
# <dist-dir> is backed up (as a SIBLING directory next to it, so the restore
# is a same-filesystem, atomic `mv` rather than a cross-device copy) before
# the wipe, and restored on every exit path except the two that reach a real
# verdict (clean, or drift found) — a failed build, a zero-emit build, an
# aborting git failure, a usage error caught after the backup already exists,
# or a signal (INT/TERM/HUP) all restore rather than strand the tree wiped or
# half-built. The backup is deleted only once it is confirmed no longer
# needed: after a verdict is reached, or after a verified successful restore.
# If a restore itself fails, the backup is kept on disk and its path is
# printed loudly — never silently discarded — so nothing is lost twice. A
# backup stranded by an even harsher failure (SIGKILL, which no trap can
# catch) is detected by the NEXT run before it creates one of its own, and
# that run refuses to proceed until the stray backup is resolved by hand.
#
# A RUN THAT REACHES A VERDICT (clean or drift) REPLACES <dist-dir> WITH THE
# CLEAN BUILD'S OUTPUT, FULL STOP. Anything that was sitting in <dist-dir>
# and that the build does not itself emit — an ignored local scratch file, a
# stray editor artifact — is gone afterward, the same as a normal `rm -rf
# <dist-dir> && npm run build` would discard it. This script does not special-
# case preserving such files; it is not a general-purpose "diff a directory"
# tool, it is a CI gate for whether a package's committed dist matches a
# clean build.
#
# Exits:
#   0 — a clean rebuild of <dist-dir> matches its committed state exactly (no
#       modified, no orphaned, no new untracked files).
#   1 — drift detected (modified, orphaned, or new/untracked), OR the build
#       command failed, OR it emitted zero files, OR git failed (git's own
#       exit code propagates unchanged via `set -e`; it is not remapped to 1,
#       though in practice this is commonly 128). "Cannot check" must never
#       read as "nothing to check" — see docs/false-safety-guards.md.
#   2 — usage error: fewer than 2 arguments, an empty <dist-dir>, <dist-dir>
#       fails validation (see `validate_dist_dir()` and the physical-
#       containment check below), or a backup from an earlier, incomplete run
#       is already sitting on disk (see the stranded-backup check below).
#   130/143/129 — interrupted by SIGINT/SIGTERM/SIGHUP respectively, after the
#       EXIT trap has attempted to restore any pre-existing <dist-dir>.
#
# set -euo pipefail: a git failure anywhere below must abort the script with a
# nonzero exit rather than let a later check paper over it as "no drift found".
set -euo pipefail

usage() {
  echo "usage: $(basename "$0") <dist-dir> <build-cmd> [build-cmd-arg ...]" >&2
  echo "  e.g. $(basename "$0") packages/protocol/dist npm run build -w packages/protocol" >&2
  echo "       $(basename "$0") packages/store-core/dist npm run build:crypto -w @chroxy/store-core" >&2
}

if [ "$#" -lt 2 ] || [ -z "${1:-}" ]; then
  usage
  exit 2
fi

DIST_DIR_RAW="$1"
shift
BUILD_CMD=("$@")

# git_pathspec_is_not_a_path: `--` does not disable pathspec magic. DIST_DIR is
# a fixed literal argument from the CI workflow or a test fixture, but treat it
# as untrusted anyway — a glob metacharacter in a real directory name would
# otherwise be re-parsed under pathspec grammar instead of matched literally.
# --literal-pathspecs shuts that off; strip any inherited pathspec-mode env var
# first, since git refuses to start if two global pathspec modes are selected
# at once (GIT_GLOB_PATHSPECS / GIT_ICASE_PATHSPECS / GIT_NOGLOB_PATHSPECS).
#
# STILL LIVE, and this flag is the only thing defending it: pathspec magic is
# a prefix of the WHOLE pathspec string, not of its last path component, so
# `:(glob)pkg/dist` has an ordinary basename ("dist", passing
# `validate_dist_dir()` below) while still being magic to git. Without
# --literal-pathspecs, a `<dist-dir>` spelled that way would have its leading
# `:(glob)` interpreted as a pathspec MAGIC marker rather than matched as a
# literal directory-name prefix, changing what `git diff`/`git ls-files`
# below actually match against. (An EARLIER version of this comment claimed
# the basename rule alone made this moot — it does not; magic lives at the
# front of the path, not the back.)
unset GIT_LITERAL_PATHSPECS GIT_GLOB_PATHSPECS GIT_NOGLOB_PATHSPECS GIT_ICASE_PATHSPECS 2>/dev/null || true

# Resolve the repo root so this is independent of the caller's exact cwd within
# the repo. This is also the first real git invocation: if we are not inside a
# git repository, or git is broken, this fails loudly (set -e) rather than
# quietly falling through to "nothing to check".
REPO_ROOT="$(git rev-parse --show-toplevel)"

git_() { git --literal-pathspecs -C "$REPO_ROOT" "$@"; }

fail_validation() {
  echo "::error::$(basename "$0"): $1" >&2
  exit 2
}

# Sets the global DIST_DIR on success; calls fail_validation (exit 2, before
# anything has been moved or deleted) otherwise. Deliberately NOT invoked via
# command substitution ($(...)) — that would run it in a subshell, where
# fail_validation's `exit 2` would only end the subshell, leaving the parent
# script to continue with an empty captured value instead of actually
# stopping. Writing the result to a global is what lets `exit` here mean
# "stop the whole script".
#
# A review of this script's first version reproduced PERMANENT DATA LOSS from
# an unvalidated path: `../../outer` (the directory containing the repo) was
# `mv`'d out of the way along with the repo itself, the subsequent `cd
# "$REPO_ROOT"` then failed, the restore's own `mv` failed with ENOENT, and
# the EXIT trap deleted the only backup — the repo, `.git` included, its
# siblings and a canary file were all gone. `/`, `../sibling` (with a build
# that wrote into it) and a symlinked dist dir each destroyed something
# outside the repo by a different route. Every rule below closes one of those
# routes; none is redundant with the others (a magic-free but merely-outside-
# the-repo path, for instance, passes every string check and is only caught by
# the final physical-containment comparison).
validate_dist_dir() {
  local raw="$1" d seg
  local -a segs

  # Round 2 review: a control character (a literal embedded newline or CR
  # above all) breaks the component scan below in a way that matters —
  # `IFS='/' read -ra` reads only the FIRST LINE of its input, so any `..`
  # or other component sitting after an embedded newline is never segment-
  # checked at all. `$'a\n/link/../dist'` (a real on-disk directory literally
  # named "a<newline>", containing a symlink out of the repo) reached the
  # physical-containment check below with its embedded ".." never rejected
  # by this function. Rejecting every control character up front closes that
  # specific hole directly, independent of the containment fix: there is no
  # legitimate reason a CI- or test-supplied <dist-dir> would ever contain
  # one.
  case "$raw" in
    *[[:cntrl:]]*)
      fail_validation "<dist-dir> may not contain control characters (including a newline or CR)"
      ;;
  esac

  case "$raw" in
    /*) fail_validation "<dist-dir> must be a path relative to the repo root, not absolute: $raw" ;;
  esac

  # Strip exactly one trailing slash, so "pkg/dist" and "pkg/dist/" validate
  # identically.
  d="${raw%/}"
  [ -n "$d" ] || fail_validation "<dist-dir> may not be empty or all slashes: $raw"

  # No empty, '.' or '..' path component. `read -ra` (not an unquoted `set --
  # $d`) splits on IFS without ever subjecting the fields to pathname
  # expansion, so a component containing a glob metacharacter is split on '/'
  # literally rather than expanded against whatever happens to be in the
  # CURRENT directory — the kind of shell-prediction hazard this repo's own
  # review culture flags. (The control-character check above is what makes
  # this a complete scan rather than "complete unless a newline hides part
  # of the input from it".)
  IFS='/' read -ra segs <<< "$d"
  for seg in "${segs[@]}"; do
    case "$seg" in
      ''|.|..)
        fail_validation "<dist-dir> may not contain an empty, '.' or '..' path component: $raw"
        ;;
      .git)
        # Round 3 (S4/N2): the physical-containment check's own `.git` rule
        # only ever compared against `$REPO_REAL/.git` — the TOP-level repo
        # .git. A NESTED one (a non-submodule vendored/checked-in repo at
        # e.g. packages/sub/.git) never matched that pattern and fell
        # through to the ordinary "inside the repo" acceptance: exit 0,
        # packages/sub/.git/dist silently replaced by build output. This
        # catches a literal `.git` component at ANY depth, up front. Case
        # variants (`.GIT`, `.Git`, ...) are deliberately NOT handled here —
        # they are already caught by the physical exact-match check below,
        # which resolves through `/bin/pwd -P` to the filesystem's
        # canonical stored case before comparing.
        fail_validation "<dist-dir> may not contain a '.git' path component at any depth: $raw"
        ;;
    esac
  done

  # The LAST component must be spelled exactly "dist" — this script's blast
  # radius (a caller-supplied path it will `mv` and `rm -rf`) is scoped to
  # directories named for exactly the thing it is meant to touch, not to
  # "whatever path happens to validate otherwise".
  case "$d" in
    dist|*/dist) : ;;
    *) fail_validation "<dist-dir> must be a path ending in a component named exactly 'dist', got: $raw" ;;
  esac

  DIST_DIR="$d"
}

validate_dist_dir "$DIST_DIR_RAW"

ABS_DIST_DIR="$REPO_ROOT/$DIST_DIR"

# Must already exist as a real directory — this script wipes and rebuilds an
# EXISTING dist dir; it does not invent one from nothing, and requiring
# existence up front is also what makes the physical-containment check below
# meaningful (a path that does not yet exist cannot be resolved to a real,
# symlink-free location via `cd ... && pwd -P`).
if [ ! -e "$ABS_DIST_DIR" ]; then
  fail_validation "<dist-dir> does not exist: $DIST_DIR"
fi
# A symlinked dist dir is refused outright: `mv`/`rm -rf` on a symlink acts on
# the link itself in some shapes and on its target in others depending on a
# trailing slash and the exact tool, which is precisely the kind of ambiguity
# this script cannot afford given what it does to the path. It is also the
# simplest way to point ABS_DIST_DIR somewhere the containment check below
# cannot see: the symlink's own path component passes every string check
# above while its target resolves anywhere at all.
if [ -L "$ABS_DIST_DIR" ]; then
  fail_validation "<dist-dir> must not be a symlink: $DIST_DIR"
fi
if [ ! -d "$ABS_DIST_DIR" ]; then
  fail_validation "<dist-dir> exists but is not a directory: $DIST_DIR"
fi

# Physical containment, round 2: resolve both sides with symlinks removed and
# require <dist-dir> to NAME its own physical location EXACTLY — not merely
# resolve to somewhere under the repo root.
#
# Round 1 only checked the latter (a prefix match of DIST_REAL against
# REPO_REAL), and a second review found that insufficient: it answers "is the
# physical directory somewhere inside the repo", not "does <dist-dir> name
# THAT directory". Three real inputs passed the prefix check as a result —
#   * `node_modules/@chroxy/protocol/dist` (the ordinary npm-workspace
#     symlink present in every checkout of this repo) physically resolves to
#     packages/protocol/dist, which IS inside the repo — but git's pathspec
#     cannot see through the symlink, so the diff/ls-files checks below find
#     nothing and report a FALSE CLEAN while silently deleting a real orphan
#     from the working tree;
#   * the same shape for any in-repo symlinked intermediate component, not
#     only the workspace one;
#   * on a case-insensitive-but-preserving filesystem (APFS, the macOS
#     default), a `<dist-dir>` spelled with the wrong case for an existing
#     path still resolves to the SAME inode the correctly-cased spelling
#     would, including `.GIT/dist` resolving to the real `.git/dist`.
# Exact string equality between `$REPO_REAL/$DIST_DIR` (what the ARGUMENT
# claims) and `$DIST_REAL` (what the filesystem actually resolves it to, with
# every symlink and case variant collapsed) closes all three at once: a
# symlinked component or a case mismatch makes the physical resolution differ
# from the literal argument, which this comparison treats as untrusted no
# differently from resolving outside the repo entirely.
#
# `cd -P` (not a bare `cd`, which is LOGICAL and resolves `..` lexically
# against the path as TYPED rather than physically against the filesystem —
# the mismatch a reviewer used to walk a crafted path through a symlink and
# back "inside" the repo on paper while `mv`/`rm -rf` act on the real,
# physically-resolved, OUTSIDE-the-repo target) and `/bin/pwd -P` — the
# EXTERNAL binary, not the shell builtin: bash 3.2's builtin `pwd -P` has been
# observed to preserve the case the caller typed on APFS rather than the
# filesystem's canonical stored case, which would let a `.GIT` spelling slip
# past a case-sensitive `.git` comparison. No `realpath` binary is assumed;
# `cd -P` + `pwd -P` is the portable idiom for both of these.
REPO_REAL="$(cd -P "$REPO_ROOT" && /bin/pwd -P)"
DIST_REAL="$(cd -P "$ABS_DIST_DIR" && /bin/pwd -P)"
case "$DIST_REAL" in
  "$REPO_REAL")
    fail_validation "<dist-dir> resolves to the repo root itself: $DIST_DIR"
    ;;
  "$REPO_REAL/.git" | "$REPO_REAL/.git/"*)
    fail_validation "<dist-dir> resolves inside .git: $DIST_DIR -> $DIST_REAL"
    ;;
  "$REPO_REAL/$DIST_DIR")
    : # names its own physical location exactly — the only accepted shape
    ;;
  "$REPO_REAL"/*)
    fail_validation "<dist-dir> does not name its own physical location (a symlinked component, a case variant, or an embedded '..' resolved it elsewhere): $DIST_DIR -> $DIST_REAL"
    ;;
  *)
    fail_validation "<dist-dir> resolves outside the repo root ($REPO_REAL): $DIST_DIR -> $DIST_REAL"
    ;;
esac

# --- Back up the pre-existing dist dir. Nothing above this line has moved or
# deleted anything; validation runs to completion (or exits 2) before this.
#
# DONE tracks whether a real verdict was reached (clean, or drift found) — the
# only two outcomes that should leave the freshly-rebuilt <dist-dir> in place.
# Every OTHER exit path (a failed build, a zero-emit build, a signal) leaves
# DONE at 0, and the EXIT trap restores the backup rather than stranding the
# tree wiped or half-built. The backup is deleted only once it is confirmed no
# longer needed: DONE=1 (a verdict was reached and the backup is moot), or a
# VERIFIED successful restore. A restore that itself fails keeps the backup on
# disk and prints its path — never `rm -rf`s the only remaining copy of what
# was there before this script ran.
DONE=0
BACKUP_PARENT=""
BACKUP=""

cleanup() {
  if [ "$DONE" -eq 1 ]; then
    [ -n "$BACKUP_PARENT" ] && [ -d "$BACKUP_PARENT" ] && rm -rf "$BACKUP_PARENT"
    return
  fi
  if [ -n "$BACKUP" ] && [ -e "$BACKUP" ]; then
    if rm -rf "$ABS_DIST_DIR" 2> /dev/null && mv "$BACKUP" "$ABS_DIST_DIR" 2> /dev/null; then
      rm -rf "$BACKUP_PARENT"
    else
      echo "::error::$(basename "$0"): could not restore $DIST_DIR after an incomplete run. Its pre-existing contents are kept at: $BACKUP" >&2
    fi
  fi
}
trap cleanup EXIT
# A signal during the build previously left dist/ wiped with no recovery: the
# only trap was on EXIT, and a build killed by SIGINT/SIGTERM never reached
# it. `exit N` from within each handler is itself an exit, which runs the EXIT
# trap above before the process actually terminates — bash waits for the
# foreground child (the build command) to finish before running a trap, so
# this fires once the build itself has been signalled and stopped.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# S2 (round-2 review): a STRANDED backup from an earlier, incomplete run is
# otherwise invisible to every later invocation. SIGKILL mid-build (a signal
# no trap can catch) leaves one on disk at exactly this name; so does a
# restore that itself failed (which this script already keeps deliberately,
# printing its path — see cleanup() above). Without this check, the NEXT run
# simply creates its own new backup alongside the stale one and reports
# whatever it finds in <dist-dir> with no mention of the orphaned copy
# sitting next to it — the stale backup is correct and recoverable, but
# nothing ever points a developer at it. Checked before anything is touched.
#
# Round 3 review: the FIRST version of this glob left the whole pattern
# unquoted (`STRAY=($BACKUP_GLOB)`), so the DIRNAME half — not just the
# intended trailing `*` — was both word-split and glob-interpreted. A space
# in the repo root or the dist dir's parent silently skipped the check
# entirely (every invocation from such a checkout never saw a real stranded
# backup again); a glob character in that same parent did the same; and
# `packages/has space/dist` with an unrelated real sibling directory
# `packages/has` (no stranded backup at all) misread that directory AS the
# stranded backup and told a developer to `rm -rf` it. Quoting the dirname
# and leaving ONLY the literal `.check-dist-drift-backup.*` suffix outside
# the quotes keeps the glob expansion scoped to exactly that suffix: the
# directory PATH is matched literally, no matter what it contains.
STRAY=("$(dirname "$ABS_DIST_DIR")"/.check-dist-drift-backup.*)
if [ -e "${STRAY[0]}" ]; then
  # printf '%q': round 3 also found the recovery commands themselves were
  # unquoted, so a space in the path broke the printed shell commands in a
  # way that silently acted on the wrong thing if pasted verbatim (e.g.
  # `rm -rf packages/has space/dist` removes `packages/has` AND `./space/dist`
  # — two unrelated, partial paths — instead of the one path intended).
  stray_backup_q="$(printf '%q' "${STRAY[0]}/dist-backup")"
  stray_parent_q="$(printf '%q' "${STRAY[0]}")"
  dist_q="$(printf '%q' "$DIST_DIR")"
  echo "::error::$(basename "$0"): a backup from an earlier, incomplete run already exists at ${STRAY[0]} — refusing to start a new one until it is resolved." >&2
  echo "This means a previous run was killed before it could restore $DIST_DIR (e.g. SIGKILL), or a restore itself failed and the backup was deliberately kept." >&2
  # N1: the restore form ends in `&& rmdir <parent>` — without it, a
  # developer who runs the printed command verbatim is left with the now-
  # EMPTY backup parent directory still on disk, and the NEXT run refuses
  # again over that leftover empty shell.
  echo "Recover by hand: compare $stray_backup_q against the current $dist_q, then either 'rm -rf $dist_q && mv $stray_backup_q $dist_q && rmdir $stray_parent_q' to restore it, or 'rm -rf $stray_parent_q' once you've confirmed it is no longer needed." >&2
  exit 2
fi

# A SIBLING of the dist dir, not the system temp dir: `mktemp -d` alone ignores
# TMPDIR on macOS (it uses /var/folders/...), which can put the backup on a
# different filesystem — turning the restore `mv` into a slow copy, and
# leaking the backup entirely if the process is killed with a signal `mktemp`
# itself cannot catch (SIGKILL). A same-directory sibling guarantees the
# restore is a single atomic rename.
BACKUP_PARENT="$(mktemp -d "$(dirname "$ABS_DIST_DIR")/.check-dist-drift-backup.XXXXXX")" || {
  echo "::error::$(basename "$0"): mktemp failed; cannot safely back up $DIST_DIR before rebuilding it" >&2
  exit 1
}
BACKUP="$BACKUP_PARENT/dist-backup"
mv "$ABS_DIST_DIR" "$BACKUP"

# --- Clean build: run the caller's build command from the repo root against
# an ABSENT dist dir, so a source file that no longer exists in the program
# simply produces nothing for it — the #8163 case — instead of a dirty
# incremental build leaving its old output untouched.
BUILD_OK=1
( cd "$REPO_ROOT" && "${BUILD_CMD[@]}" ) || BUILD_OK=0

if [ "$BUILD_OK" -ne 1 ]; then
  echo "::error::build command failed: ${BUILD_CMD[*]}" >&2
  echo "$DIST_DIR is being restored to what it was before this check ran." >&2
  exit 1
fi

# "Cannot check" must never read as "nothing to check" (docs/false-safety-
# guards.md). A build that reports success but produces no directory, or an
# empty one, is a broken build configuration, not a clean pass — and without
# this floor, a dist dir with no tracked files at all would read as clean by
# the diff checks below finding nothing to report either way.
FILE_COUNT=0
if [ -d "$ABS_DIST_DIR" ]; then
  FILE_COUNT="$(find "$ABS_DIST_DIR" -type f | wc -l | tr -d '[:space:]')"
fi
if [ "$FILE_COUNT" -eq 0 ]; then
  echo "::error::build command '${BUILD_CMD[*]}' reported success but $DIST_DIR contains zero files afterward — treating this as a broken build, not a clean pass." >&2
  echo "$DIST_DIR is being restored to what it was before this check ran." >&2
  exit 1
fi

REPORT=""
FAILED=0

# 1 & 2. Tracked-file drift, read off the SAME clean-rebuild diff: `M` is
# content that no longer matches the index (the #8152-era check); `D` is a
# tracked file the clean rebuild did not reproduce at all — the #8163 orphan
# case, only visible because <dist-dir> was wiped before the rebuild above.
# Plain `git diff` (no --exit-code) always exits 0 on success regardless of
# whether differences are found, so it plays nicely with `set -e`; we check
# the parsed output instead. A genuine git failure (not "no differences", an
# actual error) still aborts the script here via `set -e`, since this
# assignment is not guarded by `||` or an `if`.
MODIFIED=""
ORPHANED=""
# --no-renames: a worktree-vs-index diff can only ever pair a deletion with an
# INTENT-TO-ADD index entry (`git add -N`), which nothing in this script's own
# flow creates — so in practice this flag changes nothing observable here.
# It is kept anyway as a documented assumption rather than an implicit one:
# should a future caller ever stage an intent-to-add entry under <dist-dir>
# before invoking this script, forcing `--no-renames` is what keeps a
# deletion reported as a plain two-field `D old` line instead of a three-field
# `R100 old new` rename pair, which the parser below does not expect.
DIFF_STATUS="$(git_ diff --no-renames --name-status -- "$DIST_DIR")"
while IFS=$'\t' read -r status path; do
  [ -n "$status" ] || continue
  case "$status" in
    D)
      FAILED=1
      ORPHANED="${ORPHANED}${path}
"
      ;;
    *)
      FAILED=1
      MODIFIED="${MODIFIED}${path}
"
      ;;
  esac
done <<< "$DIFF_STATUS"

if [ -n "$MODIFIED" ]; then
  REPORT="${REPORT}Modified tracked file(s) under $DIST_DIR (working tree no longer matches the committed version):
$(printf '%s' "$MODIFIED" | sed 's/^/    /')
"
fi

if [ -n "$ORPHANED" ]; then
  REPORT="${REPORT}Orphaned tracked file(s) under $DIST_DIR — a clean rebuild did not produce these. The usual cause is a deleted source (#8163), but the same status also follows a hand-committed file the build never emits, or a build-config change (e.g. dropping a declaration-output flag):
$(printf '%s' "$ORPHANED" | sed 's/^/    /')
"
fi

# 3. An untracked file sitting under the dist dir, whether or not it is
# gitignored. The #8152 blind spot was ignored+untracked files specifically;
# this PR's own review found a narrower false-green in that fix: `--ignored
# --exclude-standard` lists ONLY ignored untracked files, so an untracked file
# that matches a package's own `!dist/<file>` negation — meaning git does NOT
# consider it ignored — was invisible to this check even though `git diff`
# (tracked paths only) still cannot see it either. Reproduced on the real
# store-core call site: removing the committed dist/crypto.d.ts from the
# index (leaving the rebuilt file sitting untracked on disk) reported clean.
# Dropping `--ignored --exclude-standard` entirely closes both shapes: any
# untracked file under <dist-dir> at all is drift.
UNTRACKED="$(git_ ls-files --others -- "$DIST_DIR")"
if [ -n "$UNTRACKED" ]; then
  FAILED=1
  REPORT="${REPORT}Untracked file(s) under $DIST_DIR the build produced but nothing ever committed:
$(printf '%s\n' "$UNTRACKED" | sed 's/^/    /')
"
fi

if [ "$FAILED" -ne 0 ]; then
  DONE=1
  echo "::error::$DIST_DIR drift detected (clean rebuild via: ${BUILD_CMD[*]})."
  printf '%s\n' "$REPORT"
  echo "Fix: commit the rebuilt result. A modified tracked file just needs a normal" >&2
  echo "'git add'; an orphaned file needs 'git rm'; a NEW file needs 'git add -f' if" >&2
  echo "$DIST_DIR is gitignored (and, for a new package export, remember its sibling" >&2
  echo ".d.ts/barrel entry too)." >&2
  exit 1
fi

DONE=1
echo "OK -- $DIST_DIR matches a clean rebuild exactly (no modified, orphaned, or untracked files)."
