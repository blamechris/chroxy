# /full-review

Run a complete review pipeline: agent-review first, then check-pr. The agent-review pass naturally fills the ~4 minute Copilot review delay, so check-pr starts with comments already waiting.

## Arguments

- `$ARGUMENTS` - PR number (optional, defaults to current branch's PR)

## Instructions

### Phase 1: Agent Review

Run the `/agent-review` skill on the PR. This is a deep expert review that:
- Reads CLAUDE.md and the full PR diff
- Reviews against project-specific code quality, architecture, and testing criteria
- Posts a review comment on the PR
- Creates follow-up issues for deferred suggestions
- Reconciles any from-review issues resolved by this PR

**Capture the results:** verdict, findings counts, issues created/closed.

### Phase 2: Check-PR

After agent-review completes, run the `/check-pr` skill on the same PR. By now, Copilot review has typically arrived (~4 min). This skill:
- Waits for Copilot review if still pending (Step 0 polling)
- Processes every review comment (Copilot + human + agent-review findings if inline)
- Fixes, dismisses, or defers each comment with inline replies
- Pushes all fixes and verifies every thread has a reply
- Cross-references fixes against open from-review issues

**Capture the results:** comments processed, fixes committed, issues created/closed.

### Phase 3: Combined Summary

Output a **single combined summary table** covering both phases. This is the PRIMARY output.

```markdown
| PR | Review | Check-PR | Changes | Issues |
|----|--------|----------|---------|--------|
| #XX | Verdict (N critical, M suggestions) | P comments → Q fixed | brief change 1, change 2 | Created: #A, #B. Closed: #C, #D |
```

**Column guide:**
- **Review:** Verdict + finding counts from agent-review
- **Check-PR:** `N comments → M fixed` (add `, X false pos` / `, Y deferred` if any)
- **Changes:** Comma-separated brief descriptions of what changed (2-5 words each, from check-pr fixes)
- **Issues:** Combined from both phases. `Created: #X` for new follow-ups. `Closed: #Y` for resolved issues. Deduplicate (agent-review may create issues that check-pr then closes).

Then below the table:
- Full commit hashes for each fix
- Reasons for any false positives
- URLs for all created/closed issues
- PR ready for re-review: Yes/No

## Execution Notes

- **Sequential, not parallel.** Agent-review MUST complete before check-pr starts. This is by design — the delay lets Copilot review arrive.
- **Same branch.** Both skills operate on the same PR branch. Check-pr may commit fixes on top of the reviewed code.
- **Deduplication.** If agent-review creates a follow-up issue and check-pr's fixes resolve it, close the issue in Phase 2 with a PR cross-reference.
- **Attribution.** Follow Zero Attribution Policy throughout — no AI mentions in commits, replies, or issues.
