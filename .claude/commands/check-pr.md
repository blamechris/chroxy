# /check-pr

Address all PR review comments systematically and respond inline.

## Arguments

- `$ARGUMENTS` - PR number (optional, defaults to current branch's PR)

## Instructions

### 1. Fetch PR Info

```bash
# Get PR number for current branch (or use provided arg)
PR_NUM=${1:-$(gh pr view --json number -q .number)}

# Get repo info
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# Fetch all review comments (inline)
gh api repos/${REPO}/pulls/${PR_NUM}/comments

# Fetch all reviews
gh api repos/${REPO}/pulls/${PR_NUM}/reviews
```

### 2. Skip Already-Replied Comments

Before processing, check which comments already have replies:

```bash
# Get IDs of comments that are replies (in_reply_to_id is set)
gh api repos/${REPO}/pulls/${PR_NUM}/comments --jq '[.[] | select(.in_reply_to_id != null) | .in_reply_to_id] | unique'
```

Only process root comments (where `in_reply_to_id` is null) that do NOT appear in the replied-to list. This prevents duplicate work when re-running `/check-pr`.

### 3. Process EVERY Unreplied Comment

For each review comment (Copilot or human) that has NOT been replied to, you MUST:

1. Read the comment carefully
2. Evaluate if it's actionable
3. Take action AND post a reply

**Default stance: FIX IT NOW** - Only defer if the suggestion is a false positive or requires scope expansion (tracked via follow-up issue).

**CRITICAL: There are ONLY THREE valid outcomes for each comment. Every comment MUST result in one of these:**

1. **FIX** — Make the code change, commit, reply with commit hash + before/after code
2. **FALSE POSITIVE** — Reply explaining why the suggestion is incorrect, with evidence
3. **FOLLOW-UP ISSUE** — Create a GitHub issue, reply with the issue URL

**There is NO "acknowledge and move on" option.** If a suggestion is valid but out of scope, you MUST create a follow-up issue. Never reply with "good idea, maybe later" without an issue link.

#### Outcome 1: FIX IMMEDIATELY (default)

1. Make the code fix
2. Commit with descriptive message (NO attribution — no Co-Authored-By, no "Generated with", no AI mentions)
3. Reply inline with the EXACT format below — commit hash AND code diff are MANDATORY:

```bash
gh api repos/${REPO}/pulls/${PR_NUM}/comments/${COMMENT_ID}/replies \
  --method POST \
  -f body="**FIX**

Fixed in \`${COMMIT_SHA}\`

**Change:** Brief description of fix

\`\`\`diff
- old_code_line
+ new_code_line
\`\`\`"
```

**NEVER post a fix reply without the commit SHA and a code diff.** If you fixed it, prove it.

#### Outcome 2: FALSE POSITIVE

Only use this if the suggestion is factually incorrect. Reply inline:

```bash
gh api repos/${REPO}/pulls/${PR_NUM}/comments/${COMMENT_ID}/replies \
  --method POST \
  -f body="**FALSE POSITIVE**

**Reason:** Clear explanation of why this is correct

**Evidence:**
- Reference to docs/pattern used (e.g., 'per CLAUDE.md: no semicolons')
- Link to similar code in codebase"
```

#### Outcome 3: FOLLOW-UP ISSUE (for valid but out-of-scope suggestions)

**ALWAYS create an issue. NEVER just say "good idea" without tracking it.**

This applies when:
- The suggestion is valid but would expand the PR's scope
- The suggestion is an enhancement/improvement beyond the PR's intent
- The suggestion requires changes in other files not touched by this PR
- The fix is non-trivial and deserves its own PR

```bash
# 1. ALWAYS create the issue — this is NOT optional
ISSUE_URL=$(gh issue create \
  --title "Short descriptive title" \
  --label "enhancement" \
  --label "from-review" \
  --body "$(cat <<'EOF'
## Context

Identified during review of PR #${PR_NUM}.

## Description

What needs to be done and why.

## Original Comment

> Quote the review comment here verbatim

## Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2
EOF
)")

# 2. Reply inline referencing the issue — MUST include the issue URL
gh api repos/${REPO}/pulls/${PR_NUM}/comments/${COMMENT_ID}/replies \
  --method POST \
  -f body="**FOLLOW-UP ISSUE**

Created ${ISSUE_URL} to track this.

**Reason for deferral:** Brief explanation why not in this PR"
```

### 4. Push All Fixes

```bash
git push
```

### 5. Post Summary Comment

After addressing ALL comments, post a summary on the PR. Every row MUST have a commit hash, issue URL, or brief justification in the Commit/Issue column.

```bash
gh pr comment ${PR_NUM} --body "$(cat <<'EOF'
## Review Comments Addressed

| Comment | Action | Commit/Issue |
|---------|--------|--------------|
| Brief description | Fixed | `abc1234` |
| Brief description | False positive | N/A — reason |
| Brief description | Follow-up | #123 |

**Total:** X comments addressed
- Fixed: Y
- False positives: Z
- Follow-up issues created: W
EOF
)"
```

### 6. Report to User

Output a final summary:
- Total comments processed
- Fixes committed (with full commit hashes)
- False positives dismissed (with reasons)
- Follow-up issues created (with URLs)
- PR ready for re-review: Yes/No

## Critical Rules

1. **EVERY comment gets a reply** — No silent dismissals
2. **Fix first, defer second** — Default is to fix the issue
3. **Be specific** — ALWAYS show before/after code diffs in fix replies
4. **Link commits** — EVERY fix reply MUST include its commit hash
5. **ALWAYS create issues for deferred items** — NEVER say "good idea" without a GitHub issue URL. If it's valid and you're not fixing it now, create the issue. No exceptions.
6. **No attribution** — Follow Zero Attribution Policy (no Co-Authored-By, no "Generated with Claude", no AI mentions anywhere)
7. **No editing comments** — Reply inline to comments, never edit them
8. **Idempotent** — Skip comments that already have replies (check in_reply_to_id)
