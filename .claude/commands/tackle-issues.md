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

Preserve a durable run record: run ID, selected mode and mission, observable acceptance, authority and explicit holds, owned branch/worktree, current step, queue pointer, last verified merge, attempts including pre-PR failures, consumed smoke/review corrections, and each limit with its wave/session/run scope. Record an attempt or correction before starting it. Resume the same attempt without a second start; a new context does not reset counters. Missing allowance is unknown, not zero: recover the record before governed work, and continue only independent work with known authority and allowance. GitHub is authoritative for issue/PR facts, but cannot reconstruct user intent or consumed attempts.

Keep `autonomous-session-<date>.md` gitignored with a compact (~2K-token) STATE header and append-only history, plus `scratchpad/autonomous-queue.json`. Append a verified per-wave merge table (PR, issue, head, review, checks, merge SHA); account for the whole run, not just this context. A watcher ending is not a verdict; re-query the current head.

Wave boundaries are durable checkpoints in PRIME, not automatic session ends. Update STATE, queue and the external seed; continue independent authorized work through supported host auto-compaction. No 150K ceiling, compaction count, owner presence, configured launcher or saved seed alone ends unfinished PRIME work. A fresh session requires an explicit pause/restart, an actual host limit, or an authorized successor whose accepted task/session ID is recorded before ending. Never invent compaction commands. NORMAL ends after its selected package is delivered, verified and recorded; a held PR remains ready/open with delivery incomplete.

Write the external handoff through `python3 ~/.claude/scripts/session-seed.py write` to `$CLAUDE_HANDOFF_DIR/NEXT-<scope>.md` (default `~/Obsidian/no-it-all/handoffs/`). Preserve intent, holds and cumulative accounting; a seed is not proof that another session started. Honor read-only instructions and destination restrictions; report a checkpoint without writing when writes are withheld.

**Cost circuit breaker — PAUSED, track-only.** The per-session budget remains **none**, paused by the user on 2026-09-24 in `.claude/skill-profile.md`. At every boundary record session spend via `python3 ~/.claude/scripts/usage-benchmark-row.py` (print-only mid-session; append once at session end), and the weekly meter via `python3 ~/.claude/scripts/usage-pace.py --oneline`. Never stop on spend while paused or resurrect $150. Preserve any explicit reinstated limit with its scope and consumed usage; stop affected work at exhaustion. Weekly pacing does not replace session accounting. Explicit holds, retry limits and host restrictions still apply.

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

Selected marathon queue (within the existing authorization).
```

Use the existing authorization; ask only for missing scope or a reserved decision. Explicit holds and remaining allowances apply to every wave.

For a new run only, initialize tracking; on resume restore it from the durable run record:

```
MASTER_LOG = []   # Tracks every attempt: {issue, wave, branch, pr, verdict, error}
WAVE_NUM = 1
```

### Phase 1: Execute Wave

For each issue in the current wave's queue, run the full `/autonomous-dev-flow` Phases 1-6 cycle:

1. **Sync Check** — new attempt: verified main in an isolated checkout; interrupted attempt: restore its owned branch and unfinished step
2. **Issue Understanding** — Read issue, identify files, plan approach
3. **Implementation (TDD)** — record the attempt before starting; new branch only for a new attempt, then RED-GREEN-REFACTOR
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
| Done | PR verified merged through the gate | No |
| Ready/open | Review-clean but merge held (including `merge:off`); delivery incomplete | Re-evaluate only when authority/prerequisites change |
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
3. **Simplify scope** — implement a bounded version that retains every agreed acceptance criterion. Defer only verified nonblocking behavior outside promised acceptance, with evidence and a follow-up issue.
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

After each wave, reassess remaining scope, dependencies, evidence and strategy. Zero new completions is not automatic convergence: try a concrete different approach within remaining allowances. Stop an exhausted item and continue independent authorized work. End only when selected work is complete, every remaining item has an evidenced dependency/exhausted allowance, the user pauses, or the host cannot continue. Do not reset wave/attempt caps at a context boundary.

**Old-debt quota (enforced here, declared in `/prime-directive`).** A wave's completions are not
interchangeable. Two rules apply when building the next wave queue (2e) and when reporting a
wave's result:

- **At least 2 issues per wave must predate that wave by 30+ days.** Select them explicitly in
  2e rather than hoping the replenishment scan surfaces them — it sorts by tractability, not age,
  which is why old debt never gets picked. Derive age from `createdAt`, not `updatedAt`:
  measured on this repo, 72.4% of open issues have `updatedAt == createdAt`, so `updatedAt` is
  not an engagement signal.
- **A `from-review` issue created during the current session is ineligible** to count toward a
  wave's completions. It still gets worked and still gets closed — it just does not satisfy the
  quota, because a pipeline closing its own same-generation output is the failure this exists to
  prevent. Measured over the 30 days to 2026-09-12: 208 of 209 closes were issues created inside
  that same window, exactly one touched anything older, and 122 of the 123 issues open at the
  start were still open at the end.

**When fewer than 2 eligible issues remain, take all of them.** The quota is a floor on effort,
never a blocker, and **never a convergence condition** — missing it does not stop a session.
Report both numbers in the wave table below (`eligible` and `taken`) so a wave that took 0
because none were eligible is distinguishable from one that took 0 because nobody looked. Those
two states are identical in every metric that counts only completions, which is exactly how this
went unnoticed for 30 days.

```markdown
## Convergence Check — Wave {W} Complete

| Metric | Value |
|--------|-------|
| Issues attempted this wave | {N} |
| New completions this wave | {M} |
| Remaining retries | {K} |
| New issues discovered | {J} |

**Decision:** {Continue to Wave W+1 / Converged — moving to summary}
**Reason:** {e.g., "3 new completions, 2 retries remaining — continuing" or "0 new completions; alternate approach remains within allowance — continuing"}
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

Preserve a durable run record: run ID, selected mode and mission, observable acceptance, authority and explicit holds, owned branch/worktree, current step, queue pointer, last verified merge, attempts including pre-PR failures, consumed smoke/review corrections, and each limit with its wave/session/run scope. Record an attempt or correction before starting it. Resume the same attempt without a second start; a new context does not reset counters. Missing allowance is unknown, not zero: recover the record before governed work, and continue only independent work with known authority and allowance. GitHub is authoritative for issue/PR facts, but cannot reconstruct user intent or consumed attempts.

Read compact STATE and only needed history, then reconcile current issue/PR/check facts. Verify ownership and restore the recorded branch/worktree and unfinished step. Zero PRs is not evidence of zero attempts; a clean open PR is ready/open, not merged delivery. Do not clean, switch or delete another run's branch or dirty work. Re-evaluate recorded prerequisites when supplied, retain consumed limits, and continue the next eligible independent item. A fresh attempt starts from current main only after the prior attempt is durably accounted for.

## Critical Rules

1. **NO attribution** — No Co-Authored-By, no "Generated with Claude", no AI mentions. Zero Attribution Policy.
2. **TDD is mandatory** — RED → GREEN → REFACTOR for every issue, every wave. No skipping tests.
3. **Own the branch** — new attempts branch from verified main in isolation; interrupted attempts restore their recorded owned worktree and step. Assert `SESSION_BRANCH` before editing and staging; stage only named files.
4. **Respect existing authorization** — continue within mission and remaining allowances; explicit pauses, merge holds and actual owner/host restrictions remain binding. Owner presence is not a mode switch.
5. **Self-merge authority for this repo** — selected implementation includes gated synchronous squash merge in NORMAL and PRIME: clean independent review, all CI green on the final commit, all threads resolved and actual repository approvals satisfied; verify `MERGED` and record the SHA. No `--auto`, `--admin` or protection bypass. Explicit user merge holds, draft-only/review-only requests, `merge:off` and host restrictions take precedence; a worker cannot inherit coordinator authority beyond its brief.
6. **Clean up failed attempts** — Close old PRs and delete old branches before retrying. Don't leave orphaned PRs.
7. **Escalate strategy across waves** — Wave 1: standard approach. Wave 2: fresh context + address failures. Wave 3: alternative approach + scope reduction. Don't repeat the same failing approach.
8. **Reassess without resetting limits** — zero completions prompts a new supported strategy within remaining allowance, not an automatic stop; exhausted items remain blocked while independent work proceeds.
9. **Progress table after every issue** — The user may check in at any time. The table must show wave context.
10. **Respect the hard cap** — Max 30 issues across all waves (including sub-issues from decomposition). Refuse larger queues.
11. **Resume from durable run state plus current GitHub facts** — preserve intent, authority, attempts and scoped consumption; never infer a fresh allowance from no PRs or an open PR's cleanliness.
12. **Compose existing skills** — `/full-review` is called as-is. Where Critical Rule 5 grants self-merge, the Unattended Merge Gate (`unattended-merge`) governs it; `/batch-merge` handles leftovers under `merge:off` or where rule 5 withholds merge authority. Don't reinvent their logic.
13. **Decompose in Wave 1 only** — High-complexity decomposition happens once. Retries work on the sub-issues, not the parent.
14. **Comment on blocked issues** — Every issue that fails all waves gets a detailed GitHub comment with what was tried and why it failed.
15. **Pre-Skill Checkpoint** — Re-read CLAUDE.md and skill files before running `/full-review` in every wave.
16. **Sync for new attempts only** — use verified main in an isolated checkout; restore an interrupted attempt without resetting its branch, state or limits.
17. **Morning summary is mandatory** — Even if interrupted, output the best summary possible with data collected so far.
18. **Wave boundaries are checkpoints** — preserve STATE, holds and consumed allowances, then continue PRIME through supported context management; end only at the real boundaries defined above.
19. **STATE header over full re-reads** — After compaction, read only the ledger's STATE header; the full ledger history is on-demand reference, never a mandatory re-read.

<!-- skill-templates: tackle-issues 8196307 2026-07-30 -->
