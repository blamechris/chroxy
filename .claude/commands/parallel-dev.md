# /parallel-dev

Orchestrate parallel autonomous dev sessions — dispatch multiple agents into isolated worktrees to implement GitHub issues with TDD simultaneously, then run sequential reviews. Each agent works independently in its own worktree, eliminating branch conflicts.

## Arguments

- `$ARGUMENTS` - Issue source and options. Examples:
  - `label:ready-to-build` (all open issues with this label)
  - `milestone:"v1.2"` (all open issues in milestone)
  - `#12 #15 #18` or `12 15 18` (specific issues by number)
  - `label:ready-to-build parallel:4` (with concurrency override)
  - If empty, auto-detect: scan open issues sorted by complexity (low first, then medium, skip high)
  - Options: `max:N` (default 8, hard cap 10), `parallel:N` (default 3, max 5), `sort:created-asc` (default) or `sort:created-desc`

## Instructions

### Phase 0: Queue Setup

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# Branch prefix for autonomous session branches — matches existing conventions (feat/, fix/, refactor/, test/)
BRANCH_PREFIX="feat/"

# Default concurrency — balance between speed and resource usage. 3 for most repos, 2 for heavy builds.
PARALLEL=3
```

Parse `$ARGUMENTS` to determine the issue source:

- **Explicit list**: Strip `#` prefixes, run `gh issue view ${NUM} --json number,title,state,labels,body,assignees` for each
- **Label**: `gh issue list --label "${LABEL}" --state open --json number,title,labels,assignees --limit ${MAX}`
- **Milestone**: `gh issue list --milestone "${MILESTONE}" --state open --json number,title,labels,assignees --limit ${MAX}`
- **Auto-detect** (empty args): `gh issue list --state open --json number,title,labels,assignees --limit 20` then sort by complexity label (low first, then medium, skip high)

Extract `parallel:N` from arguments if present, override default. Cap at 5.

Apply sort order and cap to `max` (hard cap 10 — parallel sessions should be focused and well-scoped). Recommended: 3-5 issues for first use.

**Filter out assigned issues** — exclude issues with assignees from the working queue. Show in queue table as informational.

**Check for existing branches/PRs** for each issue — skip any that already have open PRs or merged branches (same resume logic as autonomous-dev-flow).

**Validate the queue before starting:**
- At least 1 issue must be open, unassigned, and without an existing PR
- If all matching issues are assigned, report "All N matching issues are assigned — nothing to process" and stop
- If 0 issues match, report and stop — don't start an empty session
- Show the user the queue and get confirmation

```markdown
## Parallel Work Queue ({N} issues, {P} concurrent agents)

| # | Issue | Labels | Action |
|---|-------|--------|--------|
| 1 | #12 — Add retry logic to API client | enhancement | Implement (batch 1) |
| 2 | #15 — Fix login timeout | bug | Implement (batch 1) |
| 3 | #18 — Add integration tests | testing | Implement (batch 1) |
| 4 | #20 — Update error messages | enhancement | Implement (batch 2) |
| — | #16 — Refactor auth module | enhancement | Assigned to @user (skipped) |

Mode: **Parallel** ({P} agents per batch, {B} batches)
Start parallel dev session?
```

Wait for user confirmation. **This is the ONLY confirmation point** — everything after runs autonomously.

After confirmation, create task list tracking:
```
For each issue in work queue:
  TaskCreate: "Issue #N — <title>" with status pending
```

### Phase 0.5: Auto-Decompose High-Complexity Issues

Before dispatching parallel agents, decompose issues that are too large.

When the queue contains issues with large scope descriptions (multiple systems, 3+ files) or equivalent:

For each high-complexity issue:

0. Check for prior decomposition — scan comments for existing "Decomposed into #A, #B, #C"
1. Read the full issue body: `gh issue view ${ISSUE_NUM} --json body,comments -q .`
2. Break into 2-5 sub-issues, each independently implementable
3. Create sub-issues via `gh issue create` (same format as autonomous-dev-flow)
4. Insert sub-issues at FRONT of queue (context is fresh from reading the parent)
5. Comment on parent: "Decomposed into #A, #B, #C — each independently implementable with TDD."
6. Parent stays open until all sub-issues merge — do NOT close it

After decomposition, if total queue exceeds 10, truncate to 10.

**Skip criteria** — auto-skip these issues (comment on each with reason):
- Empty issue body or no identifiable acceptance criteria
- No code path (manual testing, design docs, decisions needed)
- Requires user input not present in the description
- Deployment/release tasks
- Issues labeled `blocked` or `wontfix`
- Issues requiring design decisions with multiple valid approaches not specified

### Phase 1: Build Agent Prompts

Before dispatching agents, prepare everything they need.

1. **Read CLAUDE.md** once — store the content to embed in every agent prompt
2. **Sync to latest main:**

```bash
git checkout main
git pull origin main
```

3. **Fetch each issue's full details** — for each issue in the queue:

```bash
gh issue view ${ISSUE_NUM} --json title,body,labels,comments
```

4. **Build a self-contained prompt for each agent** using the Agent Prompt Template below. Each prompt must include everything the agent needs — it cannot access the coordinator's memory or other agents' state.

### Phase 2: Parallel Implementation (Fan-Out)

Launch implementation agents using the Agent tool with `isolation: "worktree"`. Each agent gets its own isolated copy of the repository — the platform handles worktree creation, branch management, and cleanup.

**Batching:** If the queue has more issues than `PARALLEL`, process in batches:
- Batch 1: first `PARALLEL` agents in parallel
- Wait for all to complete
- Batch 2: next `PARALLEL` agents in parallel
- Continue until queue is exhausted

**For each agent**, launch with the Agent tool:
- Set `isolation: "worktree"` to give the agent its own worktree
- Pass the self-contained prompt from Phase 1
- Run as foreground calls (NOT background) so output returns directly

**IMPORTANT:** Do NOT run agents in the background. Run them as foreground Agent calls so their output returns directly. If running more than the concurrency limit, batch them.

Each agent independently:
1. Installs dependencies in its worktree
2. Reads the issue and explores relevant code
3. Creates a branch from main
4. Implements with TDD (RED → GREEN → REFACTOR)
5. Runs lint/typecheck
6. Commits, pushes, creates a PR
7. Returns a structured result

If an agent fails at any step, it returns with an error. Other agents are unaffected.

### Phase 3: Collect Results (Fan-In)

After each batch completes, collect results from all agents.

Parse each agent's output for:
- Issue number
- Branch name
- PR number and URL
- Status: `implemented` (has PR), `failed` (error), or `skipped` (skip criteria)
- Error message if failed
- Files changed and tests added

Build interim progress table:

```markdown
## Implementation Results ({implemented}/{total})

| # | Issue | Branch | PR | Status | Notes |
|---|-------|--------|----|--------|-------|
| 1 | #12 — Add retry logic | 12-add-retry | [#45](url) | Implemented | 3 files, 5 tests |
| 2 | #15 — Fix login timeout | 15-fix-login | [#46](url) | Implemented | 2 files, 3 tests |
| 3 | #18 — Add integration tests | — | — | Failed | npm test error: missing fixture |
```

If more than half the agents failed, output a recommendation:
```
> More than half of the parallel agents failed. Consider running `/autonomous-dev-flow {failed_issues}` sequentially for better diagnostics.
```

### Phase 4: Sequential Review Pipeline

**Note:** Smoke tests (autonomous-dev-flow Phase 4.5) are NOT run during the parallel implementation phase. If a PR touches UI files, the reviewer should run smoke tests during /full-review. This avoids the complexity of running smoke tests across multiple worktrees and keeps the parallel phase focused on implementation.

For each successfully created PR (one at a time, sequentially):

1. **Pre-Skill Checkpoint** (MANDATORY — prevents context drift):
   - Re-read CLAUDE.md for project conventions
   - Re-read the skill files for /full-review, /agent-review, and /check-pr

2. **Run `/full-review ${PR_NUM}`**:
   - Phase 1: Agent review — deep expert review against project standards
   - Phase 2: Check-PR — process all review comments

3. **Classify verdict:**

| Verdict | Meaning | Action |
|---------|---------|--------|
| Clean | No critical findings, all comments addressed | Edit PR body: `Refs` → `Closes`. Mark issue done |
| Needs attention | Critical findings or unresolved comments | Keep `Refs`. Flag for user |
| Broken | Tests failing after review fixes | Keep `Refs`. Flag for user |

4. **Two fix attempts max** — if /full-review finds critical issues, fix them. If a second attempt still fails, flag and move on.

5. **Update progress table** after each review.

**CRITICAL:** Reviews run sequentially, never in parallel. Each review may push commits, and reviews benefit from focus.

### Phase 5: Session Summary

After all reviews complete, output final summary:

```markdown
## Parallel Dev Session Complete

**Issues processed:** {N} (in {B} batches of {P})
**Queue source:** {description}

### Results

| # | Issue | PR | Review Verdict | Status |
|---|-------|----|---------------|--------|
| 1 | #12 — Add retry logic | [#45](url) | Approve | Ready to merge |
| 2 | #15 — Fix login timeout | [#46](url) | Approve | Ready to merge |
| 3 | #18 — Add integration tests | — | — | Failed (implementation) |
| 4 | #20 — Update error messages | [#48](url) | Request Changes | Needs attention |

### Summary
- **Ready to merge:** N PRs
- **Needs attention:** M PRs (details below)
- **Failed (implementation):** K issues
- **Decomposed:** J issues → L sub-issues created
- **Skipped:** I issues (reasons below)
- **Issues created during reviews:** #A, #B, #C

### Needs Attention
- **PR #48** (#20 — Update error messages): 1 critical finding — error code not documented. See review comment.

### Failed Issues
- **#18** — Add integration tests: npm test error: missing fixture. Consider running `/autonomous-dev-flow #18` for sequential diagnostics.

### Next Steps
- Merge ready PRs: `/batch-merge #45 #46`
- Address flagged PRs
- Retry failed issues: `/autonomous-dev-flow #18`
```

## Agent Prompt Template

Each agent receives a fully self-contained prompt. The coordinator builds this by filling in the variables from Phase 1.

```
You are an autonomous implementation agent working in an isolated worktree.

## Your Assignment
- **Issue:** #<issue_number> — <issue_title>
- **Repository:** <repo>

## Issue Details

<full issue body from gh issue view>

## Setup

Install dependencies in this worktree:

npm install

## Project Conventions

<CLAUDE.md content embedded here by coordinator>

## Implementation (TDD)

### Create Branch

Generate a branch name from the issue title:

SLUG=$(printf '%s' "<issue title>" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-40)
# Branch naming convention: feat/<number>-<slug>
BRANCH="feat/<issue_number>-${SLUG}"
git checkout -b "${BRANCH}"

### RED — Write Failing Tests

Write tests that describe the desired behavior. Tests MUST fail before implementation.

# Test file conventions: server uses Node built-in test runner, app uses Jest
# Server: cd packages/server && npm test
# App: cd packages/app && npx jest

Run tests to confirm they fail.

### GREEN — Make Tests Pass

Write minimum implementation. Don't over-engineer.

### REFACTOR — Clean Up

With green tests: remove duplication, improve naming, simplify logic, follow project conventions.

# Lint/typecheck commands
# App: cd packages/app && npx tsc --noEmit
# Dashboard: cd packages/server && npm run dashboard:typecheck

### Commit and PR

Stage specific files (never git add -A or git add .):

git add <specific-files>

git commit -m "$(cat <<'EOF'
type(scope): description

Implements the core change.

Refs #<issue_number>
EOF
)"

# Commit scope conventions: server, app, desktop, tunnel, ws, cli, ci, docs, dashboard

Infer type from issue labels: bug→fix, enhancement→feat, test→test, refactor→refactor.

git push -u origin ${BRANCH}

PR_URL=$(gh pr create \
  --title "<type>: <issue title> (#<issue_number>)" \
  --body "$(cat <<'EOF'
## Summary

- Change 1
- Change 2

Refs #<issue_number>

## Test Plan

- [ ] Server tests pass
- [ ] App type-checks clean
- [ ] Dashboard tests pass
- [ ] Manual smoke test
EOF
)")

## Rules

1. NO attribution — no Co-Authored-By, no "Generated with Claude", no AI mentions anywhere
2. TDD is mandatory — RED → GREEN → REFACTOR. No skipping tests.
3. Branch from main (your worktree HEAD)
4. Stage specific files only — never `git add -A` or `git add .`
5. Do NOT run /full-review — the coordinator handles reviews after you finish
6. Do NOT merge the PR
7. If you cannot implement the issue (missing requirements, blocked, etc.), output status "failed" with the reason instead of forcing bad code

## Output

When complete, output your result clearly:

RESULT: implemented
ISSUE: <issue_number>
BRANCH: <branch_name>
PR: <pr_number>
PR_URL: <pr_url>
FILES_CHANGED: <count>
TESTS_ADDED: <count>

Or if failed:

RESULT: failed
ISSUE: <issue_number>
REASON: <why it failed>
```

## Resume Strategy

This skill uses **GitHub state** for resume — no local state files.

If a session is interrupted, re-running with the same arguments will:
1. Query GitHub for existing session branches (matching `BRANCH_PREFIX`) and PRs referencing each issue
2. Skip issues that already have merged or open PRs
3. Process only issues without existing PRs

This makes the skill **idempotent** — safe to re-run without duplicating work.

## Critical Rules

1. **NO attribution** — No Co-Authored-By, no "Generated with Claude", no AI mentions anywhere. Zero Attribution Policy.
2. **TDD is mandatory** — RED → GREEN → REFACTOR for every agent. No skipping tests.
3. **Branch from main** — Every agent branches from its worktree HEAD (which is main). Never stack branches.
4. **One confirmation point** — The initial queue approval. Everything after is fully autonomous.
5. **Never merge** — PRs accumulate for user review. Agents keep working.
6. **Reviews run sequentially** — Never run /full-review in parallel. Each review may push commits and benefits from focus.
7. **Two fix attempts max** — If /full-review finds critical issues, fix them. Second failure → flag and move on.
8. **Hard cap 10 issues** — Parallel sessions should be focused. Refuse larger queues.
9. **Max 5 concurrent agents** — More than 5 degrades quality and risks resource exhaustion.
10. **Agents are fully independent** — No shared state, no inter-agent communication. Each prompt is self-contained.
11. **Decomposition before fan-out** — All decomposition completes in Phase 0.5 before any agent launches.
12. **Failed agents don't block** — If one agent fails, others continue. Flag failures in progress table.
13. **Comment on skips** — Every skipped issue gets a GitHub comment explaining why.
14. **Pre-Skill Checkpoint** — Re-read CLAUDE.md and skill files before each /full-review run.
15. **Compose existing skills** — /full-review is called as-is. Don't reinvent its logic.
<!-- skill-templates: parallel-dev 6a1a98b 2026-04-26 -->
