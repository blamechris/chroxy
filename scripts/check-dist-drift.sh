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
#   1. A tracked dist file whose content no longer matches HEAD — `git diff`
#      reports these as `M` (modified).
#   2. A tracked dist file the clean rebuild did NOT reproduce at all — the
#      #8163 orphan case. Deleting the dist dir before rebuilding turns this
#      into an ordinary working-tree deletion of a tracked path, which
#      `git diff --name-status` reports as `D` — no separate enumeration of
#      "expected files" needed.
#   3. A new untracked file sitting under the dist dir — the #8152 blind spot.
#      Because dist/ is gitignored, a file the build just emitted is BOTH
#      untracked and ignored, so `git diff` (tracked paths only) never sees
#      it: `git ls-files --others --ignored --exclude-standard`.
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
# This script OWNS the build now, so it must leave the working tree no worse
# off than it found it when it can't complete the check: the pre-existing
# <dist-dir> is backed up before the wipe and restored if the build command
# fails or emits nothing, so a broken build never strands a developer's tree
# with a half-built or empty dist/.
#
# Exits:
#   0 — a clean rebuild of <dist-dir> matches its committed state exactly (no
#       modified, no orphaned, no new untracked/ignored files).
#   1 — drift detected (modified, orphaned, or new/untracked), OR the build
#       command failed, OR it emitted zero files, OR git failed. "Cannot
#       check" must never read as "nothing to check" — see
#       docs/false-safety-guards.md.
#   2 — usage error (fewer than 2 arguments, or an empty <dist-dir>).
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

DIST_DIR="$1"
shift
BUILD_CMD=("$@")

# git_pathspec_is_not_a_path: `--` does not disable pathspec magic. DIST_DIR is
# a fixed literal argument from the CI workflow or a test fixture, but treat it
# as untrusted anyway — a glob metacharacter in a real directory name would
# otherwise be re-parsed under pathspec grammar instead of matched literally.
# --literal-pathspecs shuts that off; strip any inherited pathspec-mode env var
# first, since git refuses to start if two global pathspec modes are selected
# at once (GIT_GLOB_PATHSPECS / GIT_ICASE_PATHSPECS / GIT_NOGLOB_PATHSPECS).
unset GIT_LITERAL_PATHSPECS GIT_GLOB_PATHSPECS GIT_NOGLOB_PATHSPECS GIT_ICASE_PATHSPECS 2>/dev/null || true

# Resolve the repo root so this is independent of the caller's exact cwd within
# the repo. This is also the first real git invocation: if we are not inside a
# git repository, or git is broken, this fails loudly (set -e) rather than
# quietly falling through to "nothing to check".
REPO_ROOT="$(git rev-parse --show-toplevel)"

git_() { git --literal-pathspecs -C "$REPO_ROOT" "$@"; }

ABS_DIST_DIR="$REPO_ROOT/$DIST_DIR"

# --- Back up any pre-existing dist dir, so a build failure or a zero-emit
# build restores the tree instead of stranding it wiped or half-built.
BACKUP_PARENT=""
BACKUP=""
restore_backup() {
  if [ -n "$BACKUP" ] && [ -e "$BACKUP" ]; then
    rm -rf "$ABS_DIST_DIR"
    mv "$BACKUP" "$ABS_DIST_DIR"
  fi
}
cleanup() {
  if [ -n "$BACKUP_PARENT" ] && [ -d "$BACKUP_PARENT" ]; then
    rm -rf "$BACKUP_PARENT"
  fi
}
trap cleanup EXIT

if [ -e "$ABS_DIST_DIR" ]; then
  BACKUP_PARENT="$(mktemp -d)" || {
    echo "::error::$(basename "$0"): mktemp failed; cannot safely back up $DIST_DIR before rebuilding it" >&2
    exit 1
  }
  BACKUP="$BACKUP_PARENT/dist-backup"
  mv "$ABS_DIST_DIR" "$BACKUP"
fi

# --- Clean build: run the caller's build command from the repo root against
# an ABSENT dist dir, so a source file that no longer exists in the program
# simply produces nothing for it — the #8163 case — instead of a dirty
# incremental build leaving its old output untouched.
BUILD_OK=1
( cd "$REPO_ROOT" && "${BUILD_CMD[@]}" ) || BUILD_OK=0

if [ "$BUILD_OK" -ne 1 ]; then
  restore_backup
  echo "::error::build command failed: ${BUILD_CMD[*]}" >&2
  echo "$DIST_DIR was left as it was before this check ran (nothing to compare against a failed build)." >&2
  exit 1
fi

# "Cannot check" must never read as "nothing to check" (docs/false-safety-
# guards.md). A build that reports success but produces no directory, or an
# empty one, is a broken build configuration, not a clean pass.
FILE_COUNT=0
if [ -d "$ABS_DIST_DIR" ]; then
  FILE_COUNT="$(find "$ABS_DIST_DIR" -type f | wc -l | tr -d '[:space:]')"
fi
if [ "$FILE_COUNT" -eq 0 ]; then
  restore_backup
  echo "::error::build command '${BUILD_CMD[*]}' reported success but $DIST_DIR contains zero files afterward — treating this as a broken build, not a clean pass." >&2
  exit 1
fi

REPORT=""
FAILED=0

# 1 & 2. Tracked-file drift, read off the SAME clean-rebuild diff: `M` is
# content that no longer matches HEAD (the #8152-era check); `D` is a tracked
# file the clean rebuild did not reproduce at all — the #8163 orphan case,
# only visible because <dist-dir> was wiped before the rebuild above. Plain
# `git diff` (no --exit-code) always exits 0 regardless of whether differences
# are found, so it plays nicely with `set -e`; we check the parsed output
# instead.
MODIFIED=""
ORPHANED=""
# --no-renames: without it, a deleted file that happens to resemble another
# new/changed one in the same diff can be paired up as "R100 old new" (three
# tab-separated fields) instead of a plain two-field "D old" line, which would
# hide the #8163 orphan case behind rename heuristics instead of a deletion.
# Forcing this off makes every line exactly `<status>\t<path>`, independent of
# the invoking environment's diff.renames config.
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
  REPORT="${REPORT}Orphaned tracked file(s) under $DIST_DIR — a clean rebuild did NOT reproduce these, which means the source that used to produce them was removed without removing the compiled output (#8163):
$(printf '%s' "$ORPHANED" | sed 's/^/    /')
"
fi

# 3. New untracked file(s) sitting under the dist dir — the #8152 blind spot.
# Because dist/ is gitignored, a file the build just emitted is BOTH untracked
# and ignored, so `git diff` (tracked paths only) never sees it.
UNTRACKED="$(git_ ls-files --others --ignored --exclude-standard -- "$DIST_DIR")"
if [ -n "$UNTRACKED" ]; then
  FAILED=1
  REPORT="${REPORT}New untracked file(s) under $DIST_DIR the build produced but nothing ever committed (gitignored, so a plain 'git diff' cannot see these):
$(printf '%s\n' "$UNTRACKED" | sed 's/^/    /')
"
fi

if [ "$FAILED" -ne 0 ]; then
  echo "::error::$DIST_DIR drift detected (clean rebuild via: ${BUILD_CMD[*]})."
  printf '%s\n' "$REPORT"
  echo "Fix: commit the rebuilt result. A modified tracked file just needs a normal" >&2
  echo "'git add'; an orphaned file (source deleted) needs 'git rm'; a NEW file needs" >&2
  echo "'git add -f' since $DIST_DIR is gitignored (and, for a new package export," >&2
  echo "remember its sibling .d.ts/barrel entry too)." >&2
  exit 1
fi

echo "OK -- $DIST_DIR matches a clean rebuild exactly (no modified, orphaned, or new/untracked files)."
