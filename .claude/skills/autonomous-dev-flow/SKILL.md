---
description: "Carry delegated development through scope/design, reuse investigation, a proportional plan, model delegation, TDD, /full-review, gated synchronous merge and..."
---

# /autonomous-dev-flow

Carry delegated development through scope/design, reuse investigation, a proportional plan, model delegation, TDD, /full-review, gated synchronous merge and verified ledger updates. Both normal development and prime-directive include merge authority under Critical Rule 5. Normal development ends with a seed/status after the selected feature or work package is delivered; prime-directive continues to the next authorized item within its mission and original limits. Owner presence does not select or change that mode.

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
- If all matching issues are assigned or 0 issues match, report that the selected queue has no eligible items. If a broader outcome was delegated, check its remaining acceptance gap before stopping; a missing queue item is not proof of completion. Continue bounded in-scope work where authorized, or name the actual dependency.
- Show the queue and apply existing delegated authority; ask only for missing scope or authority before entering the loop

```markdown
## Work Queue ({N} issues, {M} skipped as assigned)

| # | Issue | Labels | Action |
|---|-------|--------|--------|
| 1 | #12 — Add retry logic to API client | enhancement | Implement |
| 2 | #15 — Add leaderboard system | complexity:high | Decompose → sub-issues |
| — | #16 — Refactor auth module | enhancement | Assigned to @user (skipped) |
| 3 | #18 — Add integration tests for auth flow | testing | Implement |

**Authorization:** {existing delegated scope / exact unresolved authority needed}
```

Use the user's existing authorization; do not ask for queue approval again when this run is already authorized. Record the selected work package, acceptance and execution mode (normal development or prime-directive), and inherit that mode when called by an orchestrator. Routine decisions, gated merge and retries are autonomous within scope and caps. Preserve explicit merge holds, owner-reserved actions and actual repository/host restrictions. Continue independent authorized work while a prerequisite is unavailable.

Once authorized, create task list tracking:
```
For each issue in work queue:
  TaskCreate: "Issue #N — <title>" with status pending
```

### Phase 0.5: Auto-Decompose High-Complexity Issues

When the queue contains issues that are too large to implement directly (e.g., labeled large scope descriptions spanning multiple systems or 3+ files or equivalent), decompose them into smaller, independently implementable sub-issues BEFORE entering the core loop.

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
  --body "$(cat <<EOF
## Context

Filed from: #${ISSUE_NUM}

## Summary

Specific sub-task description.

Part of #${ISSUE_NUM}

## Implementation Plan

- Files to modify: \`src/path/to/file\`
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

**Skip criteria** — verify the current dependency from available evidence and authority, then log its reason in the progress table:
- No identifiable acceptance criteria after reading the delegated outcome and linked context — needs requirements before implementation
- Manual testing or other actions reserved to the owner; continue authorized design, documentation and preparation
- Requires indispensable user input that remains unavailable after checking current messages and records
- Deployment/release actions reserved to the owner or outside granted authority; continue any authorized build/preparation work
- Issues labeled `wontfix`, unless the owner has authorized revisiting them; for `blocked`, verify that its recorded dependency still applies
- An unresolved decision outside delegated authority; resolve routine implementation choices within scope

Re-evaluate blocked items when a prerequisite arrives. Restore actionable work to the queue within its saved allowance without requiring a new issue or repeating approval; a label or earlier skip does not make the dependency permanent.

If skipping, comment on the issue:

```bash
gh issue comment ${ISSUE_NUM} --body "Blocked during autonomous dev session — [specific prerequisite or reached limit]. Agent resumes delegated work when that prerequisite is supplied or the limit is explicitly extended."
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
- Open PR exists → skip duplicate implementation; reconcile remaining gates and saved retries before treating the issue as complete
- Stale branch, no PR → inspect and preserve useful work before any cleanup; resume only within the saved attempt and budget limits. No PR does not mean no attempt occurred.

### Phase 2: Scope, Design, Investigation and Plan

```bash
gh issue view ${ISSUE_NUM} --json title,body,labels,comments
```

Read the full issue and linked context, then establish the observable acceptance criteria. Inspect existing code before choosing an implementation:
- **Reusable behavior** — find analogous flows, shared classes/helpers and existing interfaces. Apply SOLID/DRY through appropriate reuse; avoid speculative abstractions and duplicate logic.
- **Files and design** — identify affected components and the smallest coherent design that satisfies acceptance.
- **Test strategy** — specify observable behavior, relevant regressions and where verification belongs.
- **Implementation plan** — record a proportional sequence with reuse decisions, component ownership and acceptance checks; small work needs only a short plan.

Explore the codebase to understand the relevant code before writing anything:

```bash
# Read CLAUDE.md for project conventions
cat CLAUDE.md 2>/dev/null

# Explore relevant files based on issue description
```

If the issue body is empty or has no actionable requirements, apply skip criteria from Phase 0.5.

### Phase 3: Delegate Implementation (TDD)

Delegate the plan to a suitable available model under the project's model policy. Give it acceptance criteria, reuse decisions, the relevant code, validation commands and explicit file/branch ownership; use an isolated worktree for concurrent edits. The coordinator remains responsible for review, merge verification and ledger updates. If delegation is unavailable, record the capability limit and use an authorized local implementation fallback; do not claim an independent implementation agent ran. The following branch and TDD contract applies to the implementer.

For a new attempt, record its start in durable run state (see Session Boundaries) before implementation, so a failure before PR creation still consumes its applicable allowance. For an interrupted attempt, verify and restore its recorded branch/worktree and unfinished step; skip fresh-main/new-branch initialization and do not count the same start twice. Create new branches following project conventions:

```bash
# Generate slug from issue title: lowercase, hyphens, no special chars, max 40 chars
ISSUE_TITLE=$(gh issue view "${ISSUE_NUM}" --json title -q '.title')
SLUG=$(printf '%s' "${ISSUE_TITLE}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-40)

# Create branch from issue number + slug
# Branch convention: feat/<number>-<slug>, with fix/, refactor/ or test/ when selected explicitly
BRANCH="${BRANCH_PREFIX}${ISSUE_NUM}-${SLUG}"
git checkout -b "${BRANCH}"

# This is the branch THIS session created. Record it, and from here on assert it
# rather than trusting it — `git` HEAD is global to the working copy, so a
# concurrent session sharing this checkout can move it out from under you.
SESSION_BRANCH="${BRANCH}"
assert_branch() {
  local now; now="$(git branch --show-current)"
  [ "${now}" = "${SESSION_BRANCH}" ] || {
    echo "STOP: on '${now}', expected '${SESSION_BRANCH}' — HEAD moved under this session. Do not edit, do not stage." >&2
    return 1
  }
}
```

**CRITICAL: Always branch from main.** Never stack branches — each PR starts from current main after its prerequisites merge.

**Assert the branch before you write.** Call `assert_branch` immediately before the first edit of this issue **and again immediately before staging** (Phase 4). A checkout from ten minutes ago proves nothing: another session sharing this working copy may have checked out its own branch since, and edits made in that state land on *its* branch. Re-check, never remember. If the assertion fails, stop and re-establish `SESSION_BRANCH` — do not edit, do not stage. Use a branch created for this attempt or restored with ownership verified from this run's durable record. If HEAD is another run's branch, restore the verified `SESSION_BRANCH` first. A matching name alone does not establish ownership; never discard unverified dirty work or recreate an interrupted branch over its retained changes.

```bash
assert_branch || exit 1   # before the first edit
```

#### RED — Write Failing Tests First

Based on the issue's acceptance criteria, write tests that describe the desired behavior. Tests MUST fail before any implementation.

```bash
# Server: cd packages/server && npm test
# App: cd packages/app && npx jest
# Dashboard: npm run test -w @chroxy/dashboard
# Tests: packages/server/tests/*.test.js; app Jest *.test.ts / *.test.tsx; dashboard colocated *.test.ts / *.test.tsx

# Run tests to confirm they fail
${TEST_COMMAND}
```

If tests pass immediately, the behavior already exists — investigate before proceeding. Either the issue is already resolved or the tests don't capture the right behavior.

#### GREEN — Make Tests Pass

Write the minimum implementation to make all new tests pass. Don't over-engineer — just satisfy the tests.

```bash
# Run tests to confirm they pass
${TEST_COMMAND}
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
${TEST_COMMAND}

# App: cd packages/app && npx tsc --noEmit
# Dashboard: npm run typecheck -w @chroxy/dashboard
# Server: applicable packages/server/scripts/lint-*.sh checks
${LINT_COMMAND}
```

### Phase 4: Commit and PR Creation

**Stage explicit paths.** `git status --short` first, then `git add` the files you changed, **by name**. Never `git add -A`, `git add .`, `git add -u`, `git add <dir>/`, or `git commit -a`. The working copy is shared with concurrent sessions, so a bulk add commits whatever else happens to be in the tree. `-u` is not the safe one: it restages every *tracked* file whose worktree copy differs, including files a clean/smudge filter rewrote without you touching them — that is how `git add -u` turned a tracked 21KB `.docx` into a git-lfs pointer and committed it as an edit.

Stage and commit with conventional format:

```bash
# Re-assert the branch — this is the second mandatory check, and the one that
# stops another session's work being swept into this PR. (`assert_branch` is
# defined in Phase 3; re-declare it if this runs in a fresh shell.)
assert_branch || exit 1

# Look at what is actually there, then stage those paths by name.
git status --short
git add <specific-files>

# Commit with issue reference — NO attribution
git commit -m "$(cat <<'EOF'
type(scope): description

Implements the core change described in the issue.

Refs #${ISSUE_NUM}
EOF
)"

# Commit scope conventions: server, app, desktop, tunnel, ws, cli, ci, docs, dashboard

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
- [ ] Dashboard tests pass
- [ ] Manual smoke test
EOF
)")

PR_NUM=$(echo "$PR_URL" | grep -oE '[0-9]+$')
```

### Phase 4.5: Smoke Test (if applicable)

If the PR modified **UI or frontend files**, run the project's smoke test to catch visual regressions before review. This prevents wasting review cycles on PRs that break the UI.

```bash
# Chroxy Phase 4.5 uses the canonical isolated recipe identified below.
```

**Chroxy Phase 4.5 execution override — mandatory before Phase 5:** read and run only the `Smoke the path the owner would take` section in this checkout's installed `.claude/commands/prime-directive.md`, including its mechanical scope, complete isolated setup/allowlisted environment, owner-path exercises, evidence, PID-owned teardown and final-head gate. Read the section as QA instructions only: do not invoke `/prime-directive`, activate PRIME, expand the current mission to the backlog or alter current authority/holds. Evaluate its scope for every PR, whether or not the generic pattern below matches; record its `smoke: not applicable` reason when out of scope. If the installed section is missing, incomplete or cannot be safely executed, record the precise QA prerequisite and block the affected review/merge; never fall back to `/smoke-test`.

This replaces execution of the remainder of generic Phase 4.5 and the skill-profile smoke customizations, including `/smoke-test`, the separate two-smoke-fix cap and the no-real-messages rule. Retain the issue's recorded attempt allowance; the recipe's tiny real-turn checks use only its isolated fixture/config/daemon. Preserve `host: chroxy <provider> | native` and the live preview record path in STATE; recover the recorded PID/port/config/fixture/head before further calls. An interrupted smoke is an attempt, not a pass. After evidence/teardown, proceed to Phase 5 Full Review; after review fixes, repeat the changed-feature/repro checks on the final head as the recipe requires. Final-head smoke evidence (or its not-applicable reason) adds to all upstream review/CI/thread/approval gates. Additional owner-reserved checks remain named and never substitute for the agent's isolated QA. The generic pattern and instructions below are reference only for this project.

```bash
# Reference pattern only; the canonical Chroxy recipe decides scope.
CHANGED_FILES=$(git diff --name-only main...HEAD)
if echo "$CHANGED_FILES" | grep -qE 'packages/dashboard/|packages/app/|\.tsx$|\.css$|\.html$|components\.css|theme'; then
  NEEDS_SMOKE_TEST=true
fi
```

If `NEEDS_SMOKE_TEST` is true:

1. **Rebuild UI** if needed (e.g., `npm run build`)
2. **Run `/smoke-test`** — this launches the app, opens a headless browser, and verifies key UI elements
3. **Check results:**
   - **All pass:** Continue to Phase 5 (review)
   - **Failures:** Read the screenshots, diagnose whether it's an app bug or a test selector issue
     - **App bug:** Fix the code, re-run tests, amend commit, re-run smoke test
     - **Test issue:** Note it in the PR description, continue (don't block on flaky test selectors)
4. **Max 2 smoke test fix attempts** — if still failing after 2 fixes, flag the PR as "Needs attention (smoke test failure)" and move on

If `NEEDS_SMOKE_TEST` is false, skip directly to Phase 5.

**CRITICAL:** The smoke test must NOT send real messages or create persistent state. It only verifies UI rendering and navigation.

### Phase 5: Full Review

**Pre-Skill Checkpoint** (MANDATORY — prevents context drift in long sessions):
1. Re-read CLAUDE.md for project conventions
2. Re-read the skill files for /full-review, /agent-review, and /check-pr

Run `/full-review ${PR_NUM}`:
- Phase 1: Independent subagent review — deep review against acceptance and project standards; the implementer does not review its own work as the independent reviewer
- Phase 2: Check-PR — process all posted Copilot comments and general review summaries as well as independent-agent findings. A missing inline thread does not mean there is no finding; third-party review availability never waives a repository-required approval

Capture results: verdict, findings counts, fixes committed, issues created/closed. Fix blocking defects introduced or worsened by the PR and missing acceptance behavior, or remove/contain them with a verified adequate fallback. File nonblocking minor findings only with evidence that acceptance, correctness and safety are unaffected. Size or avoiding another CI cycle alone does not justify deferral. Record each supported disposition and resolve its thread.

**If blocking findings exist:** Fix them (standard /full-review behavior handles this). Two fix attempts max — after that, flag the PR as "Needs attention" and move on.

**Merge — or don't — exactly as Critical Rule 5 directs.** Rule 5 records delegated merge authority and actual holds/restrictions for both execution modes; it is the only place that decides, and nothing here overrides it. If rule 5 grants gated self-merge: when the verdict is clean, ALL CI checks pass on the final commit, and ALL review threads are resolved, merge synchronously per repo convention (see `unattended-merge`) without another routine approval, verify the PR reports `MERGED` into the intended base branch (`main` by default), and immediately record the delivered outcome, PR, base, review/check evidence, merge SHA and deferred issue links in the ledger and final session report. For dependent PRs, merge prerequisites first, refresh dependents and recheck their final-head gates. NEVER use `gh pr merge --auto` or GitHub auto-merge — verify the gates first, then merge synchronously. If any gate fails, do NOT merge: flag the PR for the user with the failed gate named and keep working. If rule 5 withholds merge authority, leave the PR open and flag it — a clean review is not a reason to revisit that.

### Phase 6: Assess, Report, and Continue

Based on /full-review results, classify the PR:

| Verdict | Meaning | Action |
|---------|---------|--------|
| Clean | No blocking findings, all comments dispositioned with evidence | When acceptance is satisfied, edit PR body: `Refs` → `Closes`. Follow Critical Rule 5: verify all gates, merge and record before marking delivered. An explicit hold or actual restriction leaves the PR ready/open with delivery incomplete, not done |
| Needs attention | Blocking findings or unresolved comments | Keep `Refs` (don't auto-close). Flag for user, continue |
| Broken | Tests failing after review fixes | Keep `Refs` (don't auto-close). Flag for user, continue |

Update task tracking:

```
TaskUpdate: "Issue #N" → completed (or flagged)
```

Output cumulative progress table:

```markdown
## Session Progress ({completed}/{total})

| # | Issue | Branch | PR | Smoke | Review | Status |
|---|-------|--------|----|-------|--------|--------|
| 1 | #12 — Add retry logic | 12-add-retry | #45 | — | Approve (0 critical) | Done |
| 2 | #15 — Add leaderboard | — | — | — | — | Decomposed → #20, #21 |
| 3 | #20 — Leaderboard data model | 20-lb-model | #46 | 12/13 | Approve (1 suggestion) | Done |
| 4 | #18 — Add auth tests | — | — | — | — | In progress |
| 5 | #22 — Update error handling | — | — | — | — | Queued |
```

**CRITICAL: A flagged PR blocks only its dependent work.** Record its failed gate and consumed fix attempts, then advance independent authorized work. Before a wait-only handoff, take each ready, independently deliverable slice through review and delivery within the repo's authority. Ask the owner only for the missing prerequisite, decision or retry authority; the agent retains delegated implementation, build and delivery work and resumes it when that prerequisite arrives.

After recording a verified delivery, return to Phase 1 for the next item within the selected work package. Once that package is delivered, normal development writes `/session-lifecycle`'s verified seed and concise status, then ends; prime-directive selects the next authorized item within its mission and original limits. Do not expand a normal feature into backlog cleanup or stop a prime-directive run just because one feature merged.

### Phase 7: Session Summary

After the selected work package or bounded run reaches its ending condition, report the delegated outcome, usable result, remaining acceptance gap and actual execution state. In normal development, a delivered and recorded work package is the planned session boundary: provide the verified seed and next-session instruction. In prime-directive, a checkpoint leads to continued execution while authorized actionable work and allowance remain. An exhausted queue or finished context segment alone does not prove the outcome is complete; continue authorized ready work within the applicable caps, or name the genuine dependency, reached limit or host limitation.

Keep this detailed accounting in the ledger or linked report. The chat ending follows `/session-lifecycle`'s concise outcome, status and next-action format; link details rather than pasting every table.

```markdown
## Autonomous Dev Session Results

**Issues processed:** {N}
**Queue source:** {description}

### Results

| # | Issue | PR | Smoke | Review Verdict | Status |
|---|-------|----|-------|---------------|--------|
| 1 | #12 — Add retry logic | [#45](url) | — | Approve | Merged (`abc1234`) |
| 2 | #15 — Add leaderboard | — | — | — | Decomposed → #20, #21, #22 |
| 3 | #20 — Leaderboard data model | [#46](url) | 12/13 | Approve | Merged (`def5678`) |
| 4 | #18 — Add auth tests | [#47](url) | — | Request Changes | Needs attention |

### Merged by this session

One entry per verified self-merged PR — MANDATORY (Unattended Merge Gate rule 6). Omit the section only when no self-merges were verified; a later hold does not erase earlier merges:

| PR | Issue | Review | Checks | Merge SHA |
|----|-------|--------|--------|-----------|
| [#45](url) | #12 — Add retry logic | Approve, 0 unresolved | all green | `abc1234` |
| [#46](url) | #20 — Leaderboard data model | Approve, 0 unresolved | all green | `def5678` |

### Summary
- **Merged this session:** N PRs (entries above)
- **Open / needs attention:** M PRs (details below)
- **Decomposed:** K issues → L sub-issues created
- **Skipped:** J issues (reasons below)
- **Issues created during reviews:** #A, #B, #C
- **PRs merged by user during session:** #X, #Y

### Needs Attention
- **PR #47** (#18 — Add auth tests): 1 critical finding — auth token not validated before use. See review comment.

### Skipped Issues
- **#25**: Owner access required for deployment setup; agent retains authorized build/preparation work
- **#30**: Needs user decision on provider choice

### Next Steps
- Agent's next authorized action or accepted continuation: {action and task/session identifier, or none}
- Required owner prerequisite: {QA/access/authority/decision, what it unblocks, or none}
- Reached retry/budget/host limit: {scope and evidence, plus exact restart action if needed, or none}
```

## Session Boundaries

Preserve the recorded mode, run identity, state and scoped limits from the caller. Normal development ends after its selected feature/work package is delivered and recorded, with `/session-lifecycle`'s seed and concise status. Prime-directive continues across queue checkpoints and supported auto-compaction within the same mission and original limits. Checkpoint every few issues and before a large one; a wave boundary or compaction count does not force a session restart, and owner presence is not a pause request. Measure handoff and reconstruction cost before claiming savings.

- **Durable run state.** Keep the queue (`scratchpad/autonomous-queue.json`) with a compact state record: stable run ID, execution mode, selected work package, current wave/session IDs, outcome, observable acceptance, authority and owner-reserved actions, queue position, blockers, last verified merge, and continuation task/session ID when accepted. Preserve per-issue attempts, including failures before any PR, with strategy, result and consumed smoke/review fix counts. Record measured cost and each configured limit's actual scope (`wave`, `session` or `run`), scope identifier and consumed allowance; missing consumption is unknown, not zero. Update state when an attempt starts and when work consumes a capped retry, not only at the final handoff. The seed must carry this state or a pointer verified to survive workspace teardown.
- **Prime-directive continuation.** Prefer the current host's supported auto-compaction/context management; reload `/prime-directive` after compaction when it owns the run. Test a lower compaction threshold only through an explicitly configured supported setting; do not silently change it.
- **Fresh session needed and authorized re-launcher available** (none configured for this repo) — submit this scope's absolute handoff seed (`$CLAUDE_HANDOFF_DIR/NEXT-<scope>.md`, default dir `~/Obsidian/no-it-all/handoffs/`) plus the queue and run state. Verify acceptance with a task/session identifier before ending while authorized work remains. A configured launcher, saved seed or expected user restart is not acceptance.
- **No accepted re-launch** — continue using supported host continuation/compaction where available. If the host cannot continue, report that capability limit and exact restart action; do not claim background work or invent an unsupported command. A genuine dependency, explicit pause or reached retry/budget limit still stops its affected work.
- **The boundary seed is written outside every worktree, and it archives rather than overwrites.** Both halves come from `/session-lifecycle` End step 1 and neither is optional:

  Execute the complete `/session-lifecycle` End flow for this checkpoint. It selects one
  next task with an executor and observable acceptance, fills the STATE/TL;DR context,
  records the boundary reason, carries unresolved decisions and the pulse snapshot, and
  writes/verifies the seed through its canonical writer. Do not substitute a partial raw
  writer call or another skeleton. Preserve the recorded mode: prime checkpoints continue
  the already authorized mission under the continuation rules above; the lifecycle flow
  grants no new authority and does not make a checkpoint a forced stop.

  **① The path.** `$CLAUDE_HANDOFF_DIR/NEXT-<scope>.md`, where `<scope>` is the main worktree's directory basename. Never inside the segment's worktree: `git worktree remove --force` — the fleet's standard teardown — deletes untracked files silently, which is how three earlier versions of this rule lost a seed. Outside every workspace there is nothing to commit, nothing to push, and nothing to gate teardown on.

  **② The header, and archive-on-collide.** The lifecycle's writer writes the frontmatter End step 1 prescribes — `type`, `date` (full UTC timestamp), `scope`, `session`, `picks_up_at`, `sensitivity`. If the canonical file already exists carrying a **different** `session:`, it renames that one to `NEXT-<scope>.<UTC>-<sid>.md` before writing; a seed this segment did not write is never overwritten, a segment re-writing its own seed overwrites in place, and a failed archive is a REFUSE that writes nothing.

  **Do not reimplement any of this inline.** The scope key, the session id, the archive and the proof live in one script with its own test suite; a segment that writes its own version is exactly the drift this consolidation removed.

- **No forced restart or numeric context ceiling.** Continue prime-directive through supported compaction; no second-compaction or wave-count restart rule applies. Route heavy tool output through subagents. If an issue balloons, finish or park it within the attempt limit and continue independent work. Preserve mode, outcome, acceptance, authority and consumed limits across any boundary; a new segment does not reset a limit belonging to the same recorded scope.
- **Cost circuit breaker at wave boundaries (queue checkpoints).** Compare measured cost with the configured limit and its scope (Chroxy cost profile: per-session budget none — PAUSED 2026-09-24, track-only. At boundaries record session spend with `python3 ~/.claude/scripts/usage-benchmark-row.py` (print-only mid-session; append once at session end) and weekly pace with `python3 ~/.claude/scripts/usage-pace.py --oneline`. Never stop on spend while paused or resurrect $150. Honor explicit reinstated scoped limits, retry caps and host restrictions.). At the limit → write the handoff and **stop and notify** instead of starting more work covered by that limit. Preserve cumulative run consumption across restarts. If measurements are missing, retain known consumption and report the uncertainty; do not infer unused allowance or invent a budget.
- **Verify state directly.** A background monitor ending is not a verdict — assert PR/CI state with a direct query before recording it, and re-check `mergeStateStatus` at the current head after any push.

## Resume Strategy

GitHub remains the source of truth for current issue/PR status. The durable run state and handoff preserve outcome, acceptance, authority, decisions, stable run identity and consumed attempts/budget; these cannot all be reconstructed from GitHub. Reconcile both before resuming.

If a session is interrupted (crash, timeout, user stops it), resume when authorized as follows:

1. Load the saved run identity and scoped consumption first, including attempts that failed before opening a PR. Continue the same run's limits; a restart is not a new retry allowance or budget authorization.
2. Query GitHub for branches matching `BRANCH_PREFIX` and PRs referencing each issue; verify current gates before marking a PR complete. Use these results to refresh repository status, not overwrite saved consumption.
3. Resume eligible unfinished work within the remaining allowances. No PR is insufficient evidence that an issue was never attempted. If history is missing, record consumption as unknown and recover it from durable records before a retry whose remaining allowance cannot be established; continue independent authorized work with known allowances.
4. When the owner supplies a missing prerequisite, resume the dependent delegated work within its existing authority and caps. Do not transfer the remaining implementation, build or delivery steps to the owner merely because the previous segment waited.

Re-running must avoid duplicating completed work and preserve consumed limits, including work that left no PR.

## Critical Rules

1. **NO attribution** — No Co-Authored-By, no "Generated with Claude", no AI mentions anywhere. Zero Attribution Policy.
2. **TDD is mandatory** — RED → GREEN → REFACTOR for every issue. No skipping tests. If pure docs/config, note why tests are N/A.
3. **Branch from main every time** — Never stack branches. Each PR starts from current main after its prerequisites merge.
4. **Respect existing authorization** — No repeated queue approval or routine decision pause. Continue within scope and caps, preserve owner-reserved actions, and follow the verified continuation contract. Owner observation and context checkpoints are not pause requests.
5. **Self-merge authority for this repo** — Delegated implementation includes gated synchronous merge and ledger updates in both normal and prime-directive mode. Merge only through the Unattended Merge Gate — /full-review clean + ALL checks green on the final commit + ALL review threads resolved; verify `MERGED` into the intended base branch. No `gh pr merge --auto`, no GitHub auto-merge, no protection overrides, no repeated routine merge approval. Only selected work and necessary prerequisites are covered; unrelated PRs are outside scope. Honor explicit user merge holds and actual repository/host restrictions. Every self-merged PR MUST appear as an entry in the final session report.
6. **Block only dependent work** — At the fix-attempt cap, flag the PR with its failed gate and advance independent ready slices through review and authorized delivery before a wait-only handoff. Ask for a missing prerequisite; retain delegated execution when it arrives.
7. **Two fix attempts max** — If /full-review finds blocking issues, fix them. If a second attempt still fails, flag and move on. Preserve consumed fix attempts across context restarts; when invoked by `/tackle-issues`, use its per-issue, per-wave allowance and shared state.
8. **Progress table after every issue** — The user may check in at any time. The table must be current.
9. **Respect the hard cap** — Max 15 issues per session segment (wave). Refuse larger queues.
10. **Reconcile repository and run state** — Query GitHub for current issue/PR status. Preserve outcome, acceptance, authority, run identity and scoped consumption from durable state; PR counts cannot prove no attempt occurred or reset consumed limits.
11. **Compose existing skills** — /full-review is called as-is (chains /agent-review → /check-pr). Don't reinvent their logic.
12. **Decompose, don't skip** — High-complexity issues get broken into sub-issues, not skipped. Only skip truly non-automatable work.
13. **Comment on skips** — Every skipped issue gets a GitHub comment explaining why. The user sees the reason.
14. **Pre-Skill Checkpoint** — Re-read CLAUDE.md and skill files before running /full-review to prevent context drift.
15. **Sync before branching** — Always `git checkout main && git pull` before starting each issue. Check for merged PRs first.
16. **Explicit-path staging** — `git status --short`, then `git add` the changed files by name. Never `git add -A`, `git add .`, `git add -u`, `git add <dir>/`, or `git commit -a`. `-u` is not the safe one: it restages tracked files a clean/smudge filter rewrote behind your back, which is how a tracked 21KB `.docx` was committed as a git-lfs pointer.
17. **Assert the branch before you write** — record the branch you create as `SESSION_BRANCH` and re-check `git branch --show-current` against it immediately before the first edit and again immediately before staging. HEAD is global to the working copy; a concurrent session can move it after you branched. Write only to a branch created for this attempt or restored with ownership verified from this run's durable record; a matching branch name alone is insufficient.
