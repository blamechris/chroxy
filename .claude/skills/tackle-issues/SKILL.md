---
description: "Run an unattended marathon session that works through GitHub issues across multiple waves until convergence — all issues are resolved, or all remaining..."
---

# /tackle-issues

Run an unattended marathon session that works through GitHub issues across multiple waves until convergence — all issues are resolved, or all remaining issues are genuinely blocked. Designed to maximize overnight/extended usage windows.

Composes `/autonomous-dev-flow` logic internally but adds multi-wave retry with escalating strategies, dynamic queue replenishment, and a morning summary.

## Arguments

- `$ARGUMENTS` - Issue source and options. Same as `/autonomous-dev-flow` plus marathon-specific options:
  - `label:from-review` (all open issues with this label)
  - `label:enhancement` (all open issues with this label)
  - `milestone:"v1.2"` (all open issues in milestone)
  - `#12 #15 #18` or `12 15 18` (specific issues by number)
  - `label:from-review max:10 sort:created-asc` (with options)
  - If empty, auto-detect: scan open issues sorted by complexity (low first, then medium, skip high)
  - Options: `max:N` (default 20, hard cap 30), `sort:created-asc` (default) or `sort:created-desc`
  - `waves:N` (default 3, max 4) — maximum retry waves
  - `merge:off` — disable the Unattended Merge Gate for this run; PRs accumulate for `/batch-merge`. Default is whatever Critical Rule 5 records for this repo; where rule 5 withholds merge authority this flag is redundant and `merge:on` is not honoured

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

### Session Boundaries and the Session Ledger

A marathon spans multiple *sessions*, not one endless context. Context re-reads dominate marathon cost, so wave boundaries double as session boundaries:

- **Session ledger + STATE header.** Keep an append-only session ledger (`autonomous-session-<date>.md` at the repo root — gitignored, never commit). Its top carries a rolling **STATE header** — a compact block (~2K tokens, hard-capped, rewritten in place) holding: current wave + position, queue pointer, open blockers, awaiting-user list, the last **verified** merge (PR + SHA), completions from the last wave, and a compact per-issue attempt table (issue# → attempts, last strategy tried, status) — the fields the Phase 4 convergence check reads instead of the full history. After a compaction or on a fresh session, the STATE header is the **only mandatory read**. The full history below it is consulted on-demand — allowed, and expected, for three purposes: the **Phase 4 convergence assessment**, **Phase 5 merge accounting**, and the **Phase 6 morning summary**. What is prohibited is the routine post-compaction top-to-bottom re-read as a ritual, not these accounting passes.
- **Per-wave merge table.** At each wave boundary, append a **"Merged this wave"** table (PR, issue, review, checks, merge SHA) to the ledger history. Phases 5–6 aggregate these tables across all waves — with per-wave session restarts, "merged by this session" means the whole marathon, never just the last wave.
- **Shed context at each wave boundary — mode-aware.** When a wave completes (after Phase 2 replenishment and the Phase 4 convergence check), write/refresh the handoff note (`$CLAUDE_BRIEF_DIR/../handoffs/chroxy-<date>-handoff.md`) and the durable queue (`scratchpad/autonomous-queue.json`), update the STATE header, then:
  - **Attended runs** — end the session; the user/orchestrator relaunches the next wave seeded from handoff note + queue + STATE header — never the full history.
  - **Unattended with a configured re-launcher** (none configured for this repo yet) — end the session; the re-launcher starts the next wave from the same seeds.
  - **Unattended with no re-launcher** — do **NOT** end the session (nothing would relaunch it; the marathon would silently halt after one wave): write the STATE header, then force/await a compaction at the wave boundary so the next wave starts lean, and continue.
  A restart (or boundary compaction) that halves context pays for itself within ~6–10 requests; the context-shedding goal holds in all three modes.
- **~150K main-thread context ceiling.** Past ~150K tokens of main-thread context, finish the current issue only, write the handoff, end the session mid-wave if necessary (unattended with no re-launcher: force a compaction instead of ending).
- **Per-wave cost circuit breaker.** At each wave boundary, check session cost. No per-session dollar budget is documented for Chroxy yet — until the owner sets one in `.claude/skill-profile.md`, treat continuous unattended work spanning many waves in one sitting as the trigger to checkpoint. Over budget → write the handoff and **stop and notify**; do not start the next wave. This breaker is the sole sanctioned exception to Critical Rule 4's "everything after is fully autonomous".
- **Verify state directly, never from a stale reading.** A monitor/watcher ending is **not** a verdict — assert PR/CI state with a direct query before recording it. And `mergeStateStatus` is only meaningful at the **current** head — re-check it after any push before acting on a BLOCKED/CLEAN reading.

`MASTER_LOG` (below) lives in the ledger; the STATE header summarizes it, and Resume Strategy re-derives ground truth from GitHub regardless.

### Phase 0: Marathon Setup

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
REPO_NAME=$(basename "$REPO")
SESSION_START=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

BRANCH_PREFIX="feat/"

BRANCH_PREFIX_RE="^(feat|fix|refactor|test)/"
```

Parse `$ARGUMENTS` — same as `/autonomous-dev-flow` but with higher defaults:
- `max` defaults to 20, hard cap 30
- `waves` defaults to 3, max 4
- self-merge follows Critical Rule 5 for this repo (`merge:off` can disable it for a run, but no flag can enable it where rule 5 withholds it)

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
| 2 | #15 — Add leaderboard | from-review | Decompose → sub-issues |
| 3 | #18 — Auth integration tests | enhancement | Implement |
| — | #16 — Refactor auth module | enhancement | Assigned to @user (skipped) |

**Mode:** Unattended marathon (up to {W} waves)
**Self-merge:** {per Critical Rule 5 — Unattended Merge Gate ON / off (`merge:off`) / withheld by this repo}
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
| Done | PR merged through the Unattended Merge Gate, or review-clean and left open where rule 5 withholds merge authority (or under `merge:off`) | No — skip in future waves |
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
  | jq --arg start "$SESSION_START" --arg prefix "$BRANCH_PREFIX_RE" \
    '[.[] | select(.mergedAt > $start) | select(.headRefName | test($prefix))]'
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

### Phase 5: Merge Accounting

Where Critical Rule 5 grants gated self-merge, merging happens **inline during waves** via the Unattended Merge Gate (see `unattended-merge`): a PR self-merges the moment /full-review is clean, ALL CI checks pass on the final commit, and ALL review threads are resolved — no `gh pr merge --auto`, no human pause, and the merge is verified `MERGED` before moving on. This unblocks dependent queue items mid-marathon. Where rule 5 withholds it, nothing merges inline and every finished PR is left open for review. This phase is accounting only, and it accounts for the **whole marathon, across every wave** — with per-wave session restarts, the last wave's memory is not the session's history:

1. Collect every PR merged by the session **across all waves** — aggregate the ledger's per-wave "Merged this wave" tables (an on-demand-allowed ledger read; see Session Boundaries), and each merged PR MUST appear as an entry in the Morning Summary's "Merged by this session" table
2. Any PR that passed review but failed a later gate (e.g. CI red at merge time) stays open — list it under Needs Attention with the failed gate named
3. If `merge:off` was specified, or Critical Rule 5 withholds merge authority for this repo, no self-merges happened; note in the summary:
```
**Ready to merge:** Run `/batch-merge {PR_NUMS}` to merge completed PRs.
```

### Phase 6: Morning Summary

Output a comprehensive summary designed for the user to read when they return. This is the primary deliverable of an overnight session. It covers the **entire marathon across all waves** — build it from the ledger's per-wave "Merged this wave" tables and full history (an on-demand-allowed read; see Session Boundaries), not from what the current session segment happens to remember.

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
| PRs merged by the session | {M} |
| PRs open (needs attention) | {K} |
| Issues decomposed | {D} → {S} sub-issues |
| Issues blocked (auto) | {B} |
| Issues skipped | {J} |
| Issues merged by user during session | {U} |
| Total waves executed | {W} |

### All PRs Created

| Issue | PR | Wave | Review | Status |
|-------|-----|------|--------|--------|
| #12 — Add retry logic | [#45](url) | W1 | Approve | Merged (`abc1234`) |
| #20 — LB data model | [#46](url) | W1→W2 | Approve | Merged (`def5678`, fixed in W2) |
| #18 — Auth tests | [#47](url) | W1 | Request Changes | Needs attention |
| #21 — LB display | [#48](url) | W1 | Approve | Merged (`9abcdef`) |

### Merged by this session

One entry per self-merged PR — MANDATORY (Unattended Merge Gate rule 6). Omit the section entirely where Critical Rule 5 withholds merge authority: an empty table reads as though a merge happened:

| PR | Issue | Review | Checks | Merge SHA |
|----|-------|--------|--------|-----------|
| [#45](url) | #12 — Add retry logic | Approve, 0 unresolved | all green | `abc1234` |
| [#46](url) | #20 — LB data model | Approve, 0 unresolved | all green | `def5678` |
| [#48](url) | #21 — LB display | Approve, 0 unresolved | all green | `9abcdef` |

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

- **#15** (large scope) → #20, #21, #22 — all completed in W1

### Wave-by-Wave Summary

| Wave | Attempted | Completed | Failed | New Issues |
|------|-----------|-----------|--------|------------|
| W1 | 8 | 5 | 3 | 3 (decomposition) |
| W2 | 4 | 2 | 2 | 0 |
| W3 | 2 | 1 | 1 | 0 |

### Next Steps

1. **Audit merged PRs:** review the "Merged by this session" entries (or `/batch-merge {PR_NUMS}` if `merge:off` left PRs open)
2. **Review flagged PRs:** {list with specific issues to check}
3. **Address blocked issues:** {list with recommendations}
4. **New issues created:** {list of sub-issues or follow-up issues}
```

## Resume Strategy

This skill resumes from **GitHub state** — GitHub remains the source of truth for issue/PR status, same as `/autonomous-dev-flow`. The session ledger carries the plan/decision record and the wave handoff note carries only session-boundary seeds (queue position, blockers, awaiting-user, last verified merge); both are disposable for resume purposes — everything they seed is re-derivable from GitHub.

If a marathon session is interrupted (crash, timeout, user stops it), re-running with the same arguments will:

1. Query GitHub for existing session branches (matching `BRANCH_PREFIX_RE`) and PRs referencing each issue
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
4. **One confirmation point** — The initial marathon queue approval. Everything after — including all waves and retries — is fully autonomous; the sole sanctioned stop besides convergence is the per-wave cost circuit breaker (see Session Boundaries and the Session Ledger).
5. **Self-merge authority for this repo** — Merge only through the Unattended Merge Gate — `/full-review` clean + ALL checks green on the final commit + ALL review threads resolved. No `gh pr merge --auto`, no protection overrides. `merge:off` disables self-merging for a single run (PRs accumulate for `/batch-merge`). Every self-merged PR MUST appear as an entry in the Morning Summary.
6. **Clean up failed attempts** — Close old PRs and delete old branches before retrying. Don't leave orphaned PRs.
7. **Escalate strategy across waves** — Wave 1: standard approach. Wave 2: fresh context + address failures. Wave 3: alternative approach + scope reduction. Don't repeat the same failing approach.
8. **Converge, don't loop forever** — If a wave produces zero new completions, stop. Further waves won't help.
9. **Progress table after every issue** — The user may check in at any time. The table must show wave context.
10. **Respect the hard cap** — Max 30 issues across all waves (including sub-issues from decomposition). Refuse larger queues.
11. **Resume from GitHub state** — GitHub is the source of truth for issue/PR status; detect wave progress from closed/open PR counts per issue. The ledger and handoff note are seeds, never a second source of truth.
12. **Compose existing skills** — `/full-review` is called as-is. Where Critical Rule 5 grants self-merge, the Unattended Merge Gate (`unattended-merge`) governs it; `/batch-merge` handles leftovers under `merge:off` or where rule 5 withholds merge authority. Don't reinvent their logic.
13. **Decompose in Wave 1 only** — High-complexity decomposition happens once. Retries work on the sub-issues, not the parent.
14. **Comment on blocked issues** — Every issue that fails all waves gets a detailed GitHub comment with what was tried and why it failed.
15. **Pre-Skill Checkpoint** — Re-read CLAUDE.md and skill files before running `/full-review` in every wave.
16. **Sync before every branch** — Always `git checkout main && git pull` before starting each issue in each wave.
17. **Morning summary is mandatory** — Even if interrupted, output the best summary possible with data collected so far.
18. **Wave boundaries are session boundaries** — Shed context at each wave boundary, mode-aware: end + restart fresh from handoff note + queue + the ledger's STATE header where the user or a configured re-launcher will relaunch; force a boundary compaction and continue where nothing would. Respect the ~150K main-thread context ceiling and the per-wave cost circuit breaker (see Session Boundaries and the Session Ledger).
19. **STATE header over full re-reads** — After compaction, read only the ledger's STATE header; the full ledger history is on-demand reference, never a mandatory re-read.
