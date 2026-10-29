---
description: "Advance a delegated outcome through bounded issue waves, or clear an explicitly selected backlog."
---

# /tackle-issues

Advance a delegated outcome through bounded issue waves, or clear an explicitly selected backlog. Convergence follows observable acceptance and genuine dependencies, not the number of easy issues closed.

Composes `/autonomous-dev-flow` logic internally but adds multi-wave retry with escalating strategies, dynamic queue replenishment, and a morning summary.

## Arguments

- `$ARGUMENTS` - Issue source and options. Same as `/autonomous-dev-flow` plus marathon-specific options:
  - `label:ready-to-build` (all open issues with this label)
  - `milestone:"v1.2"` (all open issues in milestone)
  - `#12 #15 #18` or `12 15 18` (specific issues by number)
  - `label:ready-to-build max:10 sort:created-asc` (with options)
  - If empty, select issues needed for the delegated outcome and its observable acceptance criteria; do not substitute easy cleanup for the outcome
  - `mode:backlog-clear` — clear the explicitly selected backlog rather than target a product milestone; use only when requested
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

A marathon preserves one authorized run across checkpoints, compactions and any necessary sessions. Wave boundaries are checkpoints; they do not force a session restart. Continue a prime-directive run within its mission and original limits. A normal development invocation stops after its selected feature/work package is delivered and recorded, using `/session-lifecycle` for the seed and concise status; owner presence never changes the recorded mode:

- **Session ledger + STATE header.** Keep an append-only session ledger (`autonomous-session-<date>.md` at repo root — gitignored, never commit). Its top carries a rolling **STATE header** — a compact block (~2K tokens, hard-capped, rewritten in place) holding: stable run identity, execution mode + selected work package, delegated outcome + observable acceptance, usable state + remaining gap, authority, configured limits with their scope (wave/session/run) + cumulative consumption, current wave + position, queue pointer, open blockers, awaiting-user list, the last **verified** merge (PR + SHA), completions from the last wave, and a compact per-issue attempt table (issue# → attempts including failures before a PR exists, last strategy tried, status). Record attempts when they start and reconcile actual usage before another attempt or handoff. After a compaction or on a fresh session, the STATE header is the **only mandatory read**; preserve its consumption across session identifiers. The full history below it is consulted on-demand — allowed, and expected, for three purposes: the **Phase 4 convergence assessment**, **Phase 5 merge accounting**, and the **Phase 6 morning summary**. What is prohibited is the routine post-compaction top-to-bottom re-read as a ritual, not these accounting passes.
- **Per-wave merge table.** At each wave boundary, append a **"Merged this wave"** table (PR, issue, review, checks, merge SHA) to the ledger history. Phases 5–6 aggregate these tables across all waves — across any session restarts, "merged by this session" means the whole marathon, never just the last wave.
- **Checkpoint at each wave boundary — preserve the run mode.** When a wave completes (after Phase 2 replenishment and the Phase 4 convergence check), write this scope's handoff seed (`$CLAUDE_HANDOFF_DIR/NEXT-<scope>.md`, default dir `~/Obsidian/no-it-all/handoffs/`), refresh the durable queue (`scratchpad/autonomous-queue.json`), update the STATE header, then:
  - **Owner-requested pause/restart** — end with the verified seed path and remaining work. A user watching the session is not itself a pause request.
  - **Current host continuation available** — keep working using supported auto-compaction/context management; reload `/prime-directive` after compaction when it owns the run. A completed wave or second compaction is not a forced restart.
  - **Fresh session needed and authorized re-launcher available** (none configured for this repo) — submit the handoff seed + queue + STATE header — never the full history — and verify acceptance with a task/session identifier before ending. A configured launcher or saved seed is not proof the next run was accepted.
  - **No accepted re-launch** — continue using supported host continuation/compaction where available. If the host cannot continue, report that capability limit and exact restart action; do not claim background work or invent an unsupported command.
  Carry outcome, acceptance criteria, authority and consumed retry/budget limits across the boundary. Measure handoff and reconstruction cost as well as context cost before claiming savings.
- **The wave seed is written outside every worktree, and it archives rather than overwrites.** Both halves come from `/session-lifecycle` End step 1 and neither is optional:

  Execute the complete `/session-lifecycle` End flow for this checkpoint. It selects one
  next task with an executor and observable acceptance, fills the STATE/TL;DR context,
  records the boundary reason, carries unresolved decisions and the pulse snapshot, and
  writes/verifies the seed through its canonical writer. Do not substitute a partial raw
  writer call or another skeleton. Preserve the recorded mode: a prime checkpoint continues
  the already authorized mission using the continuation rules above; it does not grant new
  authority or turn a wave boundary into a stop.

  **① The path.** `$CLAUDE_HANDOFF_DIR/NEXT-<scope>.md`, where `<scope>` is the main worktree's directory basename — the same key from every wave's worktree, so a marathon's waves all read and write one seed. Never inside a wave's worktree: `git worktree remove --force` deletes untracked files silently, and a wave that loses its seed has not shed context, it has dropped the marathon's continuity. Outside every workspace there is nothing to commit, nothing to push, and nothing to gate teardown on.

  **② The header, and archive-on-collide.** The lifecycle's writer writes the frontmatter End step 1 prescribes — `type`, `date` (full UTC timestamp), `scope`, `session`, `picks_up_at`, `sensitivity`. If the canonical file already exists carrying a **different** `session:` — another session ended on this repo while the marathon was running — it renames that one to `NEXT-<scope>.<UTC>-<sid>.md` before writing, and a failure to archive is a REFUSE that writes nothing. Successive waves of one marathon share a session id only within a session; across a restart the new session archives the previous wave's seed, which is the intended record.

  **Do not hand-write the seed or reimplement any of this at the boundary.** The scope key, the id, the archive and the proof are one implementation with its own test suite; a wave that writes its own version is the drift that cost five review rounds.
- **No forced restart or numeric context ceiling.** A run may span waves and supported compactions in the same session; neither 150K nor a compaction count determines completion. Route heavy output through subagents. If an item balloons, finish or park it within the attempt limit and continue independent work. Only test a lower compaction threshold through an explicitly configured, supported host setting; do not silently change it.
- **Per-wave cost circuit breaker.** At each wave boundary, compare measured cost with the configured limit and its scope (Chroxy cost profile: per-session budget none — PAUSED 2026-09-24, track-only. At boundaries record session spend with `python3 ~/.claude/scripts/usage-benchmark-row.py` (print-only mid-session; append once at session end) and weekly pace with `python3 ~/.claude/scripts/usage-pace.py --oneline`. Never stop on spend while paused or resurrect $150. Honor explicit reinstated scoped limits, retry caps and host restrictions.). Over budget → write the handoff and **stop and notify**; do not start the next wave. Preserve run limits across restarts; missing measurements are unknown, not zero, and do not justify an invented limit.
- **Verify state directly, never from a stale reading.** A monitor/watcher ending is **not** a verdict — assert PR/CI state with a direct query before recording it. And `mergeStateStatus` is only meaningful at the **current** head — re-check it after any push before acting on a BLOCKED/CLEAN reading.

`MASTER_LOG` (below) lives in the ledger; the STATE header summarizes it. Resume Strategy restores run state from that record and reconciles issue/PR facts against GitHub.

### Phase 0: Marathon Setup

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
REPO_NAME=$(basename "$REPO")
SESSION_START=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# This skill creates ${BRANCH_PREFIX}${ISSUE_NUM}-${SLUG} with one prefix.
BRANCH_PREFIX="feat/"

# Merge/resume scans must recognize every prefix a session branch may carry.
BRANCH_PREFIX_RE="^(feat|fix|refactor|test)/"
```

Parse `$ARGUMENTS` — same as `/autonomous-dev-flow` but with higher defaults:
- `max` defaults to 20, hard cap 30
- `waves` defaults to 3, max 4
- self-merge follows Critical Rule 5 for this repo (`merge:off` can disable it for a run, but no flag can enable it where rule 5 withholds it)

Build the initial queue using the same logic as `/autonomous-dev-flow` Phase 0:
- Fetch issues by label, milestone, explicit list, or auto-detect
- Filter out assigned issues
- Record the execution mode inherited from the caller, selected work package, user's outcome, observable acceptance and current usable state. Order by the gap each item closes and necessary dependencies, then apply the cap; in explicit backlog-clear mode use the selected backlog and requested sort.
- Keep review-generated cleanup outside the active queue unless it is needed for acceptance or belongs to the explicitly selected backlog.

**Validate:**
- At least 1 issue must be open and unassigned
- If 0 issues match, recheck acceptance. A missing tracker item is not proof the outcome is complete: create a bounded in-scope item where authorized, or report the actual missing dependency.

Display the marathon queue:

```markdown
## Marathon Session — {N} issues, up to {W} waves

| # | Issue | Labels | Action |
|---|-------|--------|--------|
| 1 | #12 — Add retry logic | enhancement | Implement |
| 2 | #15 — Add leaderboard | complexity:high | Decompose → sub-issues |
| 3 | #18 — Auth integration tests | testing | Implement |
| — | #16 — Refactor auth module | enhancement | Assigned to @user (skipped) |

**Mode:** {recorded normal-development work package / prime-directive mission}, up to {W} waves
**Self-merge:** {per Critical Rule 5 — Unattended Merge Gate ON / off (`merge:off`) / withheld by this repo}
**Estimated scope:** {N} issues × {W} max waves

**Authorization:** {existing delegated scope / exact unresolved authority needed}
```

Use the user's existing authorization; do not ask for queue approval again when this run is already authorized. If authority or scope is genuinely missing, ask only for that and continue independent authorized preparation. Routine decisions and retries are autonomous within the stated scope and caps.

For a new run, establish a stable run identity and initialize tracking. On resume, restore the existing run's ledger and STATE header using Resume Strategy; do not run this initialization over prior attempts or consumption:

```
MASTER_LOG = []   # Tracks every attempt: {issue, wave, branch, pr, verdict, error}
WAVE_NUM = 1
```

### Phase 1: Execute Wave

For each issue in the current wave's queue, run the full `/autonomous-dev-flow` Phases 1-6 cycle:

For an interrupted attempt, first restore its verified branch/worktree and consumption from run state. Resume its unfinished step without creating another branch or counting the same attempt twice. The fresh-main and new-branch steps below apply to new attempts; another run's branch or unverified dirty work remains outside this run's ownership.

1. **Sync Check** — `git checkout main && git pull origin main`
2. **Scope, investigate and plan** — Establish acceptance; inspect shared classes/helpers and analogous flows for SOLID/DRY reuse before adding logic; record a proportional design, implementation plan and validation approach
3. **Delegate implementation (TDD)** — Give the plan to a suitable available model under project policy with explicit ownership/worktree isolation; retain coordinator responsibility through delivery. If delegation is unavailable, record the limitation and use an authorized local fallback. Branch, record it as `SESSION_BRANCH`, re-assert it against `git branch --show-current` immediately before the first edit, then RED-GREEN-REFACTOR
4. **Commit and PR** — Re-assert `SESSION_BRANCH`, `git status --short`, stage the changed files **by name** (never `-A` / `.` / `-u` / a bare directory), commit, push, create PR
5. **Full Review** — `/full-review` with pre-skill checkpoint, posted Copilot comments and summaries, and an independent review subagent; fix blocking findings and file only evidenced nonblocking follow-ups
6. **Gate, merge and record** — Under Critical Rule 5, verify review, all final-head CI and resolved threads, synchronously merge, verify `MERGED` into the intended base branch, and update the ledger before continuing. For dependent PRs, merge prerequisites first, refresh dependents and recheck their gates. Record open/held PRs as incomplete delivery with their precise restriction.

**Key differences from standalone `/autonomous-dev-flow`:**

- **Two fix attempts per issue per wave** (same as original). If still failing after 2 attempts, mark as `retry` instead of just `flagged`.
- **Track the failure reason** in `MASTER_LOG` — this informs the retry strategy in later waves.
- **High-complexity decomposition** happens in Wave 1 only. Sub-issues created during decomposition are added to the current wave's queue (not deferred to Wave 2).
- **Fallback before a blocker:** if an authorized fallback is verified to preserve safety, correctness, required runtime/cost constraints and essential capability, use it, file the underlying problem and continue without an owner pause. Otherwise block only the affected item with its evidence and advance independent work. Do not pass a blocking defect or missing promised acceptance behavior through review merely by filing it or estimating >15 minutes; fix, remove or verify containment before merge. Minor findings may be filed when evidence shows acceptance, correctness and safety are unaffected; size or avoiding another CI cycle alone is insufficient.

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
| Done | PR verified merged through the Unattended Merge Gate and delivery recorded | No — skip in future waves |
| Ready / held | Review-clean PR deliberately left open under an explicit merge hold or actual restriction | No duplicate implementation; preserve unfinished delivery and resume when the restriction clears |
| Retry | Tests failing or review found blocking issues | Yes — re-attempt |
| Flagged | 2 fix attempts failed in a wave | Yes — with different strategy |
| Skipped | Specific unavailable access/authority/QA or exhausted approaches; no verified adequate fallback | Re-evaluate when the recorded dependency changes; resume within remaining limits once it is satisfied. Exhausted limits remain exhausted. |
| Decomposed | Broken into sub-issues | No — sub-issues are in queue |

When an owner supplies a recorded prerequisite, re-evaluate that item from `MASTER_LOG` and restore it to the actionable queue without waiting for a new issue or a new delegation. Preserve its attempts, wave position and scoped consumption. An unchanged dependency or exhausted allowance keeps it blocked while independent work proceeds.

#### 2b. Scan for New Issues

Check for issues that appeared since the session started (from decomposition or external creation):

```bash
# Sub-issues created during decomposition
gh issue list --state open --json number,title,labels,assignees,createdAt --limit 50 \
  | jq --arg start "$SESSION_START" '[.[] | select(.createdAt > $start)]'

# Also re-scan the original label/milestone for newly added issues
# (user may have labeled new issues while session was running)
```

Add new unassigned issues only if they are necessary for the delegated outcome or match the explicitly selected backlog, and are not already in `MASTER_LOG`. Discovery during a review does not itself make work a priority.

#### 2c. Check for User Merges

```bash
gh pr list --state merged --json number,headRefName,mergedAt --limit 30 \
  | jq --arg start "$SESSION_START" --arg prefix "$BRANCH_PREFIX_RE" \
    '[.[] | select(.mergedAt > $start) | select(.headRefName | test($prefix))]'
```

Note merged PRs. If a merged PR's issue is in the retry queue, remove it — the user handled it.

#### 2d. Clean Up Failed Branches

For a failed attempt intentionally being replaced in Wave 2+, close its superseded PR and delete its stale branch only after preserving any useful work. Exclude interrupted or prerequisite-blocked attempts that will resume: retain their verified branch/PR and consumed state when the prerequisite arrives. Requeueing alone does not authorize this cleanup.

```bash
# Only for each failed attempt intentionally being replaced:
# Close the old PR (it had issues)
gh pr close ${OLD_PR_NUM} --comment "Closing for retry in Wave ${NEXT_WAVE} — previous attempt had: ${FAILURE_REASON}"

# Delete the old remote branch
git push origin --delete ${OLD_BRANCH}
```

Replacement attempts start from latest main; resumed attempts keep their verified existing work and allowance.

#### 2e. Build Next Wave Queue

Combine:
1. Retry candidates (issues that failed in previous wave)
2. Previously blocked items whose prerequisite is now satisfied and whose allowance remains
3. New issues from replenishment scan
4. Remaining issues not yet attempted (if queue was large)

Cap at `max` setting. Order by acceptance dependencies and remaining user value; context already spent is not a reason to prefer a retry over a necessary feature.

If the next wave queue is empty, run Phase 4's acceptance and dependency check first. An untracked acceptance gap becomes a bounded in-scope item while attempt, wave and budget limits remain; an empty queue alone is not completion. Produce the Morning Summary only when Phase 4 establishes a real ending condition.

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
3. **Simplify implementation** — retain the agreed acceptance criteria. Defer evidenced low-impact nonblocking findings, optional/unrelated work or an underlying problem contained by a verified adequate fallback; blocking defects and required acceptance edge cases stay blocking.
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

**Zero new completions means reassess**, not automatically stop. Check acceptance evidence, failed approaches, dependencies and remaining authorized work. Continue when there is a concrete untried approach or independently useful item within the configured wave/attempt/budget limits; do not repeat an unchanged failing strategy or reset counters by restarting the session.

End the bounded run when acceptance is demonstrated (or the explicitly selected backlog converges), all remaining relevant work genuinely depends on unavailable QA/access/authority with no adequate verified fallback, or its wave/retry/budget cap is exhausted. A host continuation limit is a separate execution state. Name the actual reason and any unfinished outcome; `Done` PRs, decomposition and an empty queue do not alone prove delivery.

**Progress evidence:** record which acceptance gap narrowed as well as issue completions. A necessary implementation or verified experiment can advance the outcome without closing an issue.

```markdown
## Convergence Check — Wave {W} Complete

| Metric | Value |
|--------|-------|
| Issues attempted this wave | {N} |
| New completions this wave | {M} |
| Remaining retries | {K} |
| New issues discovered | {J} |

**Decision:** {Continue to Wave W+1 / Complete / QA or access needed / Retry or budget cap / Host continuation limit}
**Reason:** {acceptance evidence or specific constraint; if continuing, the different approach and remaining attempt budget}
```

### Phase 5: Merge Accounting

Where Critical Rule 5 grants gated self-merge, merging happens **inline during waves** via the Unattended Merge Gate (see `unattended-merge`): a PR self-merges the moment /full-review is clean, ALL CI checks pass on the final commit, and ALL review threads are resolved — no `gh pr merge --auto`, no human pause, and the merge is verified `MERGED` before moving on. This unblocks dependent queue items mid-marathon. Where rule 5 withholds it, nothing merges inline and every finished PR is left open for review. This phase is accounting only, and it accounts for the **whole marathon, across every wave** — across any session restarts, the last wave's memory is not the run's history:

1. Collect every PR merged by the session **across all waves** — aggregate the ledger's per-wave "Merged this wave" tables (an on-demand-allowed ledger read; see Session Boundaries), and each merged PR MUST appear as an entry in the Morning Summary's "Merged by this session" table
2. Any PR that passed review but failed a later gate (e.g. CI red at merge time) stays open — list it under Needs Attention with the failed gate named
3. For ready/open PRs under `merge:off` or a restriction in Critical Rule 5, name the precise hold and who can resolve it. Preserve any earlier verified merges in the report. Use `/batch-merge {PR_NUMS}` only after its caller has authority; a clean PR does not override a hold.

### Phase 6: Morning Summary

Before a wait-only handoff, advance each independently actionable slice through its authorized review and delivery gates within the remaining limits. Name the actual dependency for every slice left waiting. An owner supplying a prerequisite enables the agent to resume already-delegated execution; assign the owner only the reserved action and retain the agent's next step in the handoff.

Lead with the delegated outcome, current usable result, remaining acceptance gap and actual continuation state. Name the accepted next task/session if one exists, or the precise QA/access action or exhausted limit. Do not turn an optional follow-up into a user decision, and do not claim that a seed alone scheduled continuation.

Write the following detailed accounting into the ledger or linked report, covering the **entire marathon across all waves**. Build it from the ledger's per-wave "Merged this wave" tables and history (an on-demand-allowed read; see Session Boundaries), not just the current segment's memory. Keep the chat ending concise and use `/session-lifecycle`'s uniform status and next-action format, linking the report rather than pasting every table.

```markdown
## Marathon Session Complete

**Started:** {SESSION_START}
**Duration:** {elapsed time}
**Waves completed:** {W} of {MAX_WAVES}
**Convergence:** {verified acceptance or genuine dependency/reached limit; zero completions alone is not an ending reason}

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

One entry per verified self-merged PR — MANDATORY (Unattended Merge Gate rule 6). Omit the section only when no self-merges were verified; a later hold does not erase earlier merges:

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

- **#15** (complexity:high) → #20, #21, #22 — all completed in W1

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

This skill resumes from **GitHub state** for issue/PR status. The ledger and handoff preserve the user's outcome, acceptance, authority, decisions and consumed limits alongside queue position and last verified merge; those facts are not all reconstructible from issue status. Re-derive repository state while preserving the delegated intent and run caps.

If a marathon session is interrupted (crash, timeout, user stops it), re-running with the same arguments will:

1. Restore the stable run identity, outcome, acceptance, authority, wave position, per-issue attempts and consumed limits from the durable STATE header. Keep failures that occurred before a PR was created.
2. Query GitHub for existing session branches (matching `BRANCH_PREFIX_RE`) and PRs referencing each issue; reconcile repository state without reducing recorded consumption. PR counts alone do not establish attempts or wave position.
3. Verify merged results against acceptance. Retain open PRs and re-check their current-head review, CI and remaining delivery gates; an approved open PR may still need authorized work. Avoid duplicate implementation without classifying unfinished delivery as done.
4. Resume the next actionable item within the recorded limits, using the escalation appropriate to its actual attempt history. A new session identifier does not begin a new run allowance.

**Missing or conflicting history:** recover it from available durable records. Zero PRs does not mean zero attempts; missing usage is unknown, not zero. If remaining allowance cannot be established, pause work governed by that uncertain limit and name the accounting dependency. Continue independent work only where its authority and remaining allowance are known. Do not reset limits to reconcile a mismatch.

This makes the skill **idempotent** — safe to re-run without duplicating work.

## Critical Rules

1. **NO attribution** — No Co-Authored-By, no "Generated with Claude", no AI mentions. Zero Attribution Policy.
2. **TDD is mandatory** — RED → GREEN → REFACTOR for every issue, every wave. No skipping tests.
3. **Branch from main for new attempts** — Never stack branches. A replacement retry starts fresh from current main; an interrupted attempt resumes its verified owned branch and saved allowance.
4. **Respect existing authorization** — No repeat queue approval or routine decision pause. Continue all waves within scope and caps; preserve owner-reserved actions, genuine dependencies and the verified continuation contract.
5. **Self-merge authority for this repo** — Delegated implementation includes gated synchronous merge and ledger updates in both normal and prime-directive mode. Merge only through the Unattended Merge Gate — /full-review clean + ALL checks green on the final commit + ALL review threads resolved; verify `MERGED` into the intended base branch. No `gh pr merge --auto`, no GitHub auto-merge, no protection overrides, no repeated routine merge approval. Only selected work and necessary prerequisites are covered; unrelated PRs are outside scope. Honor explicit user merge holds and actual repository/host restrictions. Honor `merge:off` as an explicit run hold. Every self-merged PR MUST appear as an entry in the Morning Summary.
6. **Clean up replaced failed attempts** — Follow Phase 2d: preserve useful work, then close the superseded PR and delete its stale branch. Retain interrupted or prerequisite-blocked attempts that will resume; requeueing alone does not authorize cleanup.
7. **Escalate strategy across waves** — Wave 1: standard approach. Wave 2: fresh context + address failures. Wave 3: alternative approach + scope reduction. Don't repeat the same failing approach.
8. **Converge, don't loop forever** — Zero completions triggers a bounded reassessment, not automatic failure. Keep the configured wave/attempt/budget caps, preserve them across restarts, and do not repeat a failing approach unchanged.
9. **Progress table after every issue** — The user may check in at any time. The table must show wave context.
10. **Respect the hard cap** — Max 30 issues across all waves (including sub-issues from decomposition). Refuse larger queues.
11. **Resume from durable run state and GitHub** — The ledger preserves run identity, intent, authority, attempts and consumed limits; GitHub supplies current issue/PR facts. Reconcile both as Resume Strategy requires. Missing PRs or a new session never reset consumption.
12. **Compose existing skills** — `/full-review` is called as-is. Where Critical Rule 5 grants self-merge, the Unattended Merge Gate (`unattended-merge`) governs it; `/batch-merge` handles leftovers under `merge:off` or where rule 5 withholds merge authority. Don't reinvent their logic.
13. **Decompose in Wave 1 only** — High-complexity decomposition happens once. Retries work on the sub-issues, not the parent.
14. **Comment on blocked issues** — Every issue that fails all waves gets a detailed GitHub comment with what was tried and why it failed.
15. **Pre-Skill Checkpoint** — Re-read CLAUDE.md and skill files before running `/full-review` in every wave.
16. **Sync before every branch** — Always `git checkout main && git pull` before starting each issue in each wave.
17. **Morning summary is mandatory** — Even if interrupted, output the best summary possible with data collected so far.
18. **Wave boundaries use the verified continuation contract** — Preserve the handoff + queue + STATE header, then continue prime-directive using supported host compaction within its mission and original limits. Waves and compaction counts never force a restart. If a fresh session is needed, verify the authorized next run was accepted before ending while work remains; a configured launcher, saved seed or watching owner is insufficient. Normal development ends after its selected work package is delivered and recorded. Preserve actual pause requests, dependencies and limit stops; report genuine host limitations and never require an unsupported compaction command.
19. **STATE header over full re-reads** — After compaction, read only the ledger's STATE header; the full ledger history is on-demand reference, never a mandatory re-read.
20. **Explicit-path staging** — `git status --short`, then `git add` the changed files by name. Never `git add -A`, `git add .`, `git add -u`, `git add <dir>/`, or `git commit -a`. A marathon runs for hours in a working copy other sessions also use, so a bulk add commits their files into your PR. `-u` is not the safe one: it restages tracked files a clean/smudge filter rewrote behind your back, which is how a tracked 21KB `.docx` was committed as a git-lfs pointer.
21. **Assert the branch before you write** — record each issue's newly created branch, or its restored branch with ownership verified from this run's durable record, as `SESSION_BRANCH`. Re-check `git branch --show-current` against it immediately before the first edit and again immediately before staging. HEAD is global to the working copy, so a checkout from earlier in the wave proves nothing. Never write to another run's branch or assume ownership from its name alone.
