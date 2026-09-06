#!/usr/bin/env bash
#
# Parse-check every tracked shell script (#7504, #7646).
#
# Nothing in .github/ had ever parsed these. Every tracked *.sh file is invoked
# from a workflow step, a git hook or by hand; none is imported by a test suite,
# so a syntax error in one ships green and is discovered by the next person to
# run it (#7504).
#
# THIS FILE EXISTS BECAUSE THE LOOP USED TO LIVE IN ci.yml (#7646). Inline in a
# workflow step it was reachable by no lint and no test in the repo — the #7270
# shape — so the only thing standing behind it was a describe block asserting
# three REGEXES over the step's YAML text. All six mutations #7646 reported
# survive those assertions, four of them SILENTLY — including `rc=1` demoted to
# a warning and `exit "$rc"` replaced by `exit 0`, either of which turns the
# whole sweep into a no-op that reports success. Text a guard matches is not
# behaviour a guard tests; the loop is here so that
# scripts/__tests__/parse-check-shell.test.sh can RUN it.
#
# PARSE-LEVEL ONLY, and this comment claims no more than the code does:
# `bash -n` reads a file and reports SYNTAX errors without executing anything.
# It does not catch unset variables, word-splitting, bad quoting or any of the
# semantic class shellcheck covers — adopting shellcheck over 30 files is a
# separate decision with a real baseline of findings behind it, deliberately
# not folded in here.
#
# It is also VERSION-scoped, and `scripts-tests` runs on Linux only: `bash -n`
# proves the RUNNER's bash parses the file. A bash-4+ construct — `;;&`, `|&`,
# `coproc name { ... }`, `${var@Q}` — passes here and is a syntax error on the
# macOS /bin/bash 3.2 this repo's own guides tell you to run scripts under.
# Measured: a `;;&` file is rc=0 under Linux bash 5.2 and rc=2 under 3.2. Making
# the claim stronger means a second leg with a pinned bash, which is a separate
# decision with its own cost.
#
# The file list comes from `git ls-files`, not a glob roster typed into this
# script: a hardcoded list beside a growing set is the first cause in
# docs/false-safety-guards.md. A pathspec scoped to `scripts/*.sh` would
# silently skip packages/server/scripts/, packages/desktop/scripts/,
# packages/app/.maestro/scripts/ and every directory added after it was
# written. Every tracked *.sh carries a bash shebang, so `bash -n` is the right
# parser for all of them.
#
# It fails CLOSED three ways, because "found nothing to check" must not read as
# "nothing wrong" — the second cause in docs/false-safety-guards.md, and the one
# a `for f in glob` loop gets wrong for free (an unmatched glob iterates zero
# times, exit 0):
#
#   * `git ls-files` is redirected to a file and its EXIT STATUS checked, so a
#     git failure is a distinct, loud outcome rather than an empty list. It
#     cannot be captured with `$(...)`: NUL-delimited output does not survive a
#     bash variable, which is the whole reason for the temp file.
#   * the count is held to a floor. The floor is loose on purpose — it catches
#     an enumeration that has stopped working or been narrowed, not today's
#     file count.
#   * the root is resolved from this script's own location, so an invocation
#     from a subdirectory cannot narrow the enumeration. Measured: `git ls-files
#     '*.sh'` run from packages/app/.maestro lists only that subtree.
#
# TWO THINGS HERE ARE FLOORS RATHER THAN COVERED BEHAVIOUR, and both are
# recorded as such rather than claimed as tested:
#
#   * `set -euo pipefail`. Every failure this script cares about is checked
#     explicitly, so removing the line survives the whole mutation suite. It is
#     kept to catch the NEXT edit that forgets an explicit check — a claim about
#     future code that no test can make.
#   * the three `exit 3` branches. Each survives mutation to `exit 0`: no test
#     reaches an unresolvable root, an un-enterable root, or a failing `mktemp`
#     without contriving the filesystem. A hostile CDPATH used to reach the
#     second one, and the scrub below closed that door rather than leaving a bug
#     as a test fixture. They exist so the failure names itself instead of
#     surfacing as a bare non-zero from `set -e`.
#
# Run:  bash scripts/parse-check-shell.sh
# Exit: 0  every tracked shell script parses
#       1  at least one has a SYNTAX error (the file is named in the output)
#       2  the ENUMERATION is broken — git failed, or came back below the floor
#       3  the checker itself could not run (no mktemp, unusable root)
set -euo pipefail

# An exported CDPATH makes `cd` ECHO the directory it resolved to, so the
# command substitution below captures TWO lines and every later use of $ROOT is
# a two-line string. Measured on macOS bash 3.2.57 and Linux bash 5.2 alike:
# `CDPATH=. bash scripts/parse-check-shell.sh` exits 3 with a garbled path and
# never names CDPATH. It fails closed, so this is diagnosability rather than a
# false green — but `CDPATH=.` is an ordinary thing to have in a shell profile
# and this script's header invites hand invocation.
CDPATH=''

# The one constant in this file. Everything else is derived.
MIN_SCRIPTS=20

ROOT="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)" || ROOT=''
if [ -z "$ROOT" ]; then
  echo "::error::parse-check-shell.sh: cannot resolve the repository root from $0"
  exit 3
fi
cd "$ROOT" || {
  echo "::error::parse-check-shell.sh: cannot enter the repository root $ROOT"
  exit 3
}

listing="$(mktemp)" || {
  echo "::error::parse-check-shell.sh: mktemp failed; cannot enumerate"
  exit 3
}
trap 'rm -f "$listing"' EXIT

# Redirected rather than piped or captured: a pipe would report the READER's
# exit status (the trap this repo has recorded more than once), and a `$(...)`
# capture would drop the NUL delimiters entirely.
if ! git ls-files -z '*.sh' > "$listing"; then
  echo "::error::parse-check-shell.sh: git ls-files failed in $ROOT - the enumeration is broken, not the tree"
  exit 2
fi

count=0
rc=0
while IFS= read -r -d '' f; do
  bash -n "$f" || { echo "::error file=$f::bash -n: parse error"; rc=1; }
  # Counted AFTER the parse, so the number below means "files handed to
  # `bash -n`" and not "files enumerated". The two differ under exactly the
  # mutation that matters: anything that `continue`s out of the loop for some
  # paths leaves the enumeration intact, and counting first would report the
  # full 32 while parsing 15 — measured, and it survived all 23 cases of the
  # suite until the counter moved down here.
  count=$((count + 1))
done < "$listing"

echo "parsed $count tracked shell script(s)"

if [ "$count" -lt "$MIN_SCRIPTS" ]; then
  echo "::error::enumerated only $count shell scripts (expected >=$MIN_SCRIPTS) - the enumeration is broken, not the tree"
  exit 2
fi

exit "$rc"
