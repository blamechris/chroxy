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

# Branch prefix for autonomous session branches
BRANCH_PREFIX="feat/"

# Default concurrency — balance between speed and resource usage
PARALLEL=3
```

Parse `$ARGUMENTS` to determine the issue source:

- **Explicit list**: Strip `#` prefixes, run `gh issue view ${NUM} --json number,title,state,labels,body,assignees` for each
- **Label**: `gh issue list --label "${LABEL}" --state open --json number,title,labels,assignees --limit ${MAX}`
- **Milestone**: `gh issue list --milestone "${MILESTONE}" --state open --json number,title,labels,assignees --limit ${MAX}`
- **Auto-detect** (empty args): `gh issue list --state open --json number,title,labels,assignees --limit 20` then sort by complexity label (low first, then medium, skip high)

Extract `parallel:N` from arguments if present, override default. Cap at 5.

Apply sort order and cap to `max` (hard cap 10 — parallel sessions should be focused and well-scoped). Recommended: 3-5 issues for first use.

**Filter out assigned issues** — exclude work owned by other runs. Restore this run's assignments from its durable record; do not filter its unfinished work out merely because it is assigned.

**Check existing branches/PRs** against the durable run record. Verify merged work and its ledger entry. Resume this run's owned open PR at its unfinished review/repair/merge step instead of creating another PR or skipping delivery. Preserve other runs' work.

**Validate the queue before starting:**
- At least one new unassigned issue or this run's owned unfinished attempt must be actionable.
- If nothing is actionable, reconcile acceptance, open PRs and the ledger before reporting completion or the precise blocker; do not infer completion from an empty issue query.
- Show the bounded queue; reuse existing authorization when it already covers these items.

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

**This is the ONLY confirmation point**, and only when the proposed queue needs authority or scope not already supplied. Otherwise proceed. Do not ask again for routine review, repair or gated merge of delegated work.

After establishing the authorized scope, create task list tracking:
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

**Skip criteria** — verify the current dependency and record the specific reason, rather than skipping by task type:
- No identifiable acceptance criteria after reading the delegated outcome and linked context — request the missing requirement while continuing independent preparation.
- An indispensable owner-reserved decision, QA action, access or release authorization is unavailable — block only the dependent work; keep authorized design, documentation, implementation and preparation with the agent.
- `wontfix` without authority to revisit it, or a `blocked` label whose documented dependency still applies — inspect the reason rather than assuming the label is permanent.
- An applicable attempt, budget or host limit prevents this item — preserve consumed allowance and advance independent authorized work with known remaining allowance.

Multiple valid implementation approaches are not themselves a blocker: investigate reusable code, decide within delegated authority and record a proportional plan. Re-evaluate the item when a prerequisite arrives, preserving its state and limits rather than requiring another delegation.

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

**Delegation tiers (cost discipline — do not strip):**

Roles per `/tiered-delegation`: **workhorse** = one tier below the session ceiling, **mechanical** = cheapest available tier. Concrete model names live only in that skill's CUSTOMIZE-marker ladder — never here.

- **Implementers run at the workhorse tier by default.** Well-scoped, low/medium-complexity issues are workhorse work. Spawn a **ceiling-tier implementer only for a non-trivial issue** — genuine design latitude, cross-cutting change surface, or a prior workhorse failure on the same issue — and note which issues got the ceiling tier in the progress table.
- **Triage/classification at the mechanical tier.** The queue triage pass (complexity read, skip-criteria checks, label classification) runs at the mechanical tier at low effort.
- **Sample-verify instead of up-tiering.** Re-check a ~10% sample of the mechanical triage's classifications with a stronger tier rather than running the whole triage on an expensive one; a failed sample sends the batch back for verification, not up-tier.
- **Fan-out budget: ~12 workhorse/ceiling subagents per run** (implementers + reviewers across all batches). Mechanical-tier triage/pre-filter agents and the ~10% sample-verify checks do not count against it. Exceeding 12 requires an explicit one-line justification recorded in the session summary; **20 is a hard ceiling that includes every refute/verify agent, and no justification lifts it** (≤3 refuters per finding — queue rounds rather than widen).

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
| Clean | No blocking findings, all dispositions evidenced | Edit PR body: `Refs` → `Closes` only if acceptance is met; proceed to coordinator merge gates |
| Needs attention | Blocking findings or unresolved dispositions | Keep `Refs`; repair within remaining attempts or record the precise blocker |
| Broken | Tests failing after review fixes | Keep `Refs`; repair within remaining attempts or record the failed gate |

4. **Two fix attempts max** — if /full-review finds critical issues, fix them. If a second attempt still fails, flag and move on.

5. **Coordinator delivery:** implementation workers do NOT merge the PR; the coordinator owns review and delivery. For delegated implementation in either normal or prime mode, verify final-commit CI, `/full-review`, required resolved threads and repository requirements, then merge synchronously in dependency order without another confirmation. Refresh dependent PRs after their base changes. Respect explicit holds and required external approvals; never bypass gates or use `--admin`/`--auto`. Verify `MERGED` and record the merge SHA, acceptance and follow-ups in the ledger before marking the issue delivered. A clean open PR is reviewed, not delivered.

6. **Update progress table** after each review/merge. When the selected package finishes, normal mode writes the verified seed and requests a fresh session; prime mode checkpoints and continues only its authorized mission within the original limits.

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
| 1 | #12 — Add retry logic | [#45](url) | Approve | Merged; SHA recorded |
| 2 | #15 — Fix login timeout | [#46](url) | Approve | Merged; SHA recorded |
| 3 | #18 — Add integration tests | — | — | Failed (implementation) |
| 4 | #20 — Update error messages | [#48](url) | Request Changes | Needs attention |

### Summary
- **Verified merged:** N PRs
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
- State the actual remaining gate for open PRs; request an owner action only if required
- Normal mode: verified seed path for the next session
- Prime mode: next authorized item, or the actual stop condition
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
BRANCH="feat/<issue_number>-${SLUG}"
git checkout -b "${BRANCH}"
SESSION_BRANCH="${BRANCH}"

**Assert the branch before you write.** Your worktree is meant to be private, but that is a
property of how you were launched, not something you can assume — a stray `git checkout`
(yours, or another agent's if you are not actually isolated) moves HEAD, and `git` HEAD is
global to whatever working copy you are standing in. So record the branch you created as
`SESSION_BRANCH` above, and re-check it immediately before your first edit AND again
immediately before staging. Re-check, never remember. If it fails, stop and re-establish
`SESSION_BRANCH` — never write to a branch this session did not create.

assert_branch() {
  local now; now="$(git branch --show-current)"
  [ "${now}" = "${SESSION_BRANCH}" ] || {
    echo "STOP: on '${now}', expected '${SESSION_BRANCH}' — HEAD moved. Do not edit, do not stage." >&2
    return 1
  }
}

assert_branch || exit 1   # before the first edit

### RED — Write Failing Tests

Write tests that describe the desired behavior. Tests MUST fail before implementation.

For server: `cd packages/server && npm test`
For app: `cd packages/app && npx jest`
For dashboard: `cd packages/server && npm run dashboard:test`

Run tests to confirm they fail.

### GREEN — Make Tests Pass

Write minimum implementation. Don't over-engineer.

### REFACTOR — Clean Up

With green tests: remove duplication, improve naming, simplify logic, follow project conventions.

App: `cd packages/app && npx tsc --noEmit`
Dashboard: `cd packages/server && npm run dashboard:typecheck`

### Commit and PR

**Stage explicit paths.** `git status --short` first, then `git add` the files you changed,
by name. Never `git add -A`, `git add .`, `git add -u`, `git add <dir>/`, or `git commit -a` —
a bulk add commits whatever else happens to be in the tree. `-u` is not the safe one: it
restages every *tracked* file whose worktree copy differs, including files a clean/smudge
filter rewrote without you touching them — that is how `git add -u` turned a tracked 21KB
`.docx` into a git-lfs pointer and committed it as an edit.

assert_branch || exit 1   # second mandatory check — before staging
                          # (defined under "Create Branch"; re-declare in a fresh shell)

git status --short
git add <specific-files>

git commit -m "$(cat <<'EOF'
type(scope): description

Implements the core change.

Refs #<issue_number>
EOF
)"

Infer type from issue labels: bug→fix, enhancement→feat, test→test, refactor→refactor.

Commit scopes: `server`, `app`, `desktop`, `tunnel`, `ws`, `cli`, `ci`, `docs`, `dashboard`

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
4. Stage specific files by name — never `git add -A`, `git add .`, `git add -u`, `git add <dir>/`, or `git commit -a`. `-u` is not the safe one: it restages tracked files a clean/smudge filter rewrote behind your back, which is how a tracked 21KB `.docx` was committed as a git-lfs pointer.
5. Assert the branch before you write — re-check `git branch --show-current` against `SESSION_BRANCH` immediately before your first edit and again immediately before staging. Never write to a branch this session did not create.
6. Do NOT run /full-review — the coordinator handles reviews after you finish
7. Do NOT merge the PR
8. If you cannot implement the issue (missing requirements, blocked, etc.), output status "failed" with the reason instead of forcing bad code

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

Resume from the durable run record: run identity, mode, selected scope, branch/worktree
ownership, per-item stage, attempts (including failures before a PR), review/worker counts
and consumed limits. Query GitHub to reconcile current PR heads, gates and verified merges.
Resume owned open PRs at their unfinished stage; do not duplicate implementation or skip
delivery. Zero PRs does not imply zero attempts. Recover missing accounting before capped
work; unknown allowance is not zero consumption. Record attempts when they start and retain
the same counters across compaction/restart. Re-entry is **idempotent** and does not reset
the two repair attempts or the selected queue/fan-out limits.

## Critical Rules

1. **NO attribution** — No Co-Authored-By, no "Generated with Claude", no AI mentions anywhere. Zero Attribution Policy.
2. **TDD is mandatory** — RED → GREEN → REFACTOR for every agent. No skipping tests.
3. **Branch from main** — Every agent branches from its worktree HEAD (which is main). Never stack branches.
4. **One confirmation point** — Establish missing queue authority only; reuse existing authorization. Routine gated merges need no further approval.
5. **Worker/coordinator ownership** — Workers never merge; the coordinator completes required review, final-commit CI, gated merge and ledger update for authorized delivery in either mode.
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
16. **Explicit-path staging** — every agent stages the changed files by name. Never `git add -A`, `git add .`, `git add -u`, `git add <dir>/`, or `git commit -a`. `-u` is not the safe one: it restages tracked files a clean/smudge filter rewrote behind your back, which is how a tracked 21KB `.docx` was committed as a git-lfs pointer.
17. **Assert the branch before writing** — an agent records the branch it creates as `SESSION_BRANCH` and re-checks `git branch --show-current` against it before its first edit and again before staging. Worktree isolation is the plan, not a guarantee; a stray checkout still moves HEAD.

<!-- skill-templates: parallel-dev 37866a5 2026-11-03 -->
