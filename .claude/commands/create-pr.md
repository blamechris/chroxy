# /create-pr

Create a pull request with auto-detected issue closures and proper formatting.

## Arguments

- `$ARGUMENTS` - Optional: PR title override, or "batch" to use batch-fix template

## Instructions

### 1. Verify Branch State

```bash
BRANCH=$(git branch --show-current)
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# Ensure we're not on main
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  echo "ERROR: Cannot create PR from main branch. Create a feature branch first."
  exit 1
fi

git status
git log main..HEAD --oneline
git diff main --stat
git diff main
```

Review the commits and full diff. Understand the full scope of work before drafting the PR.

### 2. Detect Closable Issues

Scan for issues this PR should close. Check THREE sources:

```bash
# Source 1: Issue numbers referenced in commit messages (#NNN)
git log main..HEAD --format='%s %b' | grep -oE '#[0-9]+' | sort -u

# Source 2: Issue numbers in branch name (e.g., fix/auth-rate-limit-434 → #434)
echo "$BRANCH" | grep -oE '[0-9]+' | while read num; do
  # Verify it's a real open issue
  gh issue view "$num" --json state,title -q 'select(.state == "OPEN") | "#\(.number // empty): \(.title // empty)"' 2>/dev/null
done

# Source 3: Open from-review issues whose title/body matches changed files
gh issue list --label "from-review" --label "enhancement" --state open --json number,title,body --limit 50
```

Cross-reference the from-review issues against the files changed in this branch (`git diff main --name-only`) to find matches. Only include issues whose description relates to files actually modified in this PR.

**For each candidate issue:** Verify it's open and the PR's changes actually address it. Don't claim to close an issue the commits don't fix.

Build the `CLOSES_LINES` list — one `Closes #N` per confirmed issue:
```
Closes #434
Closes #447
```

If branch has commit messages referencing issues (`#NNN`) but NONE of those issues appear closable, **warn the user**: "Commits reference #X but the issue is already closed / not found. Proceeding without Closes tags."

### 3. Draft PR Content

Based on the commits, changed files, and detected issues, draft the PR.

**If `$ARGUMENTS` contains "batch" OR the PR closes 3+ issues, use Batch Fix template. Otherwise use Default template.**

#### Default Template

```markdown
## Summary

- Change 1
- Change 2
- Change 3

${CLOSES_LINES}

## Test Plan

- [ ] Server tests pass
- [ ] App type-checks clean
- [ ] Manual smoke test
```

#### Batch Fix Template

When closing multiple issues in one PR (common for from-review batches):

```markdown
## Summary

Brief overview of the batch.

| Issue | What changed | Files |
|-------|-------------|-------|
| #434 | Added auth rate limiting | `ws-server.js` |
| #447 | Added deploy rollback tests | `supervisor.test.js` |
| #433 | Auto mode confirmation handshake | `ws-server.js`, `connection.ts`, `SettingsBar.tsx` |

${CLOSES_LINES}

## Test Plan

- [ ] Server tests pass
- [ ] App type-checks clean
- [ ] Manual smoke test
```

**PR Title:** Keep under 70 characters. Use conventional commit format: `type(scope): summary`

For batch-fix PRs: `fix: batch from-review fixes (#N, #M, #P)` or similar.

### 4. Confirm With User

Before creating the PR, show the user:

1. **Title** (proposed)
2. **Body** (proposed, including Closes tags)
3. **Issues to close** (list with titles)
4. **Branch** and **base** (main)

Ask: "Ready to create this PR?" — wait for confirmation.

**CRITICAL: Do NOT auto-create the PR without user confirmation.** The user may want to adjust the title, add context, or remove a Closes tag.

### 5. Push and Create PR

```bash
# Push branch
git push -u origin ${BRANCH}

# Create PR with heredoc for body
gh pr create --title "${PR_TITLE}" --body "$(cat <<'EOF'
${PR_BODY}
EOF
)"
```

### 6. Verify Issue Links

After PR creation, confirm the Closes tags were recognized:

```bash
PR_NUM=$(gh pr view --json number -q .number)

# Verify linked issues appear in PR metadata
gh pr view ${PR_NUM} --json closingIssuesReferences -q '.closingIssuesReferences[].number'
```

If any expected issues are missing from `closingIssuesReferences`, the `Closes #N` syntax may have been malformed. Edit the PR body to fix.

### 7. Report to User

Output a **summary table** — this is the PRIMARY output:

```markdown
| PR | Branch | Closes | Changes |
|----|--------|--------|---------|
| #XX | feat/branch-name | #434, #447, #433 | rate limiting, rollback tests, auto mode confirm |
```

Then below the table:
- PR URL
- List of issues that will auto-close on merge
- "Ready for review" or next steps

## Critical Rules

1. **NO attribution** — No Co-Authored-By, no "Generated with Claude", no AI mentions. Zero Attribution Policy.
2. **Auto-detect issues** — Always scan commits, branch name, and from-review issues. Never skip detection.
3. **Confirm before creating** — Show the user the full PR content and wait for approval.
4. **Closes tags go in the body** — Use `Closes #N` on its own line in the PR body. GitHub only auto-closes from the body, not the title.
5. **Verify after creation** — Check that `closingIssuesReferences` matches expected issues.
6. **Target main** — Always create PRs against `main` unless the user specifies otherwise.
7. **Don't fabricate** — Only add `Closes #N` for issues the PR's changes actually address. If unsure, ask.
