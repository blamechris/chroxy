#!/usr/bin/env bash
#
# check-dist-drift.sh — fail if a package's committed dist/ doesn't match a
# fresh build (#8152).
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
# This script checks BOTH drift shapes:
#   1. A tracked dist file whose content no longer matches HEAD (the case the
#      old check covered) — `git diff` over the dist dir.
#   2. A new untracked (and, because dist/ is gitignored, also ignored) file
#      sitting under the dist dir — `git ls-files --others --ignored
#      --exclude-standard`, which is exactly the class `git diff` cannot see.
#
# Usage (run from the repo root, same contract as the old inline check):
#   scripts/check-dist-drift.sh <dist-dir>
#     e.g. scripts/check-dist-drift.sh packages/protocol/dist
#          scripts/check-dist-drift.sh packages/store-core/dist
#
# Run AFTER the build step that regenerates <dist-dir>. Exits:
#   0 — <dist-dir> matches its committed state exactly (no modified, no new
#       untracked/ignored files).
#   1 — drift detected, OR <dist-dir> does not exist, OR git failed. A missing
#       directory (build didn't run, or the path argument is wrong) is a hard
#       failure, never a silent "clean" — see docs/false-safety-guards.md.
#   2 — usage error (no argument, or empty argument).
#
# set -euo pipefail: a git failure anywhere below must abort the script with a
# nonzero exit rather than let a later check paper over it as "no drift found".
set -euo pipefail

usage() {
  echo "usage: $(basename "$0") <dist-dir>" >&2
  echo "  e.g. $(basename "$0") packages/protocol/dist" >&2
  echo "       $(basename "$0") packages/store-core/dist" >&2
}

if [ "$#" -ne 1 ] || [ -z "${1:-}" ]; then
  usage
  exit 2
fi

DIST_DIR="$1"

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

# "Cannot check" must never read as "nothing to check". A missing dist dir
# means the build step did not run before this check, or DIST_DIR is wrong —
# either way it is a hard failure, not a clean pass.
if [ ! -d "$REPO_ROOT/$DIST_DIR" ]; then
  echo "::error::$DIST_DIR does not exist under $REPO_ROOT. Did the build step run before this check, or is the path argument wrong?"
  exit 1
fi

REPORT=""
FAILED=0

# 1. Tracked-file drift: the dist content in the working tree no longer
# matches what's committed (HEAD via the index). Plain `git diff` (no
# --exit-code) always exits 0 on success regardless of whether differences are
# found, so it plays nicely with `set -e`; we check for output instead.
MODIFIED="$(git_ diff --name-only -- "$DIST_DIR")"
if [ -n "$MODIFIED" ]; then
  FAILED=1
  REPORT="${REPORT}Modified tracked file(s) under $DIST_DIR (working tree no longer matches the committed version):
$(printf '%s\n' "$MODIFIED" | sed 's/^/    /')
"
fi

# 2. New untracked file(s) sitting under the dist dir — the #8152 blind spot.
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
  echo "::error::$DIST_DIR drift detected."
  printf '%s\n' "$REPORT"
  echo "Fix: rebuild, then commit the result. A modified tracked file just needs a" >&2
  echo "normal 'git add'; a NEW file needs 'git add -f' since $DIST_DIR is gitignored" >&2
  echo "(and, for a new package export, remember its sibling .d.ts/barrel entry too)." >&2
  exit 1
fi

echo "OK -- $DIST_DIR matches its committed state (no modified or new/untracked files)."
