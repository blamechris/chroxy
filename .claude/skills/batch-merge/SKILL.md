---
description: "Merge an authorized set of PRs sequentially through the same review, CI and delivery gates used for a single PR."
---

# /batch-merge

Merge an authorized set of PRs sequentially through the same review, CI and delivery gates used for a single PR. Handle dependencies and branch freshness, verify each merge, and record delivery before moving on. This skill coordinates `/full-review`, `/check-pr`, `/fix-ci` and `/merge-gate`; it never calls `/merge`, which may itself call this skill.

## Arguments

- `$ARGUMENTS` — explicit PR numbers, `all` only when the user expressly requested all open PRs targeting main, or `--dry-run` for a read-only preview.
- Examples: `1570 1571 1572`, `all`, `1570 1571 --dry-run`.
- An orchestrator may supply its already-authorized PR set, dependency order, ledger and shared repair/budget limits. An empty argument does not authorize every open PR.

## Instructions

### Phase 0: Build the Authorized Queue

Read the selected PRs and the caller's durable state. Confirm repository, base, current head, open/draft status and scope. Remove closed entries; verify already-merged entries and distinguish earlier delivery from work merged by this run. Drafts retain their actual readiness gap. Never silently add unrelated existing PRs.

Gated merge authority is the same in ordinary and prime-directive runs: proceed for delegated implementation once its gates pass. Preserve explicit user holds, required human approvals and unavailable permissions. Display the queue and continue under existing authorization; do not add a routine queue-confirmation pause. Ask only for genuinely missing scope or an owner-reserved action.

Order by verified dependencies, then retain the supplied order for independent PRs. A blocked prerequisite blocks its dependents; independent ready PRs may proceed. Merge order by itself is an execution detail.

For `--dry-run`, inspect current state and report the proposed order and missing gates, then return. Do not launch posting/fixing reviews, update branches, resolve threads, create issues or merge.

### Phase 1: Establish Bounded State

Use the caller's ledger, stable run identity and consumed allowances. Standalone, record the PR queue, dependency edges, current head, review coverage, CI state, disposition evidence, attempts and verified merges in a session ledger (`autonomous-session-<date>.md` at repo root — gitignored, never commit). Restore existing state on retry; never reset consumption because no merge occurred.

Absent a caller-specified limit, allow at most **one corrective round per PR** and **one branch-update recovery per PR** in this batch. Record the round before edits and share it with nested review/CI skills; nested calls do not grant extra rounds. A remaining blocking finding at the limit stays blocked while independent PRs proceed. Read-only classification does not consume a corrective round. Do not infer unused caller allowance from missing accounting.

For pending remote work, use the host's supported event/status/continuation mechanism. Respect configured waits and host restrictions; do not introduce prohibited CI polling or repeatedly issue unchanged checks. A wait timeout leaves the gate pending, not passed. Report a real host limitation if supported continuation is unavailable.

### Phase 2: Sequential Merge Loop

**Sequential only:** process one PR's merge at a time. Recompute its prerequisite and base/head state immediately before entering its gates.

#### Step 2a: Reconcile Branch Freshness

If a prerequisite remains unmerged, retain its dependent PR as blocked and select an independent ready PR. If main has advanced, determine whether protection or the PR's changes require an update. For an authorized owned branch, an `update-branch` request can use the current head as its expected value:

```bash
# EXPECTED_HEAD is the full SHA just read for this PR; if it changes, inspect again.
gh api "repos/${REPO}/pulls/${PR_NUM}/update-branch" --method PUT \
  -f expected_head_sha="${EXPECTED_HEAD}"
```

Do not update a branch blindly. Preserve unrelated dirty work and use an owned worktree for conflict or code fixes. A recoverable conflict is agent work within scope and remaining limits; otherwise record the exact dependency. Every push, conflict resolution or base update invalidates stale gate readings. Read the new head and continue through review and CI again.

#### Step 2b: Verify Independent Review and Posted Feedback

The quality gate is a clean `/full-review` covering the current head, with an independent reviewer and triage of **all posted Copilot, human and agent findings**, including general summaries. Existing review evidence may be reused only when its head coverage and dispositions are verified. A review-comment count, old CLEAN label, dismissed review or thread reply does not establish that gate.

If evidence is absent or changes are uncovered, run `/full-review ${PR_NUM}` with the shared limits. After additional commits, include independent fix-delta verification. Check `dismiss_stale_reviews` requirements: obtain a fresh Copilot review or other approval when repository rules require it. A required pending review remains blocking regardless of PR age; an optional unavailable Copilot review may be recorded and skipped without skipping independent review or posted feedback.

Use `/check-pr` to verify impact and disposition:

- **FIX:** repair a blocking correctness, security, data-integrity or promised-acceptance defect, remove the defective change, or verify acceptable containment.
- **FALSE POSITIVE:** explain why the claim is unsupported, with evidence.
- **FOLLOW-UP ISSUE:** document an eligible low-impact nonblocking finding with its issue, impact and acceptance evidence. This includes minor introduced findings when delivery remains acceptable; it need not cause another CI cycle.

A blocking finding is not cleared by an issue link or a short estimate. Resolve only threads with supported current-head dispositions through `/check-pr` step 6b's paginated GraphQL `resolveReviewThread` procedure. Never resolve every open thread on the assumption that an earlier review handled it. Findings without threads have the same acceptance requirements.

#### Step 2c: Verify Final-Head CI

Read the current head SHA and check results through supported host tools. **ALL CI checks must pass on the final commit** under the repository's check policy; a documented intentionally skipped check may count only when that policy accepts it. Empty results, a prior commit's results, pending/unknown state or a failed required check do not pass.

Use `/fix-ci` for a verified failure within the same recorded corrective allowance. After **any fix or branch update**, return to Step 2b to review uncovered changes and then re-run Step 2c against the new head. This includes fixes made by `/fix-ci` itself. No path goes directly from a pushed fix to merge.

#### Step 2d: Merge and Verify

Immediately before merging, reconcile the current head and base with the checked evidence. Require clean independent `/full-review`, all final-head CI passing, ALL review threads resolved with supported dispositions, required approvals and repository protection satisfied, and no explicit user hold. If evidence changed, revisit the affected gates.

Verify that repository policy permits synchronous merge. If a merge queue is required, report that policy dependency rather than silently enqueueing or bypassing it. Never use `gh pr merge --auto`, GitHub auto-merge or `--admin`.

```bash
# CHECKED_HEAD is the full SHA whose review, CI and thread gates just passed.
# Merge strategy: always --squash --delete-branch
gh pr merge ${PR_NUM} --squash --delete-branch --match-head-commit "${CHECKED_HEAD}"
gh pr view ${PR_NUM} --json state,mergeCommit,mergedAt
```

Require `MERGED`, capture the merge SHA and verify it is reachable from current `origin/main` before recording the delivered result. If the head moved, recheck instead of retrying against unchecked code. A successful command exit or queued merge is not delivery evidence.

#### Step 2e: Record and Advance

Immediately append the outcome, PR, reviewed/checked head, review verdict, CI evidence, merge SHA and follow-up issues to the ledger. Show a concise progress table after every merge, then read the next PR's actual state. Main changed, so Step 2a runs again; do not reuse the next PR's pre-flight CI or review assumptions.

| PR | Review / CI at head | Merge | Remaining gate |
|----|---------------------|-------|----------------|
| #1570 | Clean / PASS at `head-sha` | Merged `merge-sha` | none |
| #1571 | Clean / pending at `head-sha` | Pending | CI completion |
| #1572 | Unchecked | Blocked | depends on #1571 |

### Phase 3: Recover a Failed Gate

Use `/merge-gate` to identify the actual requirement from current-head evidence; it does not call `/merge` or restart this batch. Handle supported CI/review/branch remediation inside the shared allowances. Re-enter Steps 2a–2d after any change. Do not lower requirements to make the retry pass.

| Verified condition | Action |
|--------------------|--------|
| Branch behind / owned conflict | Update or repair within remaining allowance; repeat affected review and CI gates |
| CI failure | `/fix-ci` within the shared corrective round; return to review and fresh CI |
| Unaddressed finding / conversation | `/check-pr`; verify disposition before resolving; review fixes and verify new CI |
| Required human approval / permission | Record exact owner action and what the agent resumes afterward |
| Pending review / CI | Supported host continuation; preserve pending state and advance independent work |
| Rate limit | Honor the retry interval through supported waiting; at most two retries, preserving consumption |
| Unknown or exhausted recovery | Record evidence and precise unresolved gate; advance only independent work |
| Already merged | Verify merge state/SHA and reconcile ledger without duplicate credit |

Re-evaluate a blocked PR when its recorded prerequisite arrives, within its existing authority and remaining allowance. A user supplying access or approval does not take over the remaining review, merge or recording steps.

### Phase 4: Return or Finish

Report the actual merged PRs, merge SHAs, documented follow-ups and exact remaining gates from the ledger. Do not claim a completed batch while gates remain pending. End with the global concise status block and next-action line, identifying a real owner action only when required.

If called by `/merge` or another orchestration skill, return this evidence to the caller for authorized post-merge work and its mode boundary. Standalone ordinary development finishes the bounded feature through delivery and ledger, then `/session-lifecycle` writes the verified seed and instructs the user to start a fresh session. Prime-directive runs checkpoint the same state and continue the authorized mission using supported host continuation/compaction. A completed batch does not expand the delegated scope.

## Critical Rules

1. **Sequential only** — verify dependencies and current state before each merge.
2. **Review the current head** — mandatory independent `/full-review`, posted feedback triage and supported dispositions; reuse verified coverage, not stale labels.
3. **Never use `--admin`** — no protection override, `gh pr merge --auto` or GitHub auto-merge.
4. **Progress table after every merge** — record the verified merge in the ledger first.
5. **Required reviews stay required** — PR age does not waive a Copilot or human approval requirement.
6. **Block only dependent work** — one failed gate does not stop independent ready PRs.
7. **Idempotent** — preserve shared counters and verified ledger entries across retries; no duplicate delivery credit.
8. **Changes repeat the gates** — fixes and base updates require covered review and final-head CI before merge.
9. **Compose supported recovery** — `/fix-ci`, `/check-pr` and `/merge-gate`; never recursively invoke `/merge`.
10. **No attribution** — follow Zero Attribution Policy in commits, comments and reports.
