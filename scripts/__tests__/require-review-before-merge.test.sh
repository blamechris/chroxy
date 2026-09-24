#!/usr/bin/env bash
#
# require-review-before-merge.test.sh — tests for
# scripts/require-review-before-merge.sh, the pre-merge review gate hook
# (#7907, #7914).
#
# The script is a Claude Code PreToolUse hook. Claude Code delivers hook
# input as JSON on STDIN — {"hook_event_name":"PreToolUse","tool_name":
# "Bash","tool_input":{"command":"..."},...} — and does NOT set TOOL_NAME /
# TOOL_INPUT environment variables. #7914 found that the pre-fix script read
# only those env vars, so on every real invocation TOOL_NAME was empty and
# the gate exited 0 (allow) before checking anything — this repo's own
# #7913 test suite drove the script through the env-var shape and never
# caught it, the textbook "testing a shape the production caller never
# uses" false-safety class. This suite drives the script the way Claude Code
# actually does: JSON piped on stdin. `gh` is stubbed deterministically so
# the tests never touch the network or depend on the runner's `gh` auth
# state.
#
# #7907 (kept from the original suite): the "does this command mention pr
# merge" check used to be `echo "$COMMAND" | grep -q 'pr merge'`. Under this
# script's `set -euo pipefail`, grep -q's early exit can SIGPIPE a
# still-writing echo, which pipefail promotes to the pipeline's exit status
# — flipping a genuine match into "not found" and silently SKIPPING the
# entire gate. The fix uses a here-string (`grep -q PATTERN <<<"$COMMAND"`)
# instead, which has no separate producer process to SIGPIPE. Cases 5/6
# below reproduce the large-command shape that made this reachable — now via
# stdin, which (unlike an argv/env string) has no OS-level size cap, so the
# padding can be uniform across platforms instead of Linux-vs-macOS-sized.
#
# No external test framework — matches the sibling scripts/__tests__/*.test.sh
# harnesses.
#
# Run from anywhere:  bash scripts/__tests__/require-review-before-merge.test.sh
# Exit status: 0 if all cases pass, 1 otherwise.

set -uo pipefail

# Padding for the #7907 large-command cases. Stdin has no per-string OS cap
# (unlike argv/env, which #7913's version had to size per-platform via
# MAX_ARG_STRLEN) — a uniform size well past Linux's 64KiB default pipe
# buffer and macOS's pipe-buffer growth is enough on every platform.
PAD_BYTES=300000

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$REPO_ROOT/scripts/require-review-before-merge.sh"

# Every case below must run. Without this, a harness whose cases stop
# executing prints "PASS — all 0 cases" and exits 0 — "all cases passed" and
# "no case executed" are the same observable outcome, the second recurring
# cause in docs/false-safety-guards.md (#7653). Asserted EQUAL, not -ge, so
# removing a case is as loud as skipping one.
EXPECTED_CASES=16

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

check_bool() {
  # check_bool <description> <0-for-true|1-for-false>
  if [ "$2" -eq 0 ]; then
    PASS=$((PASS + 1)); echo "ok   - $1"
  else
    FAIL=$((FAIL + 1)); FAILED+=("$1")
    echo "FAIL - $1"
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A deterministic `gh` stub. REVIEW_COUNT_FOR controls what the
# comments-listing call reports. GH_MODE controls whether `gh repo view` /
# `gh pr view` succeed, fail with a generic (network/auth-shaped) error, or
# fail with the exact "not found" error real `gh` prints for a PR number
# that doesn't exist — the three cases the fix must tell apart (#7914
# secondary finding: a gh failure must fail CLOSED, but a genuine "not a
# real PR number" must still be skipped, not block on every 3-5 digit number
# incidentally present in a command).
STUB_DIR="$TMP/stub-bin"
mkdir -p "$STUB_DIR"
cat > "$STUB_DIR/gh" <<'STUB'
#!/bin/bash
case "$*" in
  "repo view --json nameWithOwner -q .nameWithOwner")
    if [ "${GH_MODE:-ok}" = "repo_fail" ]; then
      echo "gh: authentication failed (stub)" >&2
      exit 1
    fi
    echo "test-owner/test-repo"
    ;;
  "pr view "*" --json state -q .state")
    PR_ARG="$3"
    case "${GH_MODE:-ok}" in
      prview_fail)
        echo "gh: could not connect to api.github.com (stub network error)" >&2
        exit 1
        ;;
      prview_notfound)
        echo "GraphQL: Could not resolve to a PullRequest with the number of ${PR_ARG}. (repository.pullRequest)" >&2
        exit 1
        ;;
      *)
        echo "OPEN"
        ;;
    esac
    ;;
  "api repos/test-owner/test-repo/issues/"*"/comments --paginate -q"*)
    if [ "${GH_MODE:-ok}" = "api_fail" ]; then
      echo "gh: could not connect to api.github.com (stub network error)" >&2
      exit 1
    fi
    echo "${REVIEW_COUNT_FOR:-0}"
    ;;
  *)
    echo "0"
    ;;
esac
STUB
chmod +x "$STUB_DIR/gh"

# build_payload <tool_name> <command> -> the real PreToolUse JSON shape on
# stdout, built via python3 so arbitrary command text (quotes, newlines, the
# #7907 padding) is always safely quoted. The command is fed to python3 via
# STDIN, not argv: Linux caps a single argv/env string at MAX_ARG_STRLEN
# (128KiB — the exact limit #7913 sized its OWN padding around), and this
# helper's whole point is to build the #7907 300KB-command fixture, which
# blows through that cap. Reproduced on Linux (node:22-bookworm): passing the
# command as $2 failed with "python3: Argument list too long" and silently
# turned the red-proof case green for the wrong reason (python3 crashed,
# COMMAND came back empty, "pr merge" no longer matched, so the hook allowed
# instead of blocking) — tool_name has no such size concern and stays on argv.
build_payload() {
  printf '%s' "$2" | python3 -c "
import json, sys
command = sys.stdin.read()
print(json.dumps({'tool_name': sys.argv[1], 'tool_input': {'command': command}}))
" "$1"
}

# run_hook_stdin <payload_json> [review_count] [gh_mode] -> echoes the
# hook's exit code. This is the shape Claude Code actually invokes the hook
# with: JSON piped on stdin, no TOOL_NAME/TOOL_INPUT env vars set.
run_hook_stdin() {
  local payload="$1" review_count="${2:-0}" gh_mode="${3:-ok}"
  (
    export REVIEW_COUNT_FOR="$review_count"
    export GH_MODE="$gh_mode"
    export PATH="$STUB_DIR:$PATH"
    printf '%s' "$payload" | bash "$HOOK" >/dev/null 2>&1
  )
  echo $?
}

# run_hook_env <tool_name> <command> [review_count] -> echoes the hook's
# exit code, driving the documented ENV-VAR FALLBACK path (stdin redirected
# from /dev/null so the script actually takes that branch rather than
# blocking on a TTY read).
run_hook_env() {
  local tool_name="$1" command="$2" review_count="${3:-0}"
  local tool_input
  tool_input="$(printf '%s' "$command" | python3 -c "import json,sys; print(json.dumps({'command': sys.stdin.read()}))")"
  (
    export TOOL_NAME="$tool_name"
    export TOOL_INPUT="$tool_input"
    export REVIEW_COUNT_FOR="$review_count"
    export GH_MODE="ok"
    export PATH="$STUB_DIR:$PATH"
    bash "$HOOK" </dev/null >/dev/null 2>&1
  )
  echo $?
}

# --- Case 1 — a non-Bash tool call is out of scope --------------------------
check "a non-Bash tool call (stdin) exits 0 immediately" \
  0 "$(run_hook_stdin "$(build_payload Read "gh pr merge 12345 --squash")")"

# --- Case 2 — a Bash command with no 'pr merge' is out of scope ------------
check "a command without 'pr merge' (stdin) exits 0" \
  0 "$(run_hook_stdin "$(build_payload Bash "npm test")")"

# --- Case 3 — 'pr merge' + an open PR with NO review comment is BLOCKED ----
check "'pr merge' referencing an unreviewed open PR (stdin) is BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 12345 --squash")" "0")"

# --- Case 4 — 'pr merge' + an open PR WITH a review comment is allowed -----
check "'pr merge' referencing a reviewed open PR (stdin) exits 0" \
  0 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 12345 --squash")" "1")"

# --- Case 5 — #7907: the gate survives pipefail+SIGPIPE on a large COMMAND -
# THE red-proof: a genuine 'pr merge' + PR reference near the START of a
# 300KB COMMAND (the batch-merge-script / heredoc shape this hook's own
# header comment names as a thing it must catch) must still reach the gh
# calls and BLOCK, not silently exit 0 via the pre-fix SIGPIPE race.
pad="$(python3 -c "import sys; sys.stdout.write('p' * int(sys.argv[1]))" "$PAD_BYTES")"
large_command="gh pr merge 12345 --squash
$pad"
check "#7907 — gate survives pipefail+SIGPIPE on a 300KB COMMAND via stdin (still BLOCKS)" \
  2 "$(run_hook_stdin "$(build_payload Bash "$large_command")" "0")"

# --- Case 6 — same large COMMAND, but the PR IS reviewed: must NOT over-block
# Negative control for case 5: proves the fix does not just "always block" at
# scale — it correctly reaches the gh calls and respects a real review.
check "#7907 — the same 300KB COMMAND is allowed through when the PR IS reviewed" \
  0 "$(run_hook_stdin "$(build_payload Bash "$large_command")" "1")"

# --- Case 7 — malformed stdin JSON is BLOCKED (fail closed) ----------------
check "malformed stdin JSON is BLOCKED (exit 2), not silently allowed" \
  2 "$(run_hook_stdin "not valid json{{{")"

# --- Case 8 — a Bash tool_input with no 'command' field is BLOCKED --------
missing_command_payload=$(python3 -c "import json; print(json.dumps({'tool_name': 'Bash', 'tool_input': {}}))")
check "a Bash payload with no 'command' field is BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$missing_command_payload")"

# --- Case 9 — a 'gh repo view' failure (network/auth) fails CLOSED --------
check "'gh repo view' failure (network/auth) fails CLOSED (exit 2), not allowed" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 12345 --squash")" "0" "repo_fail")"

# --- Case 10 — a 'gh pr view' failure (network/auth, NOT "not found") fails
# CLOSED. Pre-fix behaviour treated ANY gh pr view failure as "not an open
# PR" and skipped it — if every referenced PR number fails this way (gh
# totally unreachable), MISSING_REVIEW stays empty and the script falls
# through to exit 0, opening the gate exactly when GitHub can't be asked.
check "'gh pr view' network/auth failure fails CLOSED (exit 2), not skipped" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 12345 --squash")" "0" "prview_fail")"

# --- Case 11 — a genuine "not a real PR" gh pr view failure is NOT a gate
# failure — negative control for case 10/#7914's secondary fix: proves the
# fail-closed change does not regress into blocking on every 3-5 digit
# number that happens to appear in a command (a port, a line count, ...).
check "'gh pr view' genuine not-found (bogus PR number) is NOT blocked (exit 0)" \
  0 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 12345 --squash")" "0" "prview_notfound")"

# --- Case 12 — the documented env-var FALLBACK still works: unreviewed ----
check "env-var fallback shape (stdin empty): unreviewed PR still BLOCKED (exit 2)" \
  2 "$(run_hook_env "Bash" "gh pr merge 12345 --squash" "0")"

# --- Case 13 — the documented env-var FALLBACK still works: reviewed ------
check "env-var fallback shape (stdin empty): reviewed PR still exits 0" \
  0 "$(run_hook_env "Bash" "gh pr merge 12345 --squash" "1")"

# --- Case 14 — a 'gh api' (review-comments lookup) failure fails CLOSED,
# distinguishably from a genuine 0-review-comments PR ------------------------
# The exit code ALONE cannot tell these two cases apart: the pre-fix script's
# `gh api ... || echo "0"` already treated an api failure the same as "found
# 0 review comments", which also blocks (exit 2) — so an exit-code-only
# assertion here would stay green even with that fail-open-by-coincidence
# fallback restored (verified: mutating the fix back to `|| echo "0"` passes
# every other case in this suite untouched). What must differ is the
# DIAGNOSIS: a real gh failure should say so, not report a false "no review
# comment" that sends someone to re-run /full-review on a PR that already has
# one.
API_STDERR_FILE="$TMP/stderr-case-api-fail"
(
  export REVIEW_COUNT_FOR="1"
  export GH_MODE="api_fail"
  export PATH="$STUB_DIR:$PATH"
  printf '%s' "$(build_payload Bash "gh pr merge 12345 --squash")" | bash "$HOOK" >/dev/null 2>"$API_STDERR_FILE"
)
API_FAIL_EXIT=$?
if [ "$API_FAIL_EXIT" -eq 2 ] && grep -q "gh api" "$API_STDERR_FILE"; then
  API_FAIL_OK=0
else
  API_FAIL_OK=1
fi
check_bool "'gh api' (review-comments) failure fails CLOSED (exit 2) and names 'gh api' in the reason" "$API_FAIL_OK"

# --- Case 15 — the block message goes to STDERR, not STDOUT ---------------
# Claude Code's PreToolUse hook contract feeds the block reason to the model
# from STDERR on exit 2 (code.claude.com/docs/en/hooks-guide); stdout is not
# read for this purpose. The pre-fix script `echo`'d its BLOCKED message to
# stdout.
STDOUT_FILE="$TMP/stdout-case14"
STDERR_FILE="$TMP/stderr-case14"
(
  export REVIEW_COUNT_FOR="0"
  export GH_MODE="ok"
  export PATH="$STUB_DIR:$PATH"
  printf '%s' "$(build_payload Bash "gh pr merge 12345 --squash")" | bash "$HOOK" >"$STDOUT_FILE" 2>"$STDERR_FILE"
)
CASE14_EXIT=$?
if [ "$CASE14_EXIT" -eq 2 ] && grep -q "BLOCKED" "$STDERR_FILE" && ! grep -q "BLOCKED" "$STDOUT_FILE"; then
  CASE14_OK=0
else
  CASE14_OK=1
fi
check_bool "the BLOCKED message is on stderr, and stdout carries none of it" "$CASE14_OK"

# --- Case 16 — STRUCTURAL: every echo'd message in the script is on stderr -
# Case 15 proves stderr-routing end-to-end for ONE path (the missing-review
# block). The hook has several distinct block-message sites (malformed JSON,
# no command field, no PR numbers extracted, each gh-failure branch, the
# internal-error trap, the missing-review list) and every one of them got the
# same mechanical `echo "..."` -> `echo "..." >&2` edit — adding an E2E
# stdin/stdout/stderr harness case per site would just re-prove the identical
# property six more times. A static sweep over the SOURCE instead: no line in
# the script is a plain, unredirected `echo "..."` — catches a regression at
# ANY site (including ones added later) in one assertion, without an E2E
# fixture per branch. This does not replace case 15 (which is the only case
# that proves the redirection actually reaches the real stderr stream when
# Claude Code invokes the script), it complements it.
UNREDIRECTED_ECHOES=$(grep -n '^[[:space:]]*echo "' "$HOOK" | grep -v '>&2' || true)
check_bool "no unredirected (stdout) 'echo \"...\"' message exists anywhere in the script" \
  "$([ -z "$UNREDIRECTED_ECHOES" ] && echo 0 || echo 1)"

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
