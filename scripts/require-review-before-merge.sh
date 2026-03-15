#!/bin/bash
#
# Claude Code PreToolUse hook: blocks merges unless /full-review was run.
#
# Catches BOTH direct `gh pr merge` calls AND Python/shell scripts that
# contain `gh pr merge` in their body (batch merge scripts, heredocs, etc).
#
# Exits 2 (BLOCK) if any referenced PR lacks a review comment.
#
set -euo pipefail

# Only check Bash tool calls
if [ "${TOOL_NAME:-}" != "Bash" ]; then
  exit 0
fi

# Extract the command from the tool input JSON
COMMAND=$(echo "$TOOL_INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('command',''))" 2>/dev/null || echo "")

# Check if the command contains `gh pr merge` ANYWHERE — catches:
#   - Direct: gh pr merge 2286 --squash
#   - Python subprocess: subprocess.run(['gh', 'pr', 'merge', ...])
#   - Shell heredoc: run(f"gh pr merge {pr} --squash")
#   - Quoted: 'gh pr merge'
if ! echo "$COMMAND" | grep -q 'pr merge'; then
  exit 0
fi

# Extract ALL numbers that look like PR numbers (3-5 digits) from the entire command
PR_NUMS=$(echo "$COMMAND" | grep -oE '\b[0-9]{3,5}\b' | sort -u || true)

if [ -z "$PR_NUMS" ]; then
  # Command mentions pr merge but no PR numbers found — could be a variable.
  # Block conservatively with a helpful message.
  echo "BLOCKED: Detected 'pr merge' but could not extract PR numbers."
  echo "Run /full-review on all PRs before merging."
  exit 2
fi

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "")
if [ -z "$REPO" ]; then
  exit 0
fi

MISSING_REVIEW=()
for PR_NUM in $PR_NUMS; do
  # Skip numbers that aren't open PRs
  STATE=$(gh pr view "$PR_NUM" --json state -q .state 2>/dev/null || echo "NOT_FOUND")
  if [ "$STATE" != "OPEN" ]; then
    continue
  fi

  # Check for review comments (agent-review posts structured review comments)
  REVIEW_COUNT=$(gh api "repos/${REPO}/issues/${PR_NUM}/comments" --paginate -q \
    '[.[] | select(.body | test("Code Review|Review Comments Addressed|LGTM|Approve|Verdict"))] | length' 2>/dev/null || echo "0")

  if [ "$REVIEW_COUNT" = "0" ]; then
    MISSING_REVIEW+=("$PR_NUM")
  fi
done

if [ ${#MISSING_REVIEW[@]} -gt 0 ]; then
  echo "BLOCKED: The following PRs have no review comment:"
  for PR in "${MISSING_REVIEW[@]}"; do
    echo "  - PR #${PR} — run: /full-review ${PR}"
  done
  echo ""
  echo "Every PR must have /full-review run before merging."
  echo "This is a hard gate enforced by scripts/require-review-before-merge.sh"
  exit 2
fi

exit 0
