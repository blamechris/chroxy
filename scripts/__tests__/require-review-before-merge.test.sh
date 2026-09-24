#!/usr/bin/env bash
#
# require-review-before-merge.test.sh — tests for
# scripts/require-review-before-merge.sh, the pre-merge review gate hook
# (#7907).
#
# The script is a Claude Code PreToolUse hook: it reads TOOL_NAME/TOOL_INPUT
# from the environment (the shape the harness invokes hooks with) and, for a
# Bash command mentioning `pr merge`, blocks (exit 2) unless every referenced
# open PR has a review comment. `gh` is stubbed deterministically so the tests
# never touch the network or depend on the runner's `gh` auth state.
#
# #7907: the "does this command mention pr merge" check used to be
# `echo "$COMMAND" | grep -q 'pr merge'`. Under this script's `set -euo
# pipefail` (line 10), grep -q's early exit can SIGPIPE a still-writing echo,
# which pipefail promotes to the pipeline's exit status — flipping a genuine
# match into "not found" and silently SKIPPING the entire gate (`exit 0`
# before any gh call runs at all). An ordinary short command can't trigger
# this, but #7907's own header comment documents the real trigger: "Python
# subprocess... Shell heredoc... batch merge scripts" — commands this hook is
# explicitly designed to catch can be large. Case 5 below reproduces it with
# a >128KB COMMAND.
#
# No external test framework — matches the sibling scripts/__tests__/*.test.sh
# harnesses.
#
# Run from anywhere:  bash scripts/__tests__/require-review-before-merge.test.sh
# Exit status: 0 if all cases pass, 1 otherwise.

set -uo pipefail

# Size of a padding value passed as ONE argv/env string. Linux caps any single
# argument or environment string at MAX_ARG_STRLEN (32 pages = 131072 bytes),
# so a 400KB value fails exec with E2BIG ("Argument list too long") before the
# script under test even runs. 100000 bytes stays under that cap and is still
# larger than Linux's 64KiB default pipe buffer, so the SIGPIPE race remains
# reachable; macOS has no per-string cap and needs the larger value to beat
# XNU's pipe-buffer growth. File-based paddings are unaffected.
ARG_PAD_BYTES=$([ "$(uname -s)" = Linux ] && echo 100000 || echo 400000)

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$REPO_ROOT/scripts/require-review-before-merge.sh"

# Every case below must run. Without this, a harness whose cases stop executing
# prints "PASS — all 0 cases" and exits 0 — "all cases passed" and "no case
# executed" are the same observable outcome, the second recurring cause in
# docs/false-safety-guards.md (#7653). Asserted EQUAL, not -ge, so removing a
# case is as loud as skipping one.
EXPECTED_CASES=6

PASS=0
FAIL=0
FAILED=()

check() {
  if [ "$2" = "$3" ]; then
    PASS=$((PASS + 1)); echo "ok   - $1 (exit=$3)"
  else
    FAIL=$((FAIL + 1)); FAILED+=("$1 (expected exit $2, got $3)")
    echo "FAIL - $1 (expected exit $2, got $3)"
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A deterministic `gh` stub. REVIEW_COUNT_FOR (env var) controls what the
# comments-listing call reports, so each case can force either branch of
# "has a review comment" without touching the network or real gh auth.
STUB_DIR="$TMP/stub-bin"
mkdir -p "$STUB_DIR"
cat > "$STUB_DIR/gh" <<'STUB'
#!/bin/bash
case "$*" in
  "repo view --json nameWithOwner -q .nameWithOwner")
    echo "test-owner/test-repo"
    ;;
  "pr view "*" --json state -q .state")
    echo "OPEN"
    ;;
  "api repos/test-owner/test-repo/issues/"*"/comments --paginate -q"*)
    echo "${REVIEW_COUNT_FOR:-0}"
    ;;
  *)
    echo "0"
    ;;
esac
STUB
chmod +x "$STUB_DIR/gh"

# run_hook <tool_name> <command> [review_count] -> echoes the hook's exit code.
run_hook() {
  local tool_name="$1" command="$2" review_count="${3:-0}"
  local tool_input
  tool_input="$(python3 -c "import json,sys; print(json.dumps({'command': sys.argv[1]}))" "$command")"
  (
    export TOOL_NAME="$tool_name"
    export TOOL_INPUT="$tool_input"
    export REVIEW_COUNT_FOR="$review_count"
    export PATH="$STUB_DIR:$PATH"
    bash "$HOOK" >/dev/null 2>&1
  )
  echo $?
}

# --- Case 1 — a non-Bash tool call is out of scope --------------------------
check "a non-Bash tool call exits 0 immediately" \
  0 "$(run_hook "Read" "gh pr merge 12345 --squash")"

# --- Case 2 — a Bash command with no 'pr merge' is out of scope ------------
check "a command without 'pr merge' exits 0" \
  0 "$(run_hook "Bash" "npm test")"

# --- Case 3 — 'pr merge' + an open PR with NO review comment is BLOCKED ----
check "'pr merge' referencing an unreviewed open PR is BLOCKED (exit 2)" \
  2 "$(run_hook "Bash" "gh pr merge 12345 --squash" "0")"

# --- Case 4 — 'pr merge' + an open PR WITH a review comment is allowed -----
check "'pr merge' referencing a reviewed open PR exits 0" \
  0 "$(run_hook "Bash" "gh pr merge 12345 --squash" "1")"

# --- Case 5 — #7907: the gate survives pipefail+SIGPIPE on a large COMMAND -
# THE red-proof: a genuine 'pr merge' + PR reference near the START of a
# >128KB COMMAND (the batch-merge-script / heredoc shape this hook's own
# header comment names as a thing it must catch) must still reach the gh
# calls and BLOCK, not silently exit 0 via the pre-fix SIGPIPE race.
# Reproduced 5/5 against the pre-fix script (see the PR body for the
# transcript): the gate was bypassed every time.
pad="$(python3 -c "import sys; sys.stdout.write('p' * int(sys.argv[1]))" "$ARG_PAD_BYTES")"
large_command="gh pr merge 12345 --squash
$pad"
check "#7907 — gate survives pipefail+SIGPIPE on a >64KB COMMAND (still BLOCKS)" \
  2 "$(run_hook "Bash" "$large_command" "0")"

# --- Case 6 — same large COMMAND, but the PR IS reviewed: must NOT over-block
# Negative control for case 5: proves the fix does not just "always block" at
# scale — it correctly reaches the gh calls and respects a real review.
check "#7907 — the same large COMMAND is allowed through when the PR IS reviewed" \
  0 "$(run_hook "Bash" "$large_command" "1")"

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
