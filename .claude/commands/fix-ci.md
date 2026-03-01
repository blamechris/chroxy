# /fix-ci

Diagnose CI failures or cancellations on a PR, take corrective action (re-trigger, fix, or escalate), and report status.

## Arguments

- `$ARGUMENTS` - PR number (optional, defaults to current branch's PR)

## Instructions

### 0. Gather CI State

```bash
PR_NUM=${1:-$(gh pr view --json number -q .number)}
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
BRANCH=$(gh pr view ${PR_NUM} --json headRefName -q .headRefName)
HEAD_SHA=$(gh pr view ${PR_NUM} --json headRefOid -q .headRefOid)

echo "PR: #${PR_NUM} | Branch: ${BRANCH} | HEAD: ${HEAD_SHA}"

# Get the latest CI run(s) for this branch
gh run list --branch ${BRANCH} --workflow "CI" --limit 5 --json databaseId,status,conclusion,headSha,event,createdAt
```

### 1. Get Job-Level Status

For the most recent run matching `HEAD_SHA`:

```bash
RUN_ID=<id from step 0>
gh run view ${RUN_ID} --json jobs --jq '.jobs[] | {name, status, conclusion}'
```

Count jobs by status: passed, failed, cancelled, skipped, in_progress.

### 2. Classify Overall State

Apply these rules **in order** (first match wins):

| Classification | Condition | Action |
|----------------|-----------|--------|
| **ALL_PASS** | Latest run's SHA matches HEAD AND all required jobs passed | Report green, exit |
| **IN_PROGRESS** | Any job still running or queued | Poll until complete (see Step 2a) |
| **STALE** | Latest run's SHA does NOT match HEAD | Check for newer run, or retrigger |
| **CANCELLED** | One or more jobs cancelled, none failed | Check for replacement run (see Step 2b) |
| **FAILED** | One or more jobs failed | Per-job diagnosis (Step 3) |

#### 2a. IN_PROGRESS — Poll for Completion

```bash
MAX_WAIT=600  # seconds
INTERVAL=30
ELAPSED=0

while [ $ELAPSED -lt $MAX_WAIT ]; do
  STATUS=$(gh run view ${RUN_ID} --json status -q .status)
  [ "$STATUS" = "completed" ] && break
  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
  echo "Waiting for CI... ${ELAPSED}s / ${MAX_WAIT}s"
done

# Re-classify after completion
```

#### 2b. CANCELLED — Check for Replacement Run

Cancellation often happens due to concurrency groups (a newer push cancels the older run). Check if a newer run exists for the same SHA:

```bash
# Check all runs for this SHA
gh run list --branch ${BRANCH} --workflow "CI" --limit 5 --json databaseId,status,conclusion,headSha,event \
  | jq --arg sha "$HEAD_SHA" '[.[] | select(.headSha == $sha)]'
```

**Decision logic:**
- If a newer **completed successful** run exists for the same SHA → ALL_PASS, report green
- If a newer run exists but only ran partial jobs (e.g., different event trigger) → the full suite never ran, needs RETRIGGER
- If no newer run exists → needs RETRIGGER

**Common cause:** CI concurrency groups with `cancel-in-progress: true`. When fix commits are pushed, the new `pull_request` event cancels the in-progress run. If the new event is a different type (e.g., `pull_request_review` which only triggers notification jobs), the full CI suite never re-runs.

### 3. Per-Job Diagnosis (for FAILED or CANCELLED jobs)

For each non-passing job, fetch logs and diagnose:

```bash
# For failed jobs — get the failure logs
gh run view ${RUN_ID} --log-failed 2>&1 | tail -100

# For cancelled jobs — limited logs available, check annotations
gh api repos/${REPO}/actions/runs/${RUN_ID}/jobs --jq '.jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | {name, conclusion, steps: [.steps[] | select(.conclusion != "success" and .conclusion != "skipped") | {name, conclusion}]}'
```

**Pattern match against known failures:**

Project-specific patterns:
- `no semicolons` / `single quotes` → FALSE POSITIVE (server style per CLAUDE.md)
- `import/export` / `ES modules` → FALSE POSITIVE (server uses ES modules, not CommonJS)
- `EventEmitter` / `cleanup` → Check for proper destroy/close handlers
- `WebSocket` / `tunnel` → Check connection reliability patterns
- `React Native` / `AbortSignal.timeout` → FIX (not available in RN, use setTimeout)
- `Zustand` / `immutable` → Check for proper `set()` usage
- `touch targets` / `44pt` → Check mobile accessibility

Generic patterns (apply to all repos):
- `rate limit` / `API rate limit exceeded` → RETRIGGER (transient)
- `timeout` / `timed out` / `deadline exceeded` → RETRIGGER (transient, unless recurring)
- `connection refused` / `network` / `ECONNRESET` → RETRIGGER (transient)
- `permission denied` / `403` / `Resource not accessible` → ESCALATE (permissions issue)
- `out of disk space` / `no space left on device` → ESCALATE (infrastructure)
- `cancelled` (no failure, just cancelled) → RETRIGGER

Classify each job into exactly ONE outcome:

| Outcome | When | Action |
|---------|------|--------|
| **RETRIGGER** | Cancelled by concurrency, transient error (network, timeout, rate limit) | `gh run rerun` |
| **FIX** | Known code issue with clear automated fix | Commit fix, push (triggers new CI) |
| **ESCALATE** | Unknown failure, permissions, infrastructure, or needs human judgment | Report diagnosis + log excerpt |

### 4. Take Action

#### RETRIGGER

```bash
# Preferred: re-run only failed/cancelled jobs (fast, targeted)
gh run rerun ${RUN_ID} --failed

# Fallback: empty commit to retrigger
git commit --allow-empty -m "chore(ci): retrigger CI workflow"
git push
```

**One retrigger attempt only.** If the re-run also fails, escalate instead of retrying.

#### FIX

```bash
# 1. Check out the PR branch
git checkout ${BRANCH}

# 2. Make the fix (specific to the failure pattern matched)
# 3. Commit with descriptive message
git add <files>
git commit -m "fix(ci): Description of fix"

# 4. Push (triggers new CI automatically)
git push
```

#### ESCALATE

Do NOT take automated action. Report the diagnosis to the user:

```markdown
## CI Escalation: PR #${PR_NUM}

**Job:** [job name]
**Status:** [failed/cancelled]
**Diagnosis:** [what the logs indicate]

**Log excerpt:**
```
[relevant log lines — keep under 30 lines]
```

**Suggested next steps:**
- [specific recommendation based on diagnosis]
```

### 5. Wait for CI (if action taken)

After RETRIGGER or FIX, wait for the new run to complete:

```bash
MAX_WAIT=600
INTERVAL=30
ELAPSED=0

# Get the new run ID
sleep 10  # brief delay for run to appear
NEW_RUN_ID=$(gh run list --branch ${BRANCH} --workflow "CI" --limit 1 --json databaseId -q '.[0].databaseId')

while [ $ELAPSED -lt $MAX_WAIT ]; do
  STATUS=$(gh run view ${NEW_RUN_ID} --json status -q .status)
  [ "$STATUS" = "completed" ] && break
  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
  echo "Waiting for CI... ${ELAPSED}s / ${MAX_WAIT}s"
done

# Check final result
CONCLUSION=$(gh run view ${NEW_RUN_ID} --json conclusion -q .conclusion)
echo "CI result: ${CONCLUSION}"
```

If the new run also fails, re-classify and escalate. Do NOT retrigger a second time.

### 6. Summary Report

```markdown
## CI Status: PR #${PR_NUM}

| Job | Status | Action Taken |
|-----|--------|--------------|
| Job 1 | pass | — |
| Job 2 | pass (after retrigger) | Retriggered: cancelled by concurrency |
| Job 3 | pass | — |

**Result:** All jobs passing / N jobs need attention
**SHA:** ${HEAD_SHA}
**Run:** [link to run]
```

For the user-facing output, use a one-line summary table:

```markdown
| PR | CI Status | Jobs | Action Taken |
|----|-----------|------|--------------|
| #XX | PASS (after retrigger) | 6/6 passed | Retriggered: Run Tests cancelled by concurrency |
```

## Decision Tree

```
Start
  │
  ├─ Get latest CI run for HEAD SHA
  │
  ├─ Any run for this SHA?
  │   ├─ NO → retrigger (stale)
  │   └─ YES ↓
  │
  ├─ Run status?
  │   ├─ in_progress → poll until complete, re-classify
  │   ├─ completed ↓
  │   └─ other → investigate
  │
  ├─ All required jobs passed?
  │   ├─ YES → report green, exit
  │   └─ NO ↓
  │
  ├─ For each non-passing job:
  │   ├─ cancelled (no failure)?
  │   │   ├─ Replacement run exists with full suite? → use that run
  │   │   └─ No replacement → RETRIGGER
  │   ├─ failed → fetch logs, pattern match
  │   │   ├─ Known fixable pattern → FIX
  │   │   ├─ Transient error → RETRIGGER
  │   │   └─ Unknown/infrastructure → ESCALATE
  │   └─ skipped → check if required (skip if not)
  │
  ├─ Execute actions (retrigger / fix / escalate)
  │
  ├─ If action taken → wait for new CI run
  │   ├─ Passes → report green
  │   └─ Fails again → ESCALATE (no second retrigger)
  │
  └─ Report summary
```

## Critical Rules

1. **Diagnose before acting** — Never blindly retrigger. Always check logs and classify the failure first.
2. **One retrigger attempt** — If the re-run also fails, escalate. Infinite retry loops waste time.
3. **SHA awareness** — Always verify the CI run matches HEAD. Stale runs on old SHAs are meaningless.
4. **Log excerpts in escalations** — Never escalate with just "CI failed." Include relevant log lines so the user can act without re-investigating.
5. **Minimal fix scope** — FIX actions should be surgical. Don't refactor code; just fix the CI failure.
6. **Composable** — Works standalone (`/fix-ci 42`) or from `/full-review` (Phase 2.5).
7. **Idempotent** — Safe to re-run. If CI is already green, reports success and exits.
8. **No attribution** — Follow project attribution policy in all commits.
<!-- skill-templates: fix-ci 3768ea6 2026-03-01 -->
