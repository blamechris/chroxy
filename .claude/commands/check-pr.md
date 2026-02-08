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

### 3. Process EVERY Unreplied Comment — ONE AT A TIME

For each review comment (Copilot or human) that has NOT been replied to, you MUST do ALL of these steps **before moving to the next comment**:

1. Read the comment carefully
2. Evaluate if it's actionable
3. Take action (fix code, or create issue)
4. **Post the inline reply via `gh api ... /replies` IMMEDIATELY** — do NOT batch replies

**CRITICAL: The inline reply (`gh api ... /comments/${COMMENT_ID}/replies`) is the PRIMARY output of this skill.** The summary comment is secondary. If you only post a summary without inline replies, the skill has FAILED — conversation threads will remain unresolved and block merging.

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

### 5. Verify All Inline Replies Were Posted

**This step is MANDATORY. Do NOT skip it.**

```bash
# Count root comments (not replies) from reviewers
ROOT_COUNT=$(gh api repos/${REPO}/pulls/${PR_NUM}/comments \
  --jq '[.[] | select(.in_reply_to_id == null)] | length')

# Count unique root comments that have at least one reply
REPLIED_COUNT=$(gh api repos/${REPO}/pulls/${PR_NUM}/comments \
  --jq '[.[] | select(.in_reply_to_id != null) | .in_reply_to_id] | unique | length')

echo "Root comments: ${ROOT_COUNT}, Replied: ${REPLIED_COUNT}"
```

If `REPLIED_COUNT < ROOT_COUNT`, you have UNREPLIED comments. Go back to step 3 and post the missing inline replies BEFORE proceeding. **Do NOT post the summary comment until every thread has a reply.**

### 6. Post Summary Comment

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

### 7. Report to User

Output a final summary:
- Total comments processed
- Fixes committed (with full commit hashes)
- False positives dismissed (with reasons)
- Follow-up issues created (with URLs)
- PR ready for re-review: Yes/No

## Critical Rules

1. **EVERY comment gets an INLINE reply** — No silent dismissals. The `gh api .../replies` call is the MOST IMPORTANT output. A summary comment WITHOUT inline replies is a FAILURE.
2. **Reply IMMEDIATELY after each comment** — Process one comment at a time: read → fix/defer → post inline reply → next. Do NOT batch all fixes and try to reply later.
3. **Verify before summarizing** — Run the verification step (step 5) and confirm all threads have replies BEFORE posting the summary comment. If any are missing, go back and post them.
4. **Fix first, defer second** — Default is to fix the issue
5. **Be specific** — ALWAYS show before/after code diffs in fix replies
6. **Link commits** — EVERY fix reply MUST include its commit hash
7. **ALWAYS create issues for deferred items** — NEVER say "good idea" without a GitHub issue URL. If it's valid and you're not fixing it now, create the issue. No exceptions.
8. **No attribution** — Follow Zero Attribution Policy (no Co-Authored-By, no "Generated with Claude", no AI mentions anywhere)
9. **No editing comments** — Reply inline to comments, never edit them
10. **Idempotent** — Skip comments that already have replies (check in_reply_to_id)
