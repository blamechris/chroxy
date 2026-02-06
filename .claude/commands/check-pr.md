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

# Fetch all review comments
gh api repos/${REPO}/pulls/${PR_NUM}/comments
gh api repos/${REPO}/pulls/${PR_NUM}/reviews
```

### 2. Process EVERY Comment

For each review comment (Copilot or human), you MUST:

1. Read the comment carefully
2. Evaluate if it's actionable
3. Take action AND post a reply

**Default stance: FIX IT NOW** - Only defer if truly a false positive.

#### If Valid Issue -> FIX IMMEDIATELY

1. Make the code fix
2. Commit with descriptive message
3. Reply inline on the PR comment:

```bash
gh api repos/${REPO}/pulls/${PR_NUM}/comments/${COMMENT_ID}/replies \
  --method POST \
  -f body="Fixed in \`${COMMIT_SHA}\`

**Change:** Brief description of fix

\`\`\`javascript
// Before
old_code_snippet

// After
new_code_snippet
\`\`\`"
```

#### If False Positive -> EXPLAIN WHY

Only use this if the suggestion is incorrect. Reply inline:

```bash
gh api repos/${REPO}/pulls/${PR_NUM}/comments/${COMMENT_ID}/replies \
  --method POST \
  -f body="**Not an issue**

**Reason:** Clear explanation of why this is correct

**Evidence:**
- Reference to docs/pattern used
- Link to similar code in codebase"
```

#### If Intentional Design -> DOCUMENT

Reply inline with rationale:

```bash
gh api repos/${REPO}/pulls/${PR_NUM}/comments/${COMMENT_ID}/replies \
  --method POST \
  -f body="**Intentional design decision**

**Rationale:** Why this approach was chosen

**Trade-offs considered:**
- Alternative A: why not
- Alternative B: why not
- Current approach: why yes"
```

#### If Valid But Out of Scope -> CREATE FOLLOW-UP ISSUE

When a suggestion is valid but would expand scope, create a tracked issue:

```bash
# 1. Create the issue with labels
ISSUE_URL=$(gh issue create \
  --title "Short descriptive title" \
  --label "enhancement" \
  --label "from-review" \
  --body "$(cat <<'EOF'
## Context

This was identified during review of PR #${PR_NUM}.

## Description

What needs to be done and why.

## Original Comment

> Quote the review comment here

## Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2
EOF
)"

# 2. Reply inline referencing the issue
gh api repos/${REPO}/pulls/${PR_NUM}/comments/${COMMENT_ID}/replies \
  --method POST \
  -f body="**Acknowledged - tracked for follow-up**

Valid suggestion. Created ${ISSUE_URL} to track this work.

**Reason for deferral:** Brief explanation why not in this PR"
```

### 3. Push All Fixes

```bash
git push
```

### 4. Post Summary Comment

After addressing all comments, post a summary on the PR using heredoc:

```bash
gh pr comment ${PR_NUM} --body "$(cat <<'EOF'
## Review Comments Addressed

| Comment | Action | Commit/Issue |
|---------|--------|--------------|
| Comment 1 summary | Fixed | `abc123` |
| Comment 2 summary | False positive | N/A |
| Comment 3 summary | Follow-up | #456 |

**Total:** X comments addressed
- Fixed: Y
- False positives: Z
- Design decisions: W
- Follow-up issues: V
EOF
)"
```

### 5. Report to User

Output:
- Total comments processed
- Fixes committed (with hashes)
- Items dismissed (with reasons)
- Follow-up issues created (with URLs)
- PR ready for re-review: Yes/No

## Critical Rules

1. **EVERY comment gets a reply** - No silent dismissals
2. **Fix first, defer second** - Default is to fix the issue
3. **Be specific** - Show before/after code in replies
4. **Link commits** - Every fix references its commit hash
5. **No attribution** - Follow Zero Attribution Policy
