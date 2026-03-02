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
| 1 | #1570 | feat(dashboard): Add slash commands... | — | — | Queued |
| 2 | #1571 | feat(dashboard): Add file picker... | — | — | Queued |
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

Process PRs in order using an indexed loop:

```bash
for ((i=0; i<${#PR_NUMS[@]}; i++)); do
  PR_NUM=${PR_NUMS[$i]}
  # Steps 2a–2g for each PR
done
```

For each PR:

#### Step 2a: Check CI

```bash
REQUIRED_CHECKS=("Server Tests" "Server Lint" "App Tests" "App Type Check" "Dashboard Tests" "Dashboard Type Check")

CHECKS=$(gh pr checks ${PR_NUM} --json name,state)
```

All required checks must be `SUCCESS` or `SKIPPED`. If any are failing or pending:

- **Pending/Queued:** Poll every 30s for up to 3 minutes.
- **Failed:** Run `/fix-ci ${PR_NUM}`. If fixed, continue. If escalated, mark PR as `Skipped` and continue to next PR.

#### Step 2b: Check Copilot Review

```bash
COPILOT_STATUS=$(gh api repos/${REPO}/pulls/${PR_NUM}/reviews \
  --jq '[.[] | select(.user.login == "copilot-pull-request-reviewer[bot]")] |
    sort_by(.submitted_at) |
    if length == 0 then "NOT_FOUND"
    elif (.[-1].state == "PENDING") then "IN_PROGRESS"
    elif (.[-1].state == "DISMISSED") then "DISMISSED"
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

# Step 1: Get IDs of root comments that already have a reply from the workflow user
REPLIED_IDS=$(echo "$ALL_COMMENTS" | jq --arg user "$WORKFLOW_USER" \
  '[.[] | select(.in_reply_to_id != null and .user.login == $user) | .in_reply_to_id] | unique')

# Step 2: Filter to Copilot-authored top-level comments that have no reply from us
UNREPLIED=$(echo "$ALL_COMMENTS" \
  | jq --argjson replied "$REPLIED_IDS" \
    '[.[] | select(.in_reply_to_id == null)
          | select(.user.login == "copilot-pull-request-reviewer[bot]")
          | select([.id] | inside($replied) | not)]')
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
NEXT_PR=${PR_NUMS[$((i + 1))]}
if [ -n "$NEXT_PR" ]; then
  gh api repos/${REPO}/pulls/${NEXT_PR}/update-branch \
    --method PUT \
    -f expected_head_sha="$(gh pr view ${NEXT_PR} --json headRefOid -q .headRefOid)"
fi
```

If `update-branch` fails with a conflict, fall through to **Step 2e-alt: Manual Rebase**.

##### Step 2e-alt: Manual Rebase (Conflict Resolution)

When `update-branch` API fails with conflicts (common when multiple PRs modify the same files like `InputBar.tsx`), rebase manually:

```bash
NEXT_BRANCH=$(gh pr view ${NEXT_PR} --json headRefName -q .headRefName)

# Validate branch name — reject if it contains shell metacharacters
if ! printf '%s' "$NEXT_BRANCH" | grep -qE '^[a-zA-Z0-9/_.-]+$'; then
  echo "ERROR: Branch name '${NEXT_BRANCH}' contains unsafe characters. Skipping."
  continue  # Skip this PR
fi

git checkout main && git pull origin main
git checkout -- "$NEXT_BRANCH"
git rebase main
```

If rebase has conflicts:

1. For each conflicted file, read the file and resolve by keeping **all HEAD features** (already merged) plus the **incoming branch's additions**
2. Verify no conflict markers remain: `grep -r '<<<<<<' <files>`
3. `git add <files> && git rebase --continue`
4. Run tests: `cd packages/server && npm run dashboard:test`
5. `git push --force-with-lease origin "$NEXT_BRANCH"`
6. Wait for CI (Step 2f)

If rebase conflicts are too complex to resolve (3+ files with deep interleaving), mark PR as `Blocked` and continue to next PR.

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

# Post-loop: check final state
if [ "$ELAPSED" -ge "$MAX_WAIT" ] && [ "$PENDING" != "0" ]; then
  echo "CI still pending after ${MAX_WAIT}s — marking PR #${NEXT_PR} as Pending"
  # Do NOT attempt merge. This PR will be retried when it becomes the active PR
  # in the next loop iteration (Step 2a will poll again).
fi
```

If CI fails after update-branch, run `/fix-ci ${NEXT_PR}`.

#### Step 2g: Update Progress Table

Output the progress table after **every merge**. This is the user's live dashboard.

```markdown
## Merge Progress ({merged}/{total})

| # | PR | Title | CI | Copilot | Merge | Notes |
|---|-----|-------|----|---------|-------|-------|
| 1 | #1290 | feat(dashboard): Add slash... | PASS | Reviewed (0) | Merged | — |
| 2 | #1292 | feat(server): Add list_files... | PASS | Reviewed (1→fixed) | Merged | 1 fix in abc1234 |
| 3 | #1294 | feat(dashboard): Add file... | Updating | — | Next | CI running after rebase |
| 4 | #1300 | feat(dashboard): Add attach... | — | — | Queued | — |
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
| "conflict" / "not mergeable" | Step 2e-alt manual rebase → retry | 1 |
| "already merged" | Skip silently, note in table | 0 |
| Rate limit (403/429) | Back off 60s → retry | 2 |
| Unknown | Log full error, skip PR | 0 |

After max retries exhausted: mark PR as `Skipped` with reason, continue to next PR.

### Phase 4: Session Summary

After all PRs processed:

```markdown
## Batch Merge Complete

**Merged:** {N}/{total} | **Skipped:** {M} | **Blocked:** {K}

| # | PR | Title | Merge | Notes |
|---|-----|-------|-------|-------|
| 1 | #1290 | feat(dashboard): Add slash commands... | Merged | — |
| 2 | #1292 | feat(server): Add list_files endpoint... | Merged | 1 Copilot fix |
| 3 | #1300 | feat(dashboard): Add attachment chips... | Merged | Rebased (conflict in InputBar.tsx) |

### Skipped/Blocked PRs
- **#1572**: Rebase conflicts too complex. Needs manual resolution.

### Copilot Comments Addressed During Merge
- **#1292**: 1 comment → FIX in `abc1234` (added null guard)
```

## Error Recovery

| Error | Recovery | Max Retries |
|-------|----------|-------------|
| CI failure after update-branch | `/fix-ci`, wait, retry merge | 1 |
| Copilot review not posted | Poll every 30s, max 8 min | 16 polls |
| Copilot review dismissed (stale) | Wait for new review cycle | 1 |
| Merge blocked (unknown) | Diagnose via `gh pr checks`, report | 1 |
| update-branch conflict | Manual rebase (Step 2e-alt) | 1 |
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
10. **No attribution** — Follow Zero Attribution Policy in any fix commits.
11. **Rebase before skip** — When update-branch fails with conflicts, attempt manual rebase (Step 2e-alt) before marking as Blocked. This is common when PRs touch shared files.
