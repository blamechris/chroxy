# /check-pr

Address all PR review comments systematically and respond inline.

## Arguments

- `$ARGUMENTS` - PR number (optional, defaults to current branch's PR)

## Instructions

### 0. Wait for Automated Reviews

Copilot review typically takes **3-5 minutes** after PR creation to even begin. If you run `/check-pr` immediately after creating the PR, the review won't exist yet.

**IMPORTANT:** Do NOT skip this step. If no Copilot review exists and the PR was created recently (within 5 min), you MUST wait — otherwise you'll process zero comments and miss the entire review.

```bash
PR_NUM=${1:-$(gh pr view --json number -q .number)}
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# Check how old the PR is
PR_AGE_SECONDS=$(gh pr view ${PR_NUM} --json createdAt \
  --jq "((now - (.createdAt | fromdateiso8601)))")

# Check Copilot review status
COPILOT_STATUS=$(gh api repos/${REPO}/pulls/${PR_NUM}/reviews \
  --jq '[.[] | select(.user.login == "copilot-pull-request-reviewer[bot]")] | if length == 0 then "NOT_FOUND" elif (.[0].state == "PENDING") then "IN_PROGRESS" else "COMPLETED" end')

# If no review exists yet AND PR is less than 5 min old, wait for it to appear
if [ "$COPILOT_STATUS" = "NOT_FOUND" ] && [ "${PR_AGE_SECONDS%.*}" -lt 300 ]; then
  echo "PR is ${PR_AGE_SECONDS%.*}s old. Copilot review not yet started. Waiting (polls every 30s, max 5 min)..."
  for i in $(seq 1 10); do
    sleep 30
    COPILOT_STATUS=$(gh api repos/${REPO}/pulls/${PR_NUM}/reviews \
      --jq '[.[] | select(.user.login == "copilot-pull-request-reviewer[bot]")] | if length == 0 then "NOT_FOUND" elif (.[0].state == "PENDING") then "IN_PROGRESS" else "COMPLETED" end')
    [ "$COPILOT_STATUS" != "NOT_FOUND" ] && echo "Copilot review detected (status: $COPILOT_STATUS)" && break
  done
fi

# If review is in progress, wait for it to complete
if [ "$COPILOT_STATUS" = "IN_PROGRESS" ]; then
  echo "Copilot review in progress. Polling every 30s (max 5 min)..."
  for i in $(seq 1 10); do
    sleep 30
    COPILOT_STATUS=$(gh api repos/${REPO}/pulls/${PR_NUM}/reviews \
      --jq '[.[] | select(.user.login == "copilot-pull-request-reviewer[bot]")] | if length == 0 then "NOT_FOUND" elif (.[0].state == "PENDING") then "IN_PROGRESS" else "COMPLETED" end')
    [ "$COPILOT_STATUS" != "IN_PROGRESS" ] && break
  done
fi
```

### 1. Fetch PR Info

```bash
# Fetch all review comments (inline) — paginate to avoid truncation
gh api repos/${REPO}/pulls/${PR_NUM}/comments --paginate

# Fetch all reviews
gh api repos/${REPO}/pulls/${PR_NUM}/reviews

# Fetch issue-level comments (to check if previous check-pr already ran)
gh api repos/${REPO}/issues/${PR_NUM}/comments
```

### 2. Skip Already-Replied Comments (Idempotency)

Before processing, filter out comments that already have replies from this workflow.
This makes `/check-pr` safe to re-run without duplicating work.

```bash
# Fetch all review comments with reply threading info
ALL_COMMENTS=$(gh api repos/${REPO}/pulls/${PR_NUM}/comments --paginate)

# Determine the current workflow user (used to detect this workflow's replies)
WORKFLOW_USER=$(gh api user --jq .login)

# Build list of comment IDs that already have replies FROM THIS WORKFLOW (filter by author)
REPLIED_IDS=$(echo "$ALL_COMMENTS" | jq --arg user "$WORKFLOW_USER" \
  '[.[] | select(.in_reply_to_id != null and .user.login == $user) | .in_reply_to_id] | unique')

# Filter to only unprocessed top-level comments (no existing reply from this workflow)
PENDING_COMMENTS=$(echo "$ALL_COMMENTS" \
  | jq --argjson replied "$REPLIED_IDS" \
    '[.[] | select(.in_reply_to_id == null) | select([.id] | inside($replied) | not)]')
```

Only process comments in `PENDING_COMMENTS`. If all comments already have replies, report "All comments already addressed" and exit.

### 3. Process EVERY Pending Comment — ONE AT A TIME

For each pending review comment (Copilot or human), you MUST do ALL of these steps **before moving to the next comment**:

1. Read the comment carefully
2. Classify it into exactly ONE of the three valid outcomes below
3. Take the required action AND post a reply

**CRITICAL: The inline reply (`gh api ... /comments/${COMMENT_ID}/replies`) is the PRIMARY output of this skill.** The summary comment is secondary. If you only post a summary without inline replies, the skill has FAILED — conversation threads will remain unresolved and block merging.

**Default stance: FIX IT NOW** — Only defer if the suggestion is a false positive or requires scope expansion (tracked via follow-up issue).

**CRITICAL: There are ONLY THREE valid outcomes for each comment. Every comment MUST result in one of these:**

1. **FIX** — Make the code change, commit, reply with commit hash + before/after code
2. **FALSE POSITIVE** — Reply explaining why the suggestion is incorrect, with evidence
3. **FOLLOW-UP ISSUE** — Create a GitHub issue, reply with the issue URL

**There is NO "acknowledge and move on" option.** If a suggestion is valid but out of scope, you MUST create a follow-up issue. Never reply with "good idea, maybe later" without an issue link.

**REPLY FORMAT IS NON-NEGOTIABLE.** Every reply MUST start with the bold label (`**FIX**`, `**FALSE POSITIVE**`, or `**FOLLOW-UP ISSUE**`) on its own line. Replies without this label are malformed and will be rejected.

### Reply Format Examples

Study these examples. Your replies must match this structure exactly.

#### Example: FIX reply

> **FIX**
>
> Fixed in `7bab8be4`
>
> **Change:** Added `marginBottom: 4` to `promptHeaderRow` so spacing is owned by the row container.
>
> ```diff
> - promptHeaderRow: {
> -   flexDirection: 'row',
> -   justifyContent: 'space-between',
> -   alignItems: 'center',
> - },
> + promptHeaderRow: {
> +   flexDirection: 'row',
> +   justifyContent: 'space-between',
> +   alignItems: 'center',
> +   marginBottom: 4,
> + },
> ```

#### Example: FALSE POSITIVE reply

> **FALSE POSITIVE**
>
> **Reason:** The `remaining <= 0` in the dependency array is intentional — it acts as a boolean gate that prevents the effect from re-creating an interval once the countdown reaches zero.
>
> **Evidence:**
> - Without it, the effect would restart on every `expiresAt` change even after expiry
> - Same pattern used in React docs for "run once then stop" effects
> - The expression evaluates to a stable `true`/`false`, not a changing number

#### Example: FOLLOW-UP ISSUE reply

> **FOLLOW-UP ISSUE**
>
> Created https://github.com/blamechris/chroxy/issues/525 to track this.
>
> **Reason for deferral:** Switching from absolute `expiresAt` to relative `remainingMs` requires changing the WS protocol contract and both server broadcast paths — out of scope for this countdown UI PR.

---

#### Outcome 1: FIX IMMEDIATELY (default)

When the comment identifies a real issue, fix it immediately.

**Required in reply:** commit hash AND before/after code diff. Both are mandatory.

1. Make the code fix
2. Commit with descriptive message (NO attribution — no Co-Authored-By, no "Generated with", no AI mentions)
3. Reply inline with the EXACT format below:

```bash
gh api repos/${REPO}/pulls/${PR_NUM}/comments/${COMMENT_ID}/replies \
  --method POST \
  -f body="**FIX**

Fixed in \`${COMMIT_SHA}\`

**Change:** Brief description of fix

\`\`\`diff
- old_code_line
+ new_code_line
\`\`\`"
```

**NEVER post a fix reply without the commit SHA and a code diff.** If you fixed it, prove it.

---

#### Outcome 2: FALSE POSITIVE (evidence REQUIRED)

Only use this if the suggestion is factually incorrect. You MUST provide evidence.

**Required in reply:** specific evidence why the comment is wrong (doc reference, code reference, or logical proof).

```bash
gh api repos/${REPO}/pulls/${PR_NUM}/comments/${COMMENT_ID}/replies \
  --method POST \
  -f body="**FALSE POSITIVE**

**Reason:** Clear explanation of why this is correct

**Evidence:**
- Reference to docs/pattern used (e.g., 'per CLAUDE.md: no semicolons')
- Link to similar code in codebase"
```

---

#### Outcome 3: FOLLOW-UP ISSUE (GitHub issue creation MANDATORY)

When a suggestion is valid but out of scope for this PR. You MUST create a GitHub issue — never reply with just "good idea" or "noted for later" without an issue URL.

**Required in reply:** the created issue URL. No exceptions.

```bash
# 1. ALWAYS create the issue — this is NOT optional
ISSUE_URL=$(gh issue create \
  --title "Short descriptive title" \
  --label "enhancement" \
  --label "from-review" \
  --body "$(cat <<'EOF'
## Context

Identified during review of PR #${PR_NUM}.

## Description

What needs to be done and why.

## Original Comment

> Quote the review comment here verbatim

## Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2
EOF
)")

# 2. Reply inline referencing the issue — MUST include the FULL issue URL
# NEVER write "Created a follow-up issue" without the URL. The URL is the whole point.
gh api repos/${REPO}/pulls/${PR_NUM}/comments/${COMMENT_ID}/replies \
  --method POST \
  -f body="**FOLLOW-UP ISSUE**

Created ${ISSUE_URL} to track this.

**Reason for deferral:** Brief explanation why not in this PR"
```

---

**INVALID outcomes (never use these):**

- "Good idea, we should do this later" without an issue URL
- "Follow-up." or "Deferred." without a `**FOLLOW-UP ISSUE**` label and issue URL
- "Intentional design decision" without evidence — use FALSE POSITIVE with evidence instead
- "Noted" / "Acknowledged" without a FIX or ISSUE URL
- Any reply that doesn't start with `**FIX**`, `**FALSE POSITIVE**`, or `**FOLLOW-UP ISSUE**`
- Empty Reference cells in the summary table

### 4. Push All Fixes

```bash
git push
```

### 5. Cross-Reference Fixes Against Open Issues

After pushing fixes, check if any open `from-review` issues were resolved by the work in this PR. This commonly happens when Copilot feedback addresses the same problem an agent-review issue was tracking.

```bash
# List open from-review issues
gh issue list --label "from-review" --state open --limit 100 --json number,title,body,url

# For each fix, check if an open issue describes the same problem.
# If so, close it with a comment linking the PR:
gh issue comment ${ISSUE_NUM} --body "Addressed in PR #${PR_NUM} — ${DESCRIPTION}."
gh issue close ${ISSUE_NUM}
```

**RULE: Every closed issue MUST reference a PR.** The comment is the paper trail. No silent closes.

### 6. Verify All Inline Replies Were Posted

**This step is MANDATORY. Do NOT skip it.**

```bash
# Count root comments (not replies) from reviewers
ROOT_COUNT=$(gh api repos/${REPO}/pulls/${PR_NUM}/comments --paginate \
  --jq '[.[] | select(.in_reply_to_id == null)] | length')

# Count unique root comments that have at least one reply
REPLIED_COUNT=$(gh api repos/${REPO}/pulls/${PR_NUM}/comments --paginate \
  --jq '[.[] | select(.in_reply_to_id != null) | .in_reply_to_id] | unique | length')

echo "Root comments: ${ROOT_COUNT}, Replied: ${REPLIED_COUNT}"
```

If `REPLIED_COUNT < ROOT_COUNT`, you have UNREPLIED comments. Go back to step 3 and post the missing inline replies BEFORE proceeding. **Do NOT post the summary comment until every thread has a reply.**

### 7. Post Summary Comment

After addressing ALL comments, post a summary on the PR. **Every row MUST have a commit hash or issue URL — no empty cells.**

```bash
gh pr comment ${PR_NUM} --body "$(cat <<'EOF'
## Review Comments Addressed

| # | Comment | Outcome | Reference |
|---|---------|---------|-----------|
| 1 | Comment 1 summary | FIX | `abc1234` |
| 2 | Comment 2 summary | FALSE POSITIVE | Evidence: [brief] |
| 3 | Comment 3 summary | FOLLOW-UP | #456 |

**Total:** X comments addressed
- Fixed: Y (commit hashes above)
- False positives: Z (with evidence)
- Follow-up issues created: V (linked above)
- Existing issues closed: W
EOF
)"
```

**Summary table rules:**
- The **Reference** column must NEVER be empty
- FIX rows: commit hash (e.g., `abc1234`)
- FALSE POSITIVE rows: brief evidence summary
- FOLLOW-UP rows: issue URL or auto-linked issue number (e.g., `#456`)

### 8. Report to User

Output a **summary table** followed by details. The table is the PRIMARY output — it must be scannable at a glance.

```markdown
| PR | Comments | Changes | Issues |
|----|----------|---------|--------|
| #XX | N → Y fixed, Z false pos | brief change 1, brief change 2 | Created: #A, #B. Closed: #C |
```

**Column guide:**
- **Comments:** `N → Y fixed` (and `, Z false pos` / `, W deferred` if any)
- **Changes:** Comma-separated brief descriptions of what changed (2-5 words each). Works for fixes, features, refactors — keep it generic.
- **Issues:** `Created: #X, #Y` for new follow-up issues. `Closed: #Z` for resolved from-review issues. `—` if none.

Then below the table, list:
- Full commit hashes for each fix
- Reasons for any false positives
- URLs for created/closed issues
- PR ready for re-review: Yes/No

## Critical Rules

1. **EVERY pending comment gets a reply** — No silent dismissals. The `gh api .../replies` call is the MOST IMPORTANT output. A summary comment WITHOUT inline replies is a FAILURE.
2. **Reply IMMEDIATELY after each comment** — Process one comment at a time: read → fix/defer → post inline reply → next. Do NOT batch all fixes and try to reply later.
3. **Exactly 3 valid outcomes** — FIX, FALSE POSITIVE, or FOLLOW-UP ISSUE. Nothing else.
4. **FIX requires commit hash + code diff** — Both mandatory in reply
5. **FALSE POSITIVE requires evidence** — No bare dismissals
6. **FOLLOW-UP requires issue URL** — Never say "good idea" without creating an issue
7. **Summary table has no empty cells** — Every row has a reference
8. **Verify before summarizing** — Run the verification step (step 6) and confirm all threads have replies BEFORE posting the summary comment. If any are missing, go back and post them.
9. **Idempotent** — Safe to re-run; already-replied comments are skipped (author-filtered)
10. **No attribution** — Follow Zero Attribution Policy (no Co-Authored-By, no "Generated with Claude", no AI mentions anywhere)

## Example Workflow

```
1. Run /check-pr 42
2. Poll Copilot review... ready (state: COMPLETED)
3. Fetch 5 comments, 2 already replied → 3 pending
4. Comment A: "Missing null check on line 45"
   → Outcome: FIX
   → Commit fix, reply with **FIX** + hash + before/after diff
5. Comment B: "This variable seems unused"
   → Outcome: FALSE POSITIVE
   → Reply with **FALSE POSITIVE** + evidence: "Used on line 78 in _process()"
6. Comment C: "Add retry logic for network calls"
   → Outcome: FOLLOW-UP ISSUE
   → Create issue #99 with labels, reply with **FOLLOW-UP ISSUE** + URL
7. Push fixes
8. Verify all threads have replies (step 6)
9. Post summary table (all Reference cells filled)
10. Report to user
```
