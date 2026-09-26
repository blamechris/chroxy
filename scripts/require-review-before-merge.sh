#!/bin/bash
#
# Claude Code PreToolUse hook: blocks merges unless /full-review was run.
#
# Catches BOTH direct `gh pr merge` calls AND Python/shell scripts that
# contain `gh pr merge` in their body (batch merge scripts, heredocs, etc).
#
# Exits 2 (BLOCK) if any referenced PR lacks a review comment, or whenever
# this script cannot establish that one exists (malformed input, a `gh`
# failure) — see the fail-closed notes inline. Per Claude Code's PreToolUse
# hook contract (code.claude.com/docs/en/hooks-guide): exit 2 blocks the
# tool call, and the reason must be written to STDERR — it is fed back to
# Claude as the block reason; stdout is not read for this purpose (only
# shown in transcript mode). Every block message below therefore goes to
# `>&2`, not plain `echo`.
#
# WHAT THIS IS, AND WHAT IT IS NOT (#7922, owner decision 2026-09-26)
# ------------------------------------------------------------------
# The POLICY is absolute: no PR merges without /full-review. This script's
# ENFORCEMENT of it is a speed bump. It stops an agent from merging an
# unreviewed PR by accident. It is NOT a security boundary, because it
# matches text in a shell command, and predicting what a shell command will
# do from its text is unwinnable (#7341, docs/false-safety-guards.md).
#
# The backstop is GitHub, which checks the merge itself rather than the
# command that asked for it. Verified 2026-09-26 against the live settings:
#   - branch protection on main: `enforce_admins` on (it binds the owner's
#     token too), required conversation resolution, 16 required status
#     checks;
#   - the "Copilot review for default branch" ruleset: active, no bypass
#     actors, requires a Copilot code review.
# Know what that backstop does NOT give you: it requires ZERO approving
# reviews and never looks for the agent-review comment. A PR that slips past
# this hook still cannot merge with red CI or open threads, but it CAN merge
# without /full-review. Keeping that from happening is this script's job.
#
# Known evasions (1-3 measured against this script, each exits 0 = allowed;
# 4 follows from how the hook is wired):
#   1. Backslash-newline continuation: `gh pr \`, newline, `merge 123`.
#      grep matches one line at a time, so the words never meet.
#   2. A command built at run time: `a=pr; b=merge; gh $a $b 123`, or
#      `eval "gh pr $(echo merge) 123"`. The words never appear side by side.
#   3. A GraphQL query read from a file (`gh api graphql -F query=@m.graphql`).
#      The mutation name is not in the command text.
#   4. Any merge that does not go through the Bash tool: an MCP server's
#      merge tool, a browser, the GitHub app. The hook's matcher in
#      .claude/settings.json is `Bash`.
# Each of these takes a deliberate detour, and only the backstop above
# stands in the way of one.
#
# Known conservative blocks (fail closed; exit 2 even when nothing is wrong):
#   - A merge whose PR number is not 3-5 digits (`gh pr merge 42`,
#     `gh pr merge 123456`) or is not in the command at all (`gh pr merge
#     feat/x`). Widen the extractor below before this repo passes PR #99999.
#   - Every GraphQL merge mutation, reviewed or not (see the #7922 note at
#     the match below).
#   - PROSE. A heredoc, `echo` or `-m` message that only MENTIONS the merge
#     command, next to the number of an open PR that has no review comment,
#     is blocked like a real merge. Example: a handoff note saying the gate
#     "blocks `gh pr merge` without review" and citing an open PR. Prose
#     that names a GraphQL merge mutation is blocked whatever numbers it
#     cites. Workaround: write such text with a file tool (Write/Edit),
#     which this hook never sees, then pass the file (`git commit -F`,
#     `gh pr create --body-file`).
#
# One more limit: "reviewed" means that some issue comment on the PR matches
# the keyword test further down (Code Review|...|Approve|Verdict). That is
# evidence that /full-review ran, not proof of it.
#
# #7914: Claude Code delivers PreToolUse hook input as JSON on STDIN —
#   {"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"..."},...}
# — never as TOOL_NAME/TOOL_INPUT environment variables. This script used to
# read only the env vars, so TOOL_NAME was always empty on every real
# invocation and the gate exited 0 (allow) before checking anything — the
# hard gate had never fired. packages/server/hooks/permission-hook.sh reads
# its payload the same way (`REQUEST=$(cat -)`), confirming stdin is the
# real delivery mechanism.
#
set -uo pipefail

# Fail-closed safety net: if ANYTHING below fails in a way this script did
# not anticipate (a missing python3, an unhandled nonzero exit from a
# command not already wrapped in an `if`/`||`), catch it here and exit 2
# explicitly rather than let bash's default failure code (often 1, or
# whatever the failing command itself returned) escape uncontrolled. Only
# exit 0 and exit 2 are documented PreToolUse outcomes (allow / block); an
# uncontrolled exit code is not "block", so a bug in this script must not
# silently open the merge gate. Verified empirically (bash 3.2 and modern
# bash): this trap fires for a failing command substitution at the top
# level without needing `set -E`, and does NOT fire for a command already
# guarded by `if`/`!`/`||`, so normal control flow below is unaffected.
trap 'echo "BLOCKED: require-review-before-merge.sh hit an internal error — failing closed. Run /full-review manually and confirm the review comment exists before merging." >&2; exit 2' ERR
set -e

# Read the PreToolUse payload from stdin — the shape Claude Code actually
# sends (#7914). Guard against a TTY / no-stdin invocation: `cat` on an
# interactive stdin would hang waiting for input that will never arrive, so
# only read when stdin is NOT a terminal.
INPUT=""
if [ ! -t 0 ]; then
  INPUT="$(cat)"
fi

if [ -n "$INPUT" ]; then
  # Parse fully in python3 (already a dependency — see the REVIEW_COUNT
  # extraction below) so bash never hand-parses JSON. The python3 process
  # always exits 0 itself and reports outcomes via a STATUS token, so a
  # malformed payload is handled explicitly below rather than surfacing as
  # an uncontrolled bash-level command failure.
  #
  # Two python3 calls, not one, to sidestep a real trap: command
  # substitution strips ALL trailing newlines from a process's output, so a
  # single call emitting "STATUS\nTOOL_NAME\nCOMMAND" corrupts the split
  # whenever COMMAND is the empty string (its would-be trailing newline
  # vanishes and a naive split then duplicates TOOL_NAME into COMMAND —
  # verified empirically while writing this). Call 1 emits exactly the two
  # fields that are safe to newline-split (STATUS, then TOOL_NAME as the
  # LAST field — an empty last field from `sed -n '2p'` on a single-line
  # result correctly reads back as "", no merge-into-previous-field
  # possible). Call 2, run only once we know we need COMMAND at all, emits
  # nothing but the raw command text, matching the pre-#7914 script's own
  # single-field extraction — with only one field in the output there is no
  # boundary left for a stripped trailing newline to corrupt.
  STATUS_AND_NAME=$(printf '%s' "$INPUT" | python3 -c '
import sys, json

try:
    payload = json.loads(sys.stdin.read())
except Exception:
    payload = None

if not isinstance(payload, dict):
    print("PARSE_ERROR")
    print("")
    sys.exit(0)

tool_name = payload.get("tool_name")
if not isinstance(tool_name, str):
    tool_name = ""
tool_input = payload.get("tool_input")
if not isinstance(tool_input, dict):
    tool_input = {}
has_command = isinstance(tool_input.get("command"), str)
status = "NO_COMMAND" if (not has_command and tool_name == "Bash") else "OK"

print(status)
print(tool_name)
')
  PARSE_STATUS=$(printf '%s\n' "$STATUS_AND_NAME" | sed -n '1p')
  TOOL_NAME=$(printf '%s\n' "$STATUS_AND_NAME" | sed -n '2p')

  case "$PARSE_STATUS" in
    PARSE_ERROR)
      echo "BLOCKED: could not parse the PreToolUse hook payload from stdin as JSON." >&2
      echo "Failing closed rather than allow a command through unchecked." >&2
      exit 2
      ;;
    NO_COMMAND)
      echo "BLOCKED: a Bash tool_input with no 'command' field — cannot verify it isn't a merge." >&2
      echo "Failing closed rather than allow a command through unchecked." >&2
      exit 2
      ;;
  esac

  COMMAND=""
  if [ "$TOOL_NAME" = "Bash" ]; then
    COMMAND=$(printf '%s' "$INPUT" | python3 -c "
import sys, json
payload = json.loads(sys.stdin.read())
tool_input = payload.get('tool_input', {})
if not isinstance(tool_input, dict):
    tool_input = {}
command = tool_input.get('command', '')
sys.stdout.write(command if isinstance(command, str) else '')
")
  fi
else
  # Documented fallback — NOT the shape Claude Code sends (#7914). Kept only
  # in case some other caller invokes this script with TOOL_NAME/TOOL_INPUT
  # set instead of piping JSON on stdin.
  TOOL_NAME="${TOOL_NAME:-}"
  COMMAND=""
  if [ "$TOOL_NAME" = "Bash" ]; then
    COMMAND=$(printf '%s' "${TOOL_INPUT:-}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('command',''))" 2>/dev/null || echo "")
  fi
fi

# Only check Bash tool calls.
if [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

# #7922: `mergePullRequest` and `enablePullRequestAutoMerge` are the GraphQL
# form of the same two operations (`gh api graphql -f query='mutation {
# mergePullRequest(...) }'`), measured as a silent bypass before this block.
# It is not disguised, just another API, so it is closed rather than listed
# as a known evasion. GraphQL names cannot contain escapes and an alias does
# not remove the field name, so the literal is in any inline query.
#
# Blocked OUTRIGHT, before the PR-number check below and independently of
# it: these mutations name the PR by node id, so the number check would
# never see the PR being merged. ANY other 3-5 digit number in the same
# command (`| head -100`, a port, a reviewed PR merged alongside with
# `gh pr merge`) would be checked in its place and let the merge through.
if grep -qE 'mergePullRequest|enablePullRequestAutoMerge' <<<"$COMMAND"; then
  echo "BLOCKED: a GraphQL merge mutation (mergePullRequest / enablePullRequestAutoMerge)." >&2
  echo "It names the PR by node id, which this gate cannot check for a review." >&2
  echo "Run /full-review, then merge with 'gh pr merge <number>'." >&2
  exit 2
fi

# Does the command contain `gh pr merge` ANYWHERE, or the equivalent GitHub
# REST call (`gh api ... pulls/<n>/merge`, the same operation `gh pr merge`
# performs under the hood)? A here-string, not a pipe from echo/printf/cat —
# #7907: a producer piped into an early-exiting `grep -q` can get SIGPIPE'd
# under `pipefail`, which flips a genuine match into "not found" and skips
# the whole gate. A here-string has no separate producer process for grep to
# SIGPIPE.
#
# #7921 bypass hunting:
#   - `pr[[:blank:]]+merge` (not a literal 'pr merge') so repeated spaces or
#     a tab between the words — `gh  pr   merge`, `gh pr<TAB>merge` — still
#     match. [[:blank:]] (space/tab only, not newline) keeps this to the
#     same physical line the #7907 large-command case already relies on;
#     grep matches per line by default regardless, so widening to
#     [[:space:]] would not additionally catch a `pr merge` split across a
#     backslash-newline continuation anyway — that shape is recorded as a
#     FOLLOW-UP, not fixed here (matches this repo's own precedent that
#     predicting arbitrary shell composition against a substring/regex match
#     is unwinnable; see docs/false-safety-guards.md and #7341). #7922
#     decided to leave it open; see "Known evasions" in the header.
#   - `pulls/[0-9]+/merge` catches `gh api -X PUT repos/OWNER/REPO/pulls/N/merge`
#     — the direct REST call that merges a PR without ever containing the
#     text "pr merge" — verified as a silent bypass of the pre-fix pattern.
if ! grep -qE 'pr[[:blank:]]+merge|pulls/[0-9]+/merge' <<<"$COMMAND"; then
  exit 0
fi

# Extract ALL numbers that look like PR numbers (3-5 digits) from the entire
# command.
PR_NUMS=$(echo "$COMMAND" | grep -oE '\b[0-9]{3,5}\b' | sort -u || true)

if [ -z "$PR_NUMS" ]; then
  # Command mentions pr merge but no PR numbers found — could be a variable.
  # Block conservatively with a helpful message.
  echo "BLOCKED: Detected 'pr merge' but could not extract PR numbers." >&2
  echo "Run /full-review on all PRs before merging." >&2
  exit 2
fi

if ! REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>&1); then
  echo "BLOCKED: could not determine the current repo — 'gh repo view' failed:" >&2
  echo "  ${REPO}" >&2
  echo "Failing closed — a gate that opens when GitHub is unreachable is not a gate." >&2
  exit 2
fi

MISSING_REVIEW=()
for PR_NUM in $PR_NUMS; do
  # Skip numbers that aren't open PRs. Distinguish "gh told us this number
  # is not a PR" (a port, a line count, a timeout — not a gh failure, so it
  # is safe to skip) from a genuine gh failure (network/auth/rate-limit),
  # which must fail closed rather than be treated as "not a PR".
  if ! PR_STATE=$(gh pr view "$PR_NUM" --json state -q .state 2>&1); then
    case "$PR_STATE" in
      *"Could not resolve to a PullRequest"*|*"no pull requests found"*)
        continue
        ;;
      *)
        echo "BLOCKED: could not verify PR #${PR_NUM} — 'gh pr view' failed:" >&2
        echo "  ${PR_STATE}" >&2
        echo "Failing closed — a gate that opens when GitHub is unreachable is not a gate." >&2
        exit 2
        ;;
    esac
  fi
  if [ "$PR_STATE" != "OPEN" ]; then
    continue
  fi

  # Check for review comments (agent-review posts structured review comments)
  if ! REVIEW_COUNT=$(gh api "repos/${REPO}/issues/${PR_NUM}/comments" --paginate -q \
    '[.[] | select(.body | test("Code Review|Review Comments Addressed|LGTM|Approve|Verdict"))] | length' 2>&1); then
    echo "BLOCKED: could not read review comments for PR #${PR_NUM} — 'gh api' failed:" >&2
    echo "  ${REVIEW_COUNT}" >&2
    echo "Failing closed — a gate that opens when GitHub is unreachable is not a gate." >&2
    exit 2
  fi

  if [ "$REVIEW_COUNT" = "0" ]; then
    MISSING_REVIEW+=("$PR_NUM")
  fi
done

if [ ${#MISSING_REVIEW[@]} -gt 0 ]; then
  echo "BLOCKED: The following PRs have no review comment:" >&2
  for PR in "${MISSING_REVIEW[@]}"; do
    echo "  - PR #${PR} — run: /full-review ${PR}" >&2
  done
  echo "" >&2
  echo "Every PR must have /full-review run before merging." >&2
  echo "This is a hard gate enforced by scripts/require-review-before-merge.sh" >&2
  exit 2
fi

exit 0
