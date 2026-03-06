# /tackle-issues

Run an unattended marathon session that works through GitHub issues across multiple waves until convergence — all issues are resolved, or all remaining issues are genuinely blocked. Designed to maximize overnight/extended usage windows.

Composes `/autonomous-dev-flow` logic internally but adds multi-wave retry with escalating strategies, dynamic queue replenishment, and a morning summary.

## Arguments

- `$ARGUMENTS` - Issue source and options. Same as `/autonomous-dev-flow` plus marathon-specific options:
  - `label:ready-to-build` (all open issues with this label)
  - `milestone:"v1.2"` (all open issues in milestone)
  - `#12 #15 #18` or `12 15 18` (specific issues by number)
  - `label:ready-to-build max:10 sort:created-asc` (with options)
  - If empty, auto-detect: scan open issues sorted by complexity (low first, then medium, skip high)
  - Options: `max:N` (default 20, hard cap 30), `sort:created-asc` (default) or `sort:created-desc`
  - `waves:N` (default 3, max 4) — maximum retry waves
  - `merge:true` — run `/batch-merge all` after final wave (default: false)

## Instructions

### Wave Model Overview

```
Wave 1 (Fresh Pass)    → Attempt all queued issues using standard approach
                           ↓ replenish queue (sub-issues, new labeled issues)
Wave 2 (Retry)         → Re-attempt failed/flagged issues with fresh context
                           ↓ replenish queue
Wave 3 (Alt Strategy)  → Re-attempt remaining failures with alternative approaches
                           ↓ convergence check
Wave 4 (Final Sweep)   → Last attempt on anything still open (optional, if waves:4)
                           ↓
Morning Summary        → Structured report of everything that happened
```

Each wave runs the full Phase 1-6 cycle from `/autonomous-dev-flow` for each issue. The difference is what happens between waves and how retries are handled.

### Phase 0: Marathon Setup

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
REPO_NAME=$(basename "$REPO")
SESSION_START=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

BRANCH_PREFIX="feat/"
```

Parse `$ARGUMENTS` — same as `/autonomous-dev-flow` but with higher defaults:
- `max` defaults to 20, hard cap 30
- `waves` defaults to 3, max 4
- `merge` defaults to false

Build the initial queue using the same logic as `/autonomous-dev-flow` Phase 0:
- Fetch issues by label, milestone, explicit list, or auto-detect
- Filter out assigned issues
- Apply sort and cap

**Validate:**
- At least 1 issue must be open and unassigned
- If 0 issues match, report and stop

Display the marathon queue:

```markdown
## Marathon Session — {N} issues, up to {W} waves

| # | Issue | Labels | Action |
|---|-------|--------|--------|
| 1 | #12 — Add retry logic | enhancement | Implement |
| 2 | #15 — Add leaderboard | complexity:high | Decompose → sub-issues |
| 3 | #18 — Auth integration tests | testing | Implement |
| — | #16 — Refactor auth module | enhancement | Assigned to @user (skipped) |

**Mode:** Unattended marathon (up to {W} waves)
**Merge after:** {Yes/No}
**Estimated scope:** {N} issues × {W} max waves

Start marathon session?
```

Wait for user confirmation. **This is the ONLY confirmation point** — everything after runs fully autonomously, including retries across waves.

After confirmation, initialize tracking:

```
MASTER_LOG = []   # Tracks every attempt: {issue, wave, branch, pr, verdict, error}
WAVE_NUM = 1
```

### Phase 1: Execute Wave

For each issue in the current wave's queue, run the full `/autonomous-dev-flow` Phases 1-6 cycle:

1. **Sync Check** — `git checkout main && git pull origin main`
2. **Issue Understanding** — Read issue, identify files, plan approach
3. **Implementation (TDD)** — Branch, RED-GREEN-REFACTOR
4. **Commit and PR** — Push, create PR
5. **Full Review** — `/full-review` with pre-skill checkpoint
6. **Assess and Report** — Classify verdict, update progress

**Key differences from standalone `/autonomous-dev-flow`:**

- **Two fix attempts per issue per wave** (same as original). If still failing after 2 attempts, mark as `retry` instead of just `flagged`.
- **Track the failure reason** in `MASTER_LOG` — this informs the retry strategy in later waves.
- **High-complexity decomposition** happens in Wave 1 only. Sub-issues created during decomposition are added to the current wave's queue (not deferred to Wave 2).

After each issue, output the wave progress table:

```markdown
## Wave {W} Progress ({completed}/{total})

| # | Issue | Branch | PR | Review | Status | Attempt |
|---|-------|--------|----|--------|--------|---------|
| 1 | #12 — Add retry logic | 12-add-retry | #45 | Approve | Done | W1 |
| 2 | #15 — Leaderboard | — | — | — | Decomposed → #20,#21 | W1 |
| 3 | #20 — LB data model | 20-lb-model | #46 | Request Changes | Retry (W2) | W1 |
| 4 | #18 — Auth tests | 18-auth-tests | #47 | Approve | Done | W1 |
| 5 | #21 — LB display | — | — | — | In progress | W1 |
```

### Phase 2: Queue Replenishment (Between Waves)

After a wave completes, refresh the queue before starting the next wave.

#### 2a. Collect Retry Candidates

From `MASTER_LOG`, gather issues where the latest attempt was not `Done`:

| Status | Meaning | Retry? |
|--------|---------|--------|
| Done | PR created, review clean | No — skip in future waves |
| Retry | Tests failing or review found critical issues | Yes — re-attempt |
| Flagged | 2 fix attempts failed in a wave | Yes — with different strategy |
| Skipped | Non-automatable (blocked, no criteria, etc.) | No — genuinely blocked |
| Decomposed | Broken into sub-issues | No — sub-issues are in queue |

#### 2b. Scan for New Issues

Check for issues that appeared since the session started (from decomposition or external creation):

```bash
# Sub-issues created during decomposition
gh issue list --state open --json number,title,labels,assignees,createdAt --limit 50 \
  | jq --arg start "$SESSION_START" '[.[] | select(.createdAt > $start)]'

# Also re-scan the original label/milestone for newly added issues
# (user may have labeled new issues while session was running)
```

Add new unassigned issues to the queue if they match the original filter criteria and aren't already in `MASTER_LOG`.

#### 2c. Check for User Merges

```bash
gh pr list --state merged --json number,headRefName,mergedAt --limit 30 \
  | jq --arg start "$SESSION_START" --arg prefix "$BRANCH_PREFIX" \
    '[.[] | select(.mergedAt > $start) | select(.headRefName | startswith($prefix))]'
```

Note merged PRs. If a merged PR's issue is in the retry queue, remove it — the user handled it.

#### 2d. Clean Up Failed Branches

For issues entering Wave 2+, delete the stale branch and PR from the previous attempt:

```bash
# For each retry candidate:
# Close the old PR (it had issues)
gh pr close ${OLD_PR_NUM} --comment "Closing for retry in Wave ${NEXT_WAVE} — previous attempt had: ${FAILURE_REASON}"

# Delete the old remote branch
git push origin --delete ${OLD_BRANCH}
```

This ensures each retry starts completely fresh — new branch from latest main, no stale code.

#### 2e. Build Next Wave Queue

Combine:
1. Retry candidates (issues that failed in previous wave)
2. New issues from replenishment scan
3. Remaining issues not yet attempted (if queue was large)

Cap at `max` setting. Retry candidates go first (they have the most context built up).

If the next wave queue is empty, skip to Morning Summary.

### Phase 3: Retry Strategy Escalation

Each wave uses an escalating strategy for issues that failed in prior waves:

#### Wave 2 — Fresh Context Retry

For issues that failed in Wave 1:
1. **Re-read the issue** completely — don't rely on Wave 1 understanding
2. **Read the failed PR's review comments** — understand what went wrong
3. **Read the diff from the failed attempt** (before branch deletion) to understand what was tried
4. **Start fresh** — new branch from latest main, new implementation
5. **Address the specific failure** — if tests failed, focus on why; if review found issues, incorporate feedback
6. Same TDD cycle, same review process

#### Wave 3 — Alternative Approach

For issues that failed in both Wave 1 and Wave 2:
1. **Analyze both previous failures** — what approaches were tried, why they failed
2. **Try a fundamentally different approach:**
   - If the implementation approach failed, try a different architecture
   - If tests were the issue, reconsider the test strategy
   - If review found design issues, rethink the design
3. **Simplify scope** — implement the minimum viable version that satisfies core acceptance criteria. Defer edge cases to a follow-up issue.
4. **If simplification isn't possible** — create a detailed "blocked" comment on the issue:

```bash
gh issue comment ${ISSUE_NUM} --body "$(cat <<'EOF'
## Automated Implementation — Blocked After 3 Attempts

### What was tried:
- **Wave 1:** [approach and failure reason]
- **Wave 2:** [approach and failure reason]
- **Wave 3:** [approach and failure reason]

### Diagnosis:
[Why this issue resists automated implementation]

### Recommendation:
[Specific guidance for manual implementation or issue refinement]
EOF
)"
```

Mark as `Blocked-auto` and move on.

#### Wave 4 (Optional) — Final Sweep

Only runs if `waves:4` was specified. For any remaining retry candidates:
1. Apply Wave 3 strategy (alternative approach + simplification)
2. Any issue that still fails gets the "blocked" comment and is permanently flagged
3. This wave exists for stubborn issues in large queues — most sessions converge by Wave 3

### Phase 4: Convergence Detection

After each wave, check for convergence BEFORE entering the next wave:

**Convergence = stop the session** when ANY of these is true:
- All issues are `Done` or `Skipped` — nothing left to try
- Zero issues changed status in the last wave — no progress being made
- All retry candidates have been attempted in 3+ waves — maximum effort reached
- Queue is empty after replenishment

**Progress metric:** Count issues that moved to `Done` in the latest wave. If this count is 0 and there are retry candidates, the session has converged on failure — further waves won't help.

```markdown
## Convergence Check — Wave {W} Complete

| Metric | Value |
|--------|-------|
| Issues attempted this wave | {N} |
| New completions this wave | {M} |
| Remaining retries | {K} |
| New issues discovered | {J} |

**Decision:** {Continue to Wave W+1 / Converged — moving to summary}
**Reason:** {e.g., "3 new completions, 2 retries remaining — continuing" or "0 new completions, same 2 issues failing — converged"}
```

### Phase 5: Optional Batch Merge

If `merge:true` was specified AND at least one PR is ready:

1. List all PRs created during this session that have clean reviews
2. Run `/batch-merge` with those PR numbers
3. Record merge results in the morning summary

If `merge:true` was NOT specified, skip this phase and note in the summary:
```
**Ready to merge:** Run `/batch-merge {PR_NUMS}` to merge completed PRs.
```

### Phase 6: Morning Summary

Output a comprehensive summary designed for the user to read when they return. This is the primary deliverable of an overnight session.

```markdown
## Marathon Session Complete

**Started:** {SESSION_START}
**Duration:** {elapsed time}
**Waves completed:** {W} of {MAX_WAVES}
**Convergence:** {reason — e.g., "All issues resolved" or "No progress in Wave 3"}

### Results Overview

| Metric | Count |
|--------|-------|
| Issues attempted | {N} |
| PRs created (ready to merge) | {M} |
| PRs flagged (needs attention) | {K} |
| Issues decomposed | {D} → {S} sub-issues |
| Issues blocked (auto) | {B} |
| Issues skipped | {J} |
| Issues merged by user during session | {U} |
| Total waves executed | {W} |

### All PRs Created

| Issue | PR | Wave | Review | Status |
|-------|-----|------|--------|--------|
| #12 — Add retry logic | [#45](url) | W1 | Approve | Ready to merge |
| #20 — LB data model | [#46](url) | W1→W2 | Approve | Ready to merge (fixed in W2) |
| #18 — Auth tests | [#47](url) | W1 | Request Changes | Needs attention |
| #21 — LB display | [#48](url) | W1 | Approve | Ready to merge |

### Needs Attention ({K} PRs)

These PRs were created but have unresolved issues after maximum retry attempts:

- **PR #47** (#18 — Auth tests): Review found auth token not validated. Attempted fix in W1 (2 attempts) and W2 — token validation conflicts with existing middleware pattern. See review comments for details.

### Blocked Issues ({B})

These issues could not be implemented after {W} waves. Each has a detailed comment on the GitHub issue:

- **#30** — Complex auth refactor: Requires changes to 3 interconnected systems. Each wave's approach created regressions in a different area. Recommend manual implementation with incremental PRs.

### Skipped Issues ({J})

- **#25**: No acceptance criteria — needs requirements
- **#35**: Labeled `blocked` — depends on #18

### Decomposition Log

- **#15** (complexity:high) → #20, #21, #22 — all completed in W1

### Wave-by-Wave Summary

| Wave | Attempted | Completed | Failed | New Issues |
|------|-----------|-----------|--------|------------|
| W1 | 8 | 5 | 3 | 3 (decomposition) |
| W2 | 4 | 2 | 2 | 0 |
| W3 | 2 | 1 | 1 | 0 |

### Next Steps

1. **Merge ready PRs:** `/batch-merge {PR_NUMS}`
2. **Review flagged PRs:** {list with specific issues to check}
3. **Address blocked issues:** {list with recommendations}
4. **New issues created:** {list of sub-issues or follow-up issues}
```

## Resume Strategy

This skill uses **GitHub state** for resume — no local state files. Same as `/autonomous-dev-flow`.

If a marathon session is interrupted (crash, timeout, user stops it), re-running with the same arguments will:

1. Query GitHub for existing session branches (matching `BRANCH_PREFIX`) and PRs referencing each issue
2. Detect which wave the session was in by counting attempts per issue
3. Skip issues that already have merged or clean open PRs
4. Resume from the first unfinished issue in the current wave

**Wave detection on resume:**
- Issues with 0 PRs → not yet attempted (Wave 1)
- Issues with 1 closed PR + no open PR → failed Wave 1, ready for Wave 2
- Issues with 2 closed PRs + no open PR → failed W1+W2, ready for Wave 3
- Issues with an open, approved PR → done, skip

This makes the skill **idempotent** — safe to re-run without duplicating work.

## Critical Rules

1. **NO attribution** — No Co-Authored-By, no "Generated with Claude", no AI mentions. Zero Attribution Policy.
2. **TDD is mandatory** — RED → GREEN → REFACTOR for every issue, every wave. No skipping tests.
3. **Branch from main every time** — Never stack branches. Fresh branch for every attempt, including retries.
4. **One confirmation point** — The initial marathon queue approval. Everything after — including all waves and retries — is fully autonomous.
5. **Never merge (unless merge:true)** — PRs accumulate for user review. Only `/batch-merge` at the end if explicitly requested.
6. **Clean up failed attempts** — Close old PRs and delete old branches before retrying. Don't leave orphaned PRs.
7. **Escalate strategy across waves** — Wave 1: standard approach. Wave 2: fresh context + address failures. Wave 3: alternative approach + scope reduction. Don't repeat the same failing approach.
8. **Converge, don't loop forever** — If a wave produces zero new completions, stop. Further waves won't help.
9. **Progress table after every issue** — The user may check in at any time. The table must show wave context.
10. **Respect the hard cap** — Max 30 issues across all waves (including sub-issues from decomposition). Refuse larger queues.
11. **Resume from GitHub state** — No local state files. Detect wave progress from closed/open PR counts per issue.
12. **Compose existing skills** — `/full-review` is called as-is. `/batch-merge` if `merge:true`. Don't reinvent their logic.
13. **Decompose in Wave 1 only** — High-complexity decomposition happens once. Retries work on the sub-issues, not the parent.
14. **Comment on blocked issues** — Every issue that fails all waves gets a detailed GitHub comment with what was tried and why it failed.
15. **Pre-Skill Checkpoint** — Re-read CLAUDE.md and skill files before running `/full-review` in every wave.
16. **Sync before every branch** — Always `git checkout main && git pull` before starting each issue in each wave.
17. **Morning summary is mandatory** — Even if interrupted, output the best summary possible with data collected so far.

## Customization Points

Lines and sections marked with `{{CUSTOMIZE}}` need repo-specific adaptation. These mirror `/autonomous-dev-flow` customizations:

- **Branch prefix** for session branches and resume detection
- **Branch naming convention**
- **Decomposition trigger label**
- **Test runner command**
- **Test file conventions**
- **Lint/typecheck commands**
- **PR test plan items**
- **Commit scope conventions**
- **Skip labels** beyond the defaults (`blocked`, `wontfix`)
<!-- skill-templates: tackle-issues 87ae770 2026-03-06 -->