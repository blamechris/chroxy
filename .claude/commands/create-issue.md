# /create-issue

Create a standardized GitHub issue with labels and traceability.

## Arguments

- `$ARGUMENTS` - Issue title (required). Optionally followed by flags:
  - `--from-pr N` — Link to source PR
  - `--comment-url URL` — Link to specific review comment
  - `--complexity low|medium|high` — Set complexity label
  - `--label NAME` — Additional label (repeatable)

## Instructions

### 1. Parse Arguments and Gather Context

Extract the title and any flags from `$ARGUMENTS`. Determine context:

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# Check if we're on a PR branch (auto-detect source PR)
CURRENT_PR=$(gh pr view --json number -q .number 2>/dev/null || echo "")
```

If `--from-pr` was not specified but we're on a PR branch, use the current PR as the source.

### 2. Check for Duplicates

Before creating, scan for existing issues with similar titles:

```bash
# Search open issues for potential duplicates
gh issue list --state open --search "${ISSUE_TITLE}" --json number,title --limit 5
```

If a close match exists, show it to the user and ask whether to proceed or reference the existing issue instead.

### 3. Build Issue Body

Construct the issue body based on available context.

#### From-Review Issue (has source PR or comment URL)

```markdown
## Context

Found during review of PR #${SOURCE_PR}.

{{If comment URL provided:}}
**Review comment:** ${COMMENT_URL}

{{If file/line can be extracted from comment:}}
**Location:** \`${FILE_PATH}:${LINE_NUMBER}\`

## Description

What needs to be done and why. Be specific — another developer should be able to pick this up without reading the original review thread.

## Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2
```

#### Standalone Issue (no review context)

```markdown
## Description

What needs to be done and why.

## Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2
```

### 4. Determine Labels

Build the label set:

```bash
LABELS="enhancement"

# Always add from-review if this came from a PR review
if [ -n "$SOURCE_PR" ] || [ -n "$COMMENT_URL" ]; then
  LABELS="$LABELS,from-review"
fi

# Add any extra --label flags
for extra in "${EXTRA_LABELS[@]}"; do
  LABELS="$LABELS,$extra"
done
```

**Verify labels exist** before using them. If a label doesn't exist in the repo, skip it rather than failing:

```bash
# Check if label exists
gh label list --json name -q '.[].name' | grep -q "^from-review$" || echo "Warning: 'from-review' label not found in repo"
```

### 5. Create the Issue

```bash
ISSUE_URL=$(gh issue create \
  --title "${ISSUE_TITLE}" \
  --label "${LABELS}" \
  --body "$(cat <<'EOF'
${ISSUE_BODY}
EOF
)")
```

### 6. Extract Issue Number

```bash
ISSUE_NUM=$(echo "$ISSUE_URL" | grep -oE '[0-9]+$')
```

### 7. Report to User

Output a **summary table** — this is the PRIMARY output:

```markdown
| Issue | Title | Labels | Source |
|-------|-------|--------|--------|
| #${ISSUE_NUM} | ${ISSUE_TITLE} | from-review, complexity:low | PR #${SOURCE_PR} |
```

Then below the table:
- Issue URL (clickable)
- Labels applied
- Source PR link (if applicable)
- Review comment link (if applicable)

## Critical Rules

1. **NO attribution** — Follow Zero Attribution Policy.
2. **Check for duplicates** — Always search before creating. Don't create duplicate issues.
3. **Labels must exist** — Verify labels exist in the repo. Skip missing labels gracefully.
4. **Be specific** — The issue description must be self-contained. Another developer should understand it without reading the review thread.
5. **Always include acceptance criteria** — Even if just one checkbox. Issues without criteria are hard to close confidently.
6. **Link to source** — If from a review, always include the PR number and comment URL in the body.
