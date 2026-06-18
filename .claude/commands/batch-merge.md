# /batch-merge

Sequentially merge a set of reviewed PRs, handling branch protection's "must be up-to-date" requirement by updating each branch after the previous merge.

## Arguments

- `$ARGUMENTS` - Space-separated PR numbers, `all` to merge all open PRs targeting main (sorted by number), or `--dry-run` to preview without merging.
  - Examples: `1570 1571 1572`, `all`, `1570 1571 --dry-run`

## Instructions

### Phase 0: Build Merge Queue

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# Parse arguments
PR_NUMS=()
DRY_RUN=false
for arg in $ARGUMENTS; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    all) PR_NUMS=($(gh pr list --base main --state open --json number --jq '.[].number | tostring' | sort -n)) ;;
    \#*) PR_NUMS+=("${arg#\#}") ;;
    *) PR_NUMS+=("$arg") ;;
  esac
done
```

Validate each PR: must be OPEN, targeting main, not draft. Remove invalid entries and warn.

Display the queue for user confirmation (**this is the ONLY confirmation point** — after approval, the entire loop runs autonomously):

```markdown
## Merge Queue ({N} PRs)

| # | PR | Title | CI | Copilot | Status |
|---|-----|-------|----|---------|--------|
| 1 | #1570 | test(combat): Assert carrier bay... | — | — | Queued |
| 2 | #1571 | test(combat): Add dodge roll... | — | — | Queued |
```

If `--dry-run`, state that no merges will be performed.

### Phase 1: Pre-Flight Check

Before entering the merge loop, pre-check all PRs to surface blockers early. For each PR:

```bash
# CI status
gh pr checks ${PR_NUM} --json name,state \
  --jq '[.[] | select(.state != "SUCCESS" and .state != "SKIPPED")] | length'

# Copilot review presence
gh api repos/${REPO}/pulls/${PR_NUM}/reviews \
  --jq '[.[] | select(.user.login == "copilot-pull-request-reviewer[bot]")] | length'
```

Update the progress table with pre-flight results. This is informational — does not block the loop.

### Phase 2: Sequential Merge Loop

Process PRs in order. For each PR:

#### Step 2a: Check CI

```bash
# Required check names that must pass
REQUIRED_CHECKS=("Run Tests" "Validate Project")

CHECKS=$(gh pr checks ${PR_NUM} --json name,state)
```

All required checks must be `SUCCESS` or `SKIPPED`. If any are failing or pending:

- **Pending/Queued:** Poll every 30s for up to 3 minutes.
- **Failed:** Run `/fix-ci ${PR_NUM}`. If fixed, continue. If escalated, mark PR as `Skipped` and continue to next PR.

#### Step 2b: Check Copilot Review

```bash
COPILOT_STATUS=$(gh api repos/${REPO}/pulls/${PR_NUM}/reviews \
  --jq '[.[] | select(.user.login == "copilot-pull-request-reviewer[bot]")] |
    if length == 0 then "NOT_FOUND"
    elif any(.[]; .state == "PENDING") then "IN_PROGRESS"
    else "COMPLETED" end')
```

Copilot review **must be present** before merge. This is the quality gate.

- **COMPLETED:** Proceed.
- **IN_PROGRESS:** Poll every 30s, max 5 min.
- **NOT_FOUND + PR < 8 min old:** Poll every 30s, max 8 min. Copilot takes 3-5 min to start.
- **NOT_FOUND + PR >= 8 min old:** Proceed with warning (Copilot won't come for old PRs).

#### Step 2c: Address Unaddressed Copilot Comments

Check for Copilot inline comments without replies:

```bash
# Get all inline comments
ALL_COMMENTS=$(gh api repos/${REPO}/pulls/${PR_NUM}/comments --paginate)

# Find Copilot comments without a reply from us
WORKFLOW_USER=$(gh api user --jq .login)

# Copilot-authored top-level comments (not replies) that have no reply from us.
# Scope to the Copilot bot so this step only processes Copilot threads, as the
# heading claims — human review comments are out of scope for batch-merge.
UNREPLIED=$(echo "$ALL_COMMENTS" | jq --arg user "$WORKFLOW_USER" '
  . as $all
  | [ $all[]
      | select(.in_reply_to_id == null)
      | select(.user.login == "copilot-pull-request-reviewer[bot]")
      | select(.id as $id
          | ($all | any(.[]; .in_reply_to_id == $id and .user.login == $user)) | not) ]
')
```

For each unreplied comment, handle using the 3-outcome model from `/check-pr`:
1. **FIX** — Fix the issue, commit, reply with before/after
2. **FALSE POSITIVE** — Reply explaining why no change needed
3. **DEFER** — Create follow-up issue, reply with issue link

**CRITICAL:** If any fix commits are pushed, `dismiss_stale_reviews` will invalidate the Copilot review. You MUST re-enter Step 2b and wait for a fresh Copilot review before proceeding to merge.

#### Step 2d: Merge

```bash
if [ "$DRY_RUN" = true ]; then
  echo "DRY RUN: Would merge PR #${PR_NUM}"
else
  gh pr merge ${PR_NUM} --squash --delete-branch
fi
```

**If merge fails**, apply the blocker decision tree (Phase 3).

#### Step 2e: Update Next PR Branch

After merging PR N, PR N+1 is stale (`strict: true` branch protection). Update it:

```bash
NEXT_PR=${PR_NUMS[$((current_index + 1))]}
if [ -n "$NEXT_PR" ]; then
  gh api repos/${REPO}/pulls/${NEXT_PR}/update-branch \
    --method PUT \
    -f expected_head_sha="$(gh pr view ${NEXT_PR} --json headRefOid -q .headRefOid)"
fi
```

If `update-branch` fails with a conflict, mark the next PR as `Blocked` and try the PR after that (it still needs updating since main changed).

#### Step 2f: Wait for CI on Updated Branch

```bash
MAX_WAIT=180  # 3 minutes
INTERVAL=30

ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  PENDING=$(gh pr checks ${NEXT_PR} --json state \
    --jq '[.[] | select(.state == "PENDING" or .state == "QUEUED" or .state == "IN_PROGRESS")] | length')
  FAILED=$(gh pr checks ${NEXT_PR} --json state \
    --jq '[.[] | select(.state == "FAILURE" or .state == "ERROR")] | length')

  if [ "$PENDING" = "0" ] && [ "$FAILED" = "0" ]; then
    break  # All checks done and passing
  fi
  if [ "$FAILED" != "0" ] && [ "$PENDING" = "0" ]; then
    break  # Failed but nothing pending — don't wait
  fi

  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
done
```

If CI fails after update-branch, run `/fix-ci ${NEXT_PR}`.

#### Step 2g: Update Progress Table

Output the progress table after **every merge**. This is the user's live dashboard.

```markdown
## Merge Progress ({merged}/{total})

| # | PR | Title | CI | Copilot | Merge | Notes |
|---|-----|-------|----|---------|-------|-------|
| 1 | #1570 | test(combat): Assert carrier... | PASS | Reviewed (0) | Merged | — |
| 2 | #1571 | test(combat): Add dodge roll... | PASS | Reviewed (1→fixed) | Merged | 1 fix in abc1234 |
| 3 | #1572 | test(autoload): Add Statistics... | Updating | — | Next | CI running after update-branch |
| 4 | #1573 | fix: Address silent failures... | — | — | Queued | — |
```

**Column values:**

| Column | Values |
|--------|--------|
| CI | `PASS`, `FAIL→fixed`, `FAIL→skipped`, `Updating`, `Pending`, `—` |
| Copilot | `Reviewed (N)`, `Reviewed (N→M fixed)`, `Pending`, `None (old PR)`, `—` |
| Merge | `Merged`, `Blocked`, `Skipped`, `Next`, `Queued`, `DRY RUN` |

### Phase 3: Merge Blocker Decision Tree

When `gh pr merge` fails, classify and respond:

| Error Pattern | Action | Max Retries |
|---------------|--------|-------------|
| "not up to date" / "branch is behind" | `update-branch` → wait CI → retry | 1 |
| "status check" / "required status" | `/fix-ci` → retry | 1 |
| "review" / "approval" / "dismissed" | Wait for fresh Copilot review → retry | 1 |
| "conversation" / "unresolved" / "must be resolved" | Resolve open review threads (see below), then retry | 1 |
| "conflict" / "not mergeable" | Skip immediately, report | 0 |
| "already merged" | Skip silently, note in table | 0 |
| Rate limit (403/429) | Back off 60s → retry | 2 |
| Unknown | Log full error, skip PR | 0 |

After max retries exhausted: mark PR as `Skipped` with reason, continue to next PR.

**Unresolved review conversations.** When branch protection requires conversation
resolution, `gh pr merge` fails with a message about unresolved conversations rather
than a status-check or review failure — easy to misclassify as `Unknown` and skip
opaquely. Detect it explicitly and surface it as the blocker reason. Confirm the cause
via GraphQL (REST does not expose thread state):

```bash
UNRESOLVED=$(gh api graphql -f query="
  query {
    repository(owner: \"${REPO%/*}\", name: \"${REPO#*/}\") {
      pullRequest(number: ${PR_NUM}) {
        reviewThreads(first: 100) { nodes { isResolved } }
      }
    }
  }" --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length')
```

If `UNRESOLVED > 0`, the threads were left open by the earlier review pass (reviews
should run BEFORE batch-merge — see Critical Rule 2). Resolve them with the same
GraphQL `resolveReviewThread` mutation `/check-pr` step 6b uses, then retry the merge
once. If threads cannot be resolved (e.g., a reviewer re-opened one intentionally),
mark the PR `Blocked` with reason "unresolved review conversations" rather than failing
silently — the user must weigh in.

### Phase 4: Session Summary

After all PRs processed:

```markdown
## Batch Merge Complete

**Merged:** {N}/{total} | **Skipped:** {M} | **Blocked:** {K}

| # | PR | Title | Merge | Notes |
|---|-----|-------|-------|-------|
| 1 | #1570 | test(combat): Assert carrier bay... | Merged | — |
| 2 | #1571 | test(combat): Add dodge roll... | Merged | 1 Copilot fix |
| 3 | #1572 | test(autoload): Add Statistics... | Skipped | CI timeout |

### Skipped/Blocked PRs
- **#1572**: Run Tests timed out after update-branch. Needs manual investigation.

### Copilot Comments Addressed During Merge
- **#1571**: 1 comment → FIX in `abc1234` (added null guard)
```

## Error Recovery

| Error | Recovery | Max Retries |
|-------|----------|-------------|
| CI failure after update-branch | `/fix-ci`, wait, retry merge | 1 |
| Copilot review not posted | Poll every 30s, max 8 min | 16 polls |
| Copilot review dismissed (stale) | Wait for new review cycle | 1 |
| Merge blocked (unknown) | Diagnose via `gh pr checks`, report | 1 |
| update-branch conflict | Skip PR, continue | 0 |
| Rate limiting | Back off 60s, retry | 2 |
| PR already merged | Skip silently | 0 |
| PR closed | Skip silently | 0 |

## Critical Rules

1. **Sequential only** — Branch protection `strict: true` requires each PR to be up-to-date. One at a time.
2. **Never run reviews** — Reviews happen BEFORE this skill. This skill only merges.
3. **Never use `--admin`** — Respect branch protections.
4. **Progress table after every merge** — User can check in anytime.
5. **Copilot review is a hard gate** — Must be present before merge (except old PRs where Copilot won't arrive).
6. **Skip and continue** — Never block the batch on one stuck PR.
7. **Idempotent** — Safe to re-run. Already-merged PRs are detected and skipped.
8. **Handle stale reviews** — Pushing fixes invalidates reviews. Wait for fresh cycle.
9. **Compose with `/fix-ci`** — Don't reinvent CI diagnosis.
10. **No attribution** — Follow project's attribution policy in any fix commits.
<!-- skill-templates: batch-merge 0a76684 2026-06-03 -->
