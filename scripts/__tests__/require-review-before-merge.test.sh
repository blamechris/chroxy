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
EXPECTED_CASES=88

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

# --- Case 16 — STRUCTURAL: every LINE-INITIAL echo'd message in the script
# is on stderr -----------------------------------------------------------
# Case 15 proves stderr-routing end-to-end for ONE path (the missing-review
# block). The hook has several distinct block-message sites (malformed JSON,
# no command field, no PR numbers extracted, each gh-failure branch, the
# internal-error trap, the missing-review list) and every one of them got the
# same mechanical `echo "..."` -> `echo "..." >&2` edit — adding an E2E
# stdin/stdout/stderr harness case per site would just re-prove the identical
# property six more times. A static sweep over the SOURCE instead, scoped to
# every LINE-INITIAL `echo "..."` — the shape every diagnostic message in
# this script takes (one echo, one message, its own line): none of them may
# be unredirected. Catches a regression at that shape in one assertion,
# without an E2E fixture per branch. This does NOT sweep an `echo "..."` that
# occurs mid-line (joined with `;` after other code, or a data-producing
# `echo` feeding a pipe/`||` fallback, e.g. `COMMAND=$(... || echo "")` and
# `echo "$COMMAND" | grep ...` above) — those are not user-facing diagnostic
# messages and a pattern that also caught them would need to positively
# exclude non-message echoes rather than just widen the anchor. A future
# block message written mid-line (`if ...; then echo "BLOCKED: ..."; fi` on
# one line) would slip past this sweep undetected; case 15 is still the only
# case that proves the redirection reaches the real stderr stream when
# Claude Code invokes the script, and this complements it for the
# line-initial shape every current message site actually uses.
UNREDIRECTED_ECHOES=$(grep -n '^[[:space:]]*echo "' "$HOOK" | grep -v '>&2' || true)
check_bool "no unredirected (stdout) LINE-INITIAL 'echo \"...\"' message exists in the script" \
  "$([ -z "$UNREDIRECTED_ECHOES" ] && echo 0 || echo 1)"

# --- Case 17 — #7921 bypass hunting: `gh api ... pulls/<n>/merge` (the raw
# GitHub REST call `gh pr merge` wraps) is BLOCKED exactly like `gh pr merge`
# itself — it never contains the literal text "pr merge", so the pre-#7921
# `grep -q 'pr merge'` pattern let it straight through. Red against that
# pattern: verified manually (piping this payload through a copy of the hook
# reverted to `grep -q 'pr merge'` exits 0, not 2).
check "#7921 — 'gh api ... pulls/<n>/merge' referencing an unreviewed PR (stdin) is BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh api -X PUT repos/test-owner/test-repo/pulls/12345/merge")" "0")"

# --- Case 18 — negative control for case 17: a reviewed PR via the same
# `gh api .../merge` form is allowed through, not blocked unconditionally.
check "#7921 — the same 'gh api ... pulls/<n>/merge' is allowed through when the PR IS reviewed" \
  0 "$(run_hook_stdin "$(build_payload Bash "gh api -X PUT repos/test-owner/test-repo/pulls/12345/merge")" "1")"

# --- Case 19 — #7921 bypass hunting: repeated whitespace between 'pr' and
# 'merge' (`gh  pr   merge`, multiple spaces) is BLOCKED. The pre-#7921
# literal substring `grep -q 'pr merge'` required exactly one space, so any
# other run of whitespace slipped through as "no 'pr merge' found" and the
# gate never even reached the gh calls.
check "#7921 — 'gh  pr   merge' (repeated spaces) referencing an unreviewed PR is BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh  pr   merge 12345 --squash")" "0")"

# --- Case 20 — #7921 bypass hunting: a TAB between 'pr' and 'merge' is
# BLOCKED for the same reason as case 19 — a real, if unusual, shape a
# generated or hand-edited command could take.
check "#7921 — a TAB between 'pr' and 'merge' referencing an unreviewed PR is BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "$(printf 'gh pr\tmerge 12345 --squash')")" "0")"

# --- Case 21 — #7922: the GraphQL `mergePullRequest` mutation merges a PR
# without containing "pr merge" or "pulls/<n>/merge". Before #7922 this
# payload exited 0 (measured). The review count is 1 on purpose: the block
# is unconditional, so a review must not open it. Goes red (exit 0) if
# `mergePullRequest` is dropped from the match.
check "#7922 — a GraphQL 'mergePullRequest' mutation is BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"PR_kwDOtest\"}) { clientMutationId } }'")" "1")"

# --- Case 22 — #7922: `enablePullRequestAutoMerge` is the GraphQL form of
# `gh pr merge --auto`, which would merge the PR later with no command left
# for this hook to see. Same shape and same red-proof as case 21.
check "#7922 — a GraphQL 'enablePullRequestAutoMerge' mutation is BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"PR_kwDOtest\"}) { clientMutationId } }'")" "1")"

# --- Case 23 — #7922: the GraphQL block must run BEFORE the PR-number check,
# not inside it. The mutation names its PR by node id, so a number check can
# only ever see SOME OTHER number in the command. Here that is `head -100`,
# and the stub reports every number as an open, reviewed PR. Routed through
# the number check, this merge would be allowed (exit 0); blocked outright,
# it is not.
check "#7922 — a GraphQL merge with an incidental reviewed number (head -100) is still BLOCKED" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"PR_kwDOtest\"}) { clientMutationId } }' | head -100")" "1")"

# --- Case 24 — #7922: same property, reached from the other side. A command
# that ALSO runs `gh pr merge` on a reviewed PR matches the `pr merge` path,
# so a GraphQL check nested inside the no-`pr merge` branch would never run
# and the node-id merge would ride through on the reviewed PR's number.
check "#7922 — a GraphQL merge alongside 'gh pr merge <reviewed>' is still BLOCKED" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 12345 --squash && gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"PR_kwDOother\"}) { clientMutationId } }'")" "1")"

# #7991 regression suite. The first ALLOW implementation modeled shell
# parsing (python3 shlex over segments); a review found 30+ constructs where
# that model and the real shell disagreed and reworked it into a raw-text
# allowlist (see the ALLOWLIST comment in require-review-before-merge.sh).
# Every case below is one bypass class from that review, sourced from its
# case list so the literal command text matches what was actually probed
# against `gh`. Cases are labeled to match that list; "killer" cases are
# aimed at specific mutations of the allowlist implementation (see the PR
# description for the mutation-testing results).

# --- Case 25 — #7991 [A4]: no --repo at all still requires the review comment
check "#7991 [A4] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --squash")" "0")"

# --- Case 26 — #7991 [B1]: a PR URL selector beats --repo (gh takes the repo from the URL)
check "#7991 [B1] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge https://github.com/blamechris/chroxy/pull/7990 --repo blamechris/github-runners --squash")" "0")"

# --- Case 27 — #7991 [B2]: -R=value (gh's pflag strips the '=', this hook does not recognize it as a repo flag)
check "#7991 [B2] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 -R=blamechris/chroxy --squash")" "0")"

# --- Case 28 — #7991 [B3]: an scp-style git@ URL naming chroxy
check "#7991 [B3] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --repo git@github.com:blamechris/chroxy.git --squash")" "0")"

# --- Case 29 — #7991 [B4]: an https URL with a trailing .git/
check "#7991 [B4] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --repo https://github.com/blamechris/chroxy.git/ --squash")" "0")"

# --- Case 30 — #7991 [B5]: an unset parameter expansion glued to the repo value
# shellcheck disable=SC2016 # single-quoted on purpose: $x must reach the hook
# as literal text, not be expanded by this test script's own shell.
check "#7991 [B5] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash 'gh pr merge 7990 --repo blamechris/chroxy$x --squash')" "0")"

# --- Case 31 — #7991 [B6]: a ${var} expansion glued to the repo value
# shellcheck disable=SC2016 # single-quoted on purpose: ${x} must reach the
# hook as literal text, not be expanded by this test script's own shell.
check "#7991 [B6] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash 'gh pr merge 7990 --repo blamechris/chroxy${x} --squash')" "0")"

# --- Case 32 — #7991 [B7]: an ANSI-C quoted repo value
check "#7991 [B7] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash 'gh pr merge 7990 --repo $'\''blamechris/chroxy'\'' --squash')" "0")"

# --- Case 33 — #7991 [B8]: a locale-quoted repo value
check "#7991 [B8] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash 'gh pr merge 7990 --repo $"blamechris/chroxy" --squash')" "0")"

# --- Case 34 — #7991 [B9]: brace expansion in the repo value (gh would use the
# last alternative). Single-quoted deliberately: a DOUBLE-quoted argument
# containing this exact {,X} shape gets brace-expanded by bash specifically
# when nested two command-substitution levels deep — the same
# run_hook_stdin "$(build_payload ...)" shape every case in this file uses —
# even though the argument is fully quoted (verified empirically; see the PR
# description). Single-quoting avoids it, since bash never performs brace
# expansion inside single quotes regardless of nesting depth.
check "#7991 [B9] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash 'gh pr merge 7990 --repo=blamechris/{,chroxy} --squash')" "0")"

# --- Case 35 — #7991 [C1]: --repo is actually the VALUE of --body, which takes an argument in real gh
check "#7991 [C1] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --squash --body --repo=blamechris/github-runners")" "0")"

# --- Case 36 — #7991 [C2]: a glued -R value is actually the VALUE of -t/--subject
check "#7991 [C2] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --squash -t -Rblamechris/github-runners")" "0")"

# --- Case 37 — #7991 [D1]: a mid-word # followed by ';' and a second merge
check "#7991 [D1] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 8 --repo blamechris/github-runners --squash --body=a#; gh pr merge 7990 --squash")" "0")"

# --- Case 38 — #7991 [D2]: a comment on one line, a qualifying cross-repo merge on the next
check "#7991 [D2] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --squash # merge the chroxy one first
gh pr merge 8 --repo blamechris/github-runners --squash")" "0")"

# --- Case 39 — #7991 [D3]: a real trailing comment only (negative control)
check "#7991 [D3] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --squash # -R blamechris/github-runners")" "0")"

# --- Case 40 — #7991 [E1]: a here-string glued to --repo=
check "#7991 [E1] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --squash <<<--repo=blamechris/github-runners")" "0")"

# --- Case 41 — #7991 [E2]: a here-string glued to -R
check "#7991 [E2] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --squash <<< -Rblamechris/github-runners")" "0")"

# --- Case 42 — #7991 [E3]: process substitution on stdin
check "#7991 [E3] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --squash < <(echo --repo=blamechris/github-runners)")" "0")"

# --- Case 43 — #7991 [E4]: |& is not a recognized separator
check "#7991 [E4] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "echo -R blamechris/github-runners |& gh pr merge 7990 --squash")" "0")"

# --- Case 44 — #7991 [E5]: a case/esac construct joins its branches
check "#7991 [E5] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "case 1 in 0) echo -R blamechris/github-runners;; 1) gh pr merge 7990 --squash;; esac")" "0")"

# --- Case 45 — #7991 [E6]: an &> redirect that looks like a repo flag
check "#7991 [E6] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "mkdir -p -- --repo=blamechris && gh pr merge 7990 --squash &>--repo=blamechris/github-runners")" "0")"

# --- Case 46 — #7991 [F1]: xargs appends a second -R (real gh would use the last one)
check "#7991 [F1] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "echo -R blamechris/chroxy | xargs gh pr merge 7990 --squash -R blamechris/github-runners")" "0")"

# --- Case 47 — #7991 [F2]: xargs supplies a chroxy PR URL as the selector
check "#7991 [F2] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "echo https://github.com/blamechris/chroxy/pull/7990 | xargs gh pr merge --squash -R blamechris/github-runners")" "0")"

# --- Case 48 — #7991 [G1]: a second merge via the full path to gh
check "#7991 [G1] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 8 --repo blamechris/github-runners --squash && /opt/homebrew/bin/gh pr merge 7990 --squash")" "0")"

# --- Case 49 — #7991 [G2]: a second merge inside python3 -c
check "#7991 [G2] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 8 --repo blamechris/github-runners --squash; python3 -c 'import os; os.system(\"gh pr merge 7990 --squash\")'")" "0")"

# --- Case 50 — #7991 [G3]: a second merge inside bash -lc
check "#7991 [G3] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 8 --repo blamechris/github-runners --squash; bash -lc \"gh pr merge 7990 --squash\"")" "0")"

# --- Case 51 — #7991 [G4]: a second merge inside watch
check "#7991 [G4] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 8 --repo blamechris/github-runners --squash; watch -n 60 'gh pr merge 7990 --squash'")" "0")"

# --- Case 52 — #7991 [G5]: a second merge via timeout (negative control: already detected)
check "#7991 [G5] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 8 --repo blamechris/github-runners --squash; timeout 60 gh pr merge 7990 --squash")" "0")"

# --- Case 53 — #7991 [G6]: a second merge via command \gh (negative control: already detected)
check "#7991 [G6] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 8 --repo blamechris/github-runners --squash; command \\gh pr merge 7990 --squash")" "0")"

# --- Case 54 — #7991 [G7]: a second merge inside a bash heredoc (negative control: already detected)
check "#7991 [G7] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 8 --repo blamechris/github-runners --squash; bash <<'EOF'
gh pr merge 7990 --squash
EOF")" "0")"

# --- Case 55 — #7991 [G8]: a second merge inside ssh
check "#7991 [G8] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 8 --repo blamechris/github-runners --squash; ssh localhost 'cd ~/Projects/chroxy && gh pr merge 7990 --squash'")" "0")"

# --- Case 56 — #7991 [G9]: a second merge via bash  -c (double space)
check "#7991 [G9] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 8 --repo blamechris/github-runners --squash; bash  -c \"gh pr merge 7990 --squash\"")" "0")"

# --- Case 57 — #7991 [H1]: GH_REPO env pointing at chroxy plus a --repo flag (gh: the flag wins; this hook: not recognized as 'gh pr merge')
check "#7991 [H1] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "GH_REPO=blamechris/chroxy gh pr merge 7990 --repo blamechris/github-runners --squash")" "0")"

# --- Case 58 — #7991 [H2]: an empty --repo= value
check "#7991 [H2] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --repo= --squash")" "0")"

# --- Case 59 — #7991 [H3]: a --repo VALUE that is itself a chroxy PR URL with a path
check "#7991 [H3] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --repo https://github.com/blamechris/chroxy/pull/7990 --squash")" "0")"

# --- Case 60 — #7991 [H4]: case-insensitive chroxy match
check "#7991 [H4] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 -R BlameChris/Chroxy")" "0")"

# --- Case 61 — #7991 [H5]: an uppercase github.com/ host prefix (two slashes, not owner/name)
check "#7991 [H5] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --repo GITHUB.COM/blamechris/chroxy")" "0")"

# --- Case 62 — #7991 [H6]: backslash-newline continuation inside the cross-repo merge
check "#7991 [H6] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash 'gh pr merge 8 \
  --repo blamechris/github-runners --squash')" "0")"

# --- Case 63 — #7991 [H7]: a find -exec \; terminator
check "#7991 [H7] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "find . -maxdepth 0 -exec gh pr merge 7990 --squash \\; -o -name --repo=blamechris/x")" "0")"

# --- Case 64 — #7991 [H8]: a newline embedded inside a quoted --body value
check "#7991 [H8] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 8 --repo blamechris/github-runners --squash --body \"line1
gh pr merge 7990\"")" "0")"

# --- Case 65 — #7991 [H9]: two repo flags on one merge
check "#7991 [H9] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --repo blamechris/github-runners -R blamechris/chroxy")" "0")"

# --- Case 66 — #7991 [W2]: an uppercase .GIT suffix
check "#7991 [W2] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --repo blamechris/chroxy.GIT --squash")" "0")"

# --- Case 67 — #7991 [W3]: an https URL with an uppercase .GIT suffix
check "#7991 [W3] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --repo https://github.com/blamechris/chroxy.GIT --squash")" "0")"

# --- Case 68 — #7991 [W4]: a quoted repo value with a trailing newline
check "#7991 [W4] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --repo \"blamechris/chroxy
\" --squash")" "0")"

# --- Case 69 — #7991 [W5]: an uppercase scheme and host
check "#7991 [W5] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --repo HTTPS://GITHUB.COM/blamechris/chroxy --squash")" "0")"

# --- Case 70 — #7991 [W6]: a bare host + .git, no scheme (two slashes, not owner/name)
check "#7991 [W6] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --repo github.com/blamechris/chroxy.git --squash")" "0")"

# --- Case 71 — #7991 [W7]: an ssh:// URL that gh resolves to chroxy
check "#7991 [W7] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --repo ssh://git@github.com/blamechris/chroxy --squash")" "0")"

# --- Case 72 — #7991 [W8]: a www host that gh resolves to chroxy (two slashes, not owner/name)
check "#7991 [W8] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --repo www.github.com/blamechris/chroxy --squash")" "0")"

# --- Case 73 — #7991 [K1]: an unquoted $(...) glued to a chroxy repo value
# shellcheck disable=SC2016 # single-quoted on purpose: $(true) must reach the
# hook as literal text, not be executed by this test script's own shell.
check "#7991 [K1] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash 'gh pr merge 7990 --repo blamechris/chroxy$(true) --squash')" "0")"

# --- Case 74 — #7991 [Q1]: a GraphQL merge mutation alongside a qualifying cross-repo merge (GraphQL block runs first, unconditional)
check "#7991 [Q1] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 8 --repo blamechris/github-runners --squash && gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"PR_x\"}) { clientMutationId } }'")" "0")"

# --- Case 75 — #7991 [Q2]: a REST pulls/N/merge call alongside a qualifying cross-repo merge
check "#7991 [Q2] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 8 --repo blamechris/github-runners --squash && gh api -X PUT repos/blamechris/chroxy/pulls/7990/merge")" "0")"

# --- Case 76 — #7991 [Q3]: an http:// (not https) PR URL selector
check "#7991 [Q3] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge http://github.com/blamechris/chroxy/pull/7990 -R blamechris/github-runners --squash")" "0")"

# --- Case 77 — #7991 [Q4]: two cross-repo merges chained in one command (documented trade-off: each needs its own call)
check "#7991 [Q4] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 8 --repo blamechris/github-runners --squash && gh pr merge 5 -R blamechris/github-runners --squash")" "0")"

# --- Case 78 — #7991 [chroxy-exact]: an explicit --repo naming this repo, exactly, must not short-circuit the review check
check "#7991 [chroxy-exact] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --repo blamechris/chroxy --squash")" "0")"

# --- Case 79 — #7991 [two-repo-flags-killer]: MUTATION KILLER for 'len(repos) != 1' -> '< 1': two repo flags, chroxy last — gh would use the last one
check "#7991 [two-repo-flags-killer] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --repo blamechris/github-runners -R blamechris/chroxy --squash")" "0")"

# --- Case 80 — #7991 [ssh-malformed-killer]: MUTATION KILLER for dropping the NAME/NAME fullmatch: an ssh:// value gh resolves to chroxy
check "#7991 [ssh-malformed-killer] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --repo ssh://git@github.com/blamechris/chroxy")" "0")"

# --- Case 81 — #7991 [www-malformed-killer]: MUTATION KILLER for dropping the NAME/NAME fullmatch: a www host gh resolves to chroxy
check "#7991 [www-malformed-killer] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --repo www.github.com/blamechris/chroxy")" "0")"

# --- Case 82 — #7991 [dollar-paren-killer]: MUTATION KILLER (K1, restated standalone): $(...) glued to the repo value, no --squash
# shellcheck disable=SC2016 # single-quoted on purpose: $(true) must reach the
# hook as literal text, not be executed by this test script's own shell.
check "#7991 [dollar-paren-killer] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash 'gh pr merge 7990 --repo blamechris/chroxy$(true) --squash')" "0")"

# --- Case 83 — #7991 [auto-falls-through]: gh pr merge --auto is dropped from the boolean-flag allowlist on purpose (repo policy: never auto-merge) and falls through; it has no 3-5 digit number, so the existing gate blocks it
check "#7991 [auto-falls-through] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 8 --repo blamechris/github-runners --auto")" "0")"

# --- Case 84 — #7991 [selector-mutation-killer]: MUTATION KILLER for 'accept any word as a selector': a branch name is not a valid PR-number selector
check "#7991 [selector-mutation-killer] — is still BLOCKED (exit 2)" \
  2 "$(run_hook_stdin "$(build_payload Bash "gh pr merge feat/x --repo blamechris/github-runners --squash")" "0")"

# --- Case 85 — #7991 [A1]: the long --repo form
check "#7991 [A1] — is ALLOWED (exit 0)" \
  0 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 8 --repo blamechris/github-runners --squash --delete-branch")" "0")"

# --- Case 86 — #7991 [A2]: the short -R (spaced) form
check "#7991 [A2] — is ALLOWED (exit 0)" \
  0 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 8 -R blamechris/github-runners --squash")" "0")"

# --- Case 87 — #7991 [A3]: the --repo= form, flag before the number
check "#7991 [A3] — is ALLOWED (exit 0)" \
  0 "$(run_hook_stdin "$(build_payload Bash "gh pr merge --repo=blamechris/github-runners 8 --squash")" "0")"

# --- Case 88 — #7991 [chroxy-other]: a genuinely different repo, not a substring/prefix match — MUTATION KILLER for '==' -> 'startswith' on the chroxy comparison
check "#7991 [chroxy-other] — is ALLOWED (exit 0)" \
  0 "$(run_hook_stdin "$(build_payload Bash "gh pr merge 7990 --repo blamechris/chroxy-other")" "0")"

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
