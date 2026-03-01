# /autonomous-dev-flow

Orchestrate long-running autonomous dev sessions — work through GitHub issues sequentially with TDD, create PRs, run /full-review, and continue to the next issue. The user reviews and merges PRs asynchronously while work continues.

## Arguments

- `$ARGUMENTS` - Issue source and options. Examples:
  - `label:ready-to-build` (all open issues with this label)
  - `milestone:"v1.2"` (all open issues in milestone)
  - `#12 #15 #18` or `12 15 18` (specific issues by number)
  - `label:ready-to-build max:5 sort:created-asc` (with options)
  - If empty, auto-detect: scan open issues sorted by complexity (low first, then medium, skip high)
  - Options: `max:N` (default 10, hard cap 15), `sort:created-asc` (default) or `sort:created-desc`

## Instructions

### Phase 0: Queue Setup

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

BRANCH_PREFIX="feat/"
```

Parse `$ARGUMENTS` to determine the issue source:

- **Explicit list**: Strip `#` prefixes, run `gh issue view ${NUM} --json number,title,state,labels,body,assignees` for each
- **Label**: `gh issue list --label "${LABEL}" --state open --json number,title,labels,assignees --limit ${MAX}`
- **Milestone**: `gh issue list --milestone "${MILESTONE}" --state open --json number,title,labels,assignees --limit ${MAX}`
- **Auto-detect** (empty args): `gh issue list --state open --json number,title,labels,assignees --limit 30` then sort by complexity label (low first, then medium, skip high)

Apply sort order and cap to `max` (hard cap 15 — sessions beyond this rarely maintain quality). Recommended: 3-5 issues for first use; sessions of 10+ work best with well-specified, low-complexity issues.

**Filter out assigned issues** — exclude issues with assignees from the working queue. Show them in the queue table as informational but don't process them.

**Validate the queue before starting:**
- At least 1 issue must be open and unassigned
- If all matching issues are assigned, report "All N matching issues are assigned — nothing to process" and stop
- If 0 issues match, report and stop — don't start an empty session
- Show the user the queue and get confirmation before entering the loop

```markdown
## Work Queue ({N} issues, {M} skipped as assigned)

| # | Issue | Labels | Action |
|---|-------|--------|--------|
| 1 | #12 — Add retry logic to API client | enhancement | Implement |
| 2 | #15 — Add leaderboard system | complexity:high | Decompose → sub-issues |
| — | #16 — Refactor auth module | enhancement | Assigned to @user (skipped) |
| 3 | #18 — Add integration tests for auth flow | testing | Implement |

Start autonomous dev session?
```

Wait for user confirmation. **This is the ONLY confirmation point** — everything after runs autonomously.

After confirmation, create task list tracking:
```
For each issue in work queue:
  TaskCreate: "Issue #N — <title>" with status pending
```

### Phase 0.5: Auto-Decompose High-Complexity Issues

When the queue contains issues that are too large to implement directly (e.g., labeled `complexity:high` or equivalent), decompose them into smaller, independently implementable sub-issues BEFORE entering the core loop.

For each high-complexity issue:

0. Check for prior decomposition — scan the issue's comments for an existing "Decomposed into #A, #B, #C" comment. If found, use those existing sub-issues instead of creating new ones.
1. Read the full issue body: `gh issue view ${ISSUE_NUM} --json body,comments -q .`
2. Understand the full scope — files involved, systems affected, testing needs
3. Break into 2-5 sub-issues, each low or medium complexity
4. Create sub-issues via `gh issue create`:

```bash
SUB_URL=$(gh issue create \
  --title "type(scope): Sub-task description" \
  --label "enhancement" \
  --body "$(cat <<'EOF'
## Summary

Specific sub-task description.

Part of #${ISSUE_NUM}

## Implementation Plan

- Files to modify: `src/path/to/file`
- Test strategy: Add tests for X behavior
- Approach: [specific implementation details]

## Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2
EOF
)")

SUB_NUM=$(basename "$SUB_URL")
```

5. Insert sub-issues at FRONT of queue (context is fresh from reading the parent)
6. Comment on parent issue: `gh issue comment ${ISSUE_NUM} --body "Decomposed into #A, #B, #C — each independently implementable with TDD."`
7. Parent stays open until all sub-issues merge — do NOT close it
8. After decomposition, if the total queue exceeds 15, truncate to 15 with a message: "Queue expanded to N issues after decomposition. Processing first 15."

**Skip criteria** — auto-skip these issues (log reason in progress table):
- Empty issue body or no identifiable acceptance criteria — needs requirements before implementation
- No code path (manual testing, design docs, decisions needed)
- Requires user input not present in the description
- Deployment/release tasks
- Issues labeled `blocked` or `wontfix`
- Issues requiring design decisions with multiple valid approaches not specified

If skipping, comment on the issue:

```bash
gh issue comment ${ISSUE_NUM} --body "Skipped during autonomous dev session — [reason]. Needs manual attention."
```

### Phase 1: Sync Check (before EACH issue)

```bash
git checkout main
git pull origin main
```

Check for any PRs merged by the user since last check:

```bash
gh pr list --state merged --json number,headRefName,mergedAt --limit 20 \
  | jq --arg prefix "${BRANCH_PREFIX}" '[.[] | select(.headRefName | startswith($prefix))]'
```

Note any merged PRs in the progress table. If on a stale branch, switch back to main.

Check for existing branches/PRs from a previous session for the current issue:

```bash
# Check if issue already has a PR (search by title reference)
gh pr list --json number,title,headRefName,state --limit 50 \
  | jq --arg num "${ISSUE_NUM}" '[.[] | select(.title | contains("#" + $num))]'

# Also check by branch prefix
gh pr list --json number,title,headRefName,state --limit 50 \
  | jq --arg prefix "${BRANCH_PREFIX}" '[.[] | select(.headRefName | startswith($prefix))]'
```

- Already merged → mark as done, skip
- Open PR exists → skip (user can re-queue if needed)
- Stale branch, no PR → delete branch, re-process

### Phase 2: Issue Understanding

```bash
gh issue view ${ISSUE_NUM} --json title,body,labels,comments
```

Read the full issue. Identify:
- **Files to modify** — use Glob/Grep to find relevant code
- **Test strategy** — what behavior to test, where tests go
- **Implementation approach** — minimal path to satisfy acceptance criteria

Explore the codebase to understand the relevant code before writing anything:

```bash
# Read CLAUDE.md for project conventions
cat CLAUDE.md 2>/dev/null

# Explore relevant files based on issue description
```

If the issue body is empty or has no actionable requirements, apply skip criteria from Phase 0.5.

### Phase 3: Implementation (TDD)

Create branch following project conventions:

```bash
# Generate slug from issue title: lowercase, hyphens, no special chars, max 40 chars
ISSUE_TITLE=$(gh issue view "${ISSUE_NUM}" --json title -q '.title')
SLUG=$(printf '%s' "${ISSUE_TITLE}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-40)

# Create branch from issue number + slug
BRANCH="${BRANCH_PREFIX}${ISSUE_NUM}-${SLUG}"
git checkout -b "${BRANCH}"
```

**CRITICAL: Always branch from main.** Never stack branches — each PR must be independently mergeable in any order.

#### RED — Write Failing Tests First

Based on the issue's acceptance criteria, write tests that describe the desired behavior. Tests MUST fail before any implementation.

```bash
# Server: npm test, App: npx jest
# Server: __tests__/*.test.js, App: __tests__/*.test.ts

# Run tests to confirm they fail
npm test
```

If tests pass immediately, the behavior already exists — investigate before proceeding. Either the issue is already resolved or the tests don't capture the right behavior.

#### GREEN — Make Tests Pass

Write the minimum implementation to make all new tests pass. Don't over-engineer — just satisfy the tests.

```bash
# Run tests to confirm they pass
npm test
```

If tests still fail, iterate on the implementation until they pass. Do NOT move to REFACTOR until all tests are green.

#### REFACTOR — Clean Up

With green tests as a safety net:
- Remove duplication
- Improve naming
- Simplify logic
- Ensure the code follows project conventions (per CLAUDE.md)

```bash
# Run tests again to confirm refactoring didn't break anything
npm test

# App: npx tsc --noEmit
npx tsc --noEmit
```

### Phase 4: Commit and PR Creation

Stage and commit with conventional format:

```bash
# Stage relevant files (never git add -A)
git add <specific-files>

# Commit with issue reference — NO attribution
git commit -m "$(cat <<'EOF'
type(scope): description

Implements the core change described in the issue.

Refs #${ISSUE_NUM}
EOF
)"

# server, app, core, ui

git push -u origin ${BRANCH}
```

Create PR autonomously (NO user confirmation — PRs are the async checkpoints):

```bash
# Construct PR title: conventional commit format referencing the issue
# Infer type from issue labels (bug→fix, enhancement→feat, etc.)
ISSUE_LABELS=$(gh issue view "${ISSUE_NUM}" --json labels -q '[.labels[].name] | join(",")')
case "${ISSUE_LABELS}" in
  *bug*) PR_TYPE="fix" ;;
  *test*) PR_TYPE="test" ;;
  *refactor*) PR_TYPE="refactor" ;;
  *) PR_TYPE="feat" ;;
esac
PR_TITLE="${PR_TYPE}: ${ISSUE_TITLE} (#${ISSUE_NUM})"

PR_URL=$(gh pr create \
  --title "${PR_TITLE}" \
  --body "$(cat <<'EOF'
## Summary

- Change 1
- Change 2

Refs #${ISSUE_NUM}

## Test Plan

- [ ] All new tests pass
- [ ] Existing tests unbroken
- [ ] Server tests pass
- [ ] App type-checks clean
- [ ] Manual smoke test
EOF
)")

PR_NUM=$(echo "$PR_URL" | grep -oE '[0-9]+$')
```

### Phase 5: Full Review

**Pre-Skill Checkpoint** (MANDATORY — prevents context drift in long sessions):
1. Re-read CLAUDE.md for project conventions
2. Re-read the skill files for /full-review, /agent-review, and /check-pr

Run `/full-review ${PR_NUM}`:
- Phase 1: Agent review — deep expert review against project standards
- Phase 2: Check-PR — process all review comments (Copilot + agent-review findings)

Capture results: verdict, findings counts, fixes committed, issues created/closed.

**If critical findings exist:** Fix them (standard /full-review behavior handles this). Two fix attempts max — after that, flag the PR as "Needs attention" and move on.

**Do NOT merge.** PRs accumulate for user review. The agent keeps working.

### Phase 6: Assess, Report, and Continue

Based on /full-review results, classify the PR:

| Verdict | Meaning | Action |
|---------|---------|--------|
| Clean | No critical findings, all comments addressed | Edit PR body: `Refs` → `Closes`. Mark issue done, continue |
| Needs attention | Critical findings or unresolved comments | Keep `Refs` (don't auto-close). Flag for user, continue |
| Broken | Tests failing after review fixes | Keep `Refs` (don't auto-close). Flag for user, continue |

Update task tracking:

```
TaskUpdate: "Issue #N" → completed (or flagged)
```

Output cumulative progress table:

```markdown
## Session Progress ({completed}/{total})

| # | Issue | Branch | PR | Review | Status |
|---|-------|--------|----|--------|--------|
| 1 | #12 — Add retry logic | 12-add-retry | #45 | Approve (0 critical) | Done |
| 2 | #15 — Add leaderboard | — | — | — | Decomposed → #20, #21 |
| 3 | #20 — Leaderboard data model | 20-lb-model | #46 | Approve (1 suggestion) | Done |
| 4 | #18 — Add auth tests | — | — | — | In progress |
| 5 | #22 — Update error handling | — | — | — | Queued |
```

**CRITICAL: Never block the session on a flagged PR.** Flag and move on. The user handles flagged PRs during check-ins.

Return to Phase 1 for next issue.

### Phase 7: Session Summary

After all issues are processed (or the queue is exhausted), output final summary:

```markdown
## Autonomous Dev Session Complete

**Issues processed:** {N}
**Queue source:** {description}

### Results

| # | Issue | PR | Review Verdict | Status |
|---|-------|----|---------------|--------|
| 1 | #12 — Add retry logic | [#45](url) | Approve | Ready to merge |
| 2 | #15 — Add leaderboard | — | — | Decomposed → #20, #21, #22 |
| 3 | #20 — Leaderboard data model | [#46](url) | Approve | Ready to merge |
| 4 | #18 — Add auth tests | [#47](url) | Request Changes | Needs attention |

### Summary
- **Ready to merge:** N PRs
- **Needs attention:** M PRs (details below)
- **Decomposed:** K issues → L sub-issues created
- **Skipped:** J issues (reasons below)
- **Issues created during reviews:** #A, #B, #C
- **PRs merged by user during session:** #X, #Y

### Needs Attention
- **PR #47** (#18 — Add auth tests): 1 critical finding — auth token not validated before use. See review comment.

### Skipped Issues
- **#25**: Requires deployment setup — not automatable
- **#30**: Needs user decision on provider choice

### Next Steps
- Merge ready PRs
- Address flagged PRs
- Review created issues for follow-up work
```

## Resume Strategy

This skill uses **GitHub state** for resume — no local state files.

If a session is interrupted (crash, timeout, user stops it), re-running with the same arguments will:

1. Query GitHub for existing session branches (matching `BRANCH_PREFIX`) and PRs referencing each issue
2. Skip issues that already have merged or open PRs
3. Resume from the first issue without a PR

This makes the skill **idempotent** — safe to re-run without duplicating work.

## Critical Rules

1. **NO attribution** — No Co-Authored-By, no "Generated with Claude", no AI mentions anywhere. Zero Attribution Policy.
2. **TDD is mandatory** — RED → GREEN → REFACTOR for every issue. No skipping tests. If pure docs/config, note why tests are N/A.
3. **Branch from main every time** — Never stack branches. Each PR is independently mergeable in any order.
4. **One confirmation point** — The initial queue approval. Everything after is fully autonomous.
5. **Never merge** — PRs accumulate for user review. The agent keeps working.
6. **Never block on review findings** — Flag and move on. The user handles flagged PRs during check-ins.
7. **Two fix attempts max** — If /full-review finds critical issues, fix them. If a second attempt still fails, flag and move on.
8. **Progress table after every issue** — The user may check in at any time. The table must be current.
9. **Respect the hard cap** — Max 15 issues per session. Refuse larger queues.
10. **Resume from GitHub state** — No local state files. Query branches matching `BRANCH_PREFIX` and PR titles to detect prior work.
11. **Compose existing skills** — /full-review is called as-is (chains /agent-review → /check-pr). Don't reinvent their logic.
12. **Decompose, don't skip** — High-complexity issues get broken into sub-issues, not skipped. Only skip truly non-automatable work.
13. **Comment on skips** — Every skipped issue gets a GitHub comment explaining why. The user sees the reason.
14. **Pre-Skill Checkpoint** — Re-read CLAUDE.md and skill files before running /full-review to prevent context drift.
15. **Sync before branching** — Always `git checkout main && git pull` before starting each issue. Check for merged PRs first.
<!-- skill-templates: autonomous-dev-flow e60105e 2026-02-28 -->
