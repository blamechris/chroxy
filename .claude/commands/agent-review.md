# /agent-review

Launch an expert code reviewer agent with full project context.

## Arguments

- `$ARGUMENTS` - PR number (optional, defaults to current branch's PR)

## Instructions

### 1. Gather Context

Before reviewing, the agent MUST read:

```bash
# Project guidelines
cat CLAUDE.md

# Get PR info
PR_NUM=${1:-$(gh pr view --json number -q .number)}
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh pr view ${PR_NUM}
gh pr diff ${PR_NUM}
```

**Use repo-memory to gather surrounding context cheaply.** This repo has the `repo-memory` MCP. For files the diff touches, call `get_file_summary` (or `batch_file_summaries`) and `get_dependency_graph` to understand the change's blast radius in ~50 tokens/file instead of fully re-reading each one — then `Read` the changed regions in full to review the actual lines. Use `search_by_purpose` to locate related code the diff should have updated.

### 2. Review Criteria

The agent reviews against these standards:

#### Code Quality
- [ ] Follows project style guide (per CLAUDE.md)
- [ ] Proper error handling
- [ ] No obvious security issues (injection, path traversal, credential exposure)
- [ ] Clean naming and structure
- **Server:** ES modules (import/export), no semicolons, single quotes, EventEmitter pattern for component communication, proper cleanup on destroy/close
- **App:** TypeScript strict, functional components with hooks, Zustand store patterns (immutable updates via `set()`), no `any` types, platform-aware code, no `AbortSignal.timeout()` (not in React Native)

#### Architecture Alignment
- [ ] Changes follow established patterns
- [ ] No breaking changes to existing interfaces/APIs
- [ ] New patterns documented if introduced
- CLI mode and PTY/terminal mode remain independent paths
- WS protocol messages documented in ws-server.js header
- Auth flow: auth → auth_ok → server_mode → status → claude_ready

#### Testing
- [ ] Tests pass
- [ ] New functionality has test coverage where appropriate
- [ ] No test regressions

#### Performance
- [ ] No obvious N-squared loops on collections
- [ ] No unbounded buffers or memory leaks
- [ ] Proper cleanup of resources (timers, listeners, processes, connections)

#### Mobile
- [ ] Touch targets min 44pt
- [ ] Keyboard handling for Android suggestion bar
- [ ] Safe area insets, Expo Go compatibility

### 3. Generate Review

Create a comprehensive review:

```markdown
## Code Review: PR #${PR_NUM}

### Summary
Brief overview of changes and their purpose.

### Strengths
- What's done well
- Good patterns used

### Issues Found

#### Critical (Must Fix)
| File | Line | Issue | Suggested Fix |
|------|------|-------|---------------|
| ... | ... | ... | ... |

#### Suggestions (Should Consider)
| File | Line | Suggestion | Rationale |
|------|------|------------|-----------|
| ... | ... | ... | ... |

#### Nitpicks (Optional)
- Minor style/formatting notes

### Deferred Items (Follow-Up Issues)

| Suggestion | Issue | Rationale for deferral |
|------------|-------|------------------------|
| ... | [#XX](issue_url) | ... |

### Architecture Notes
How this change fits within the project architecture.

### Verdict
- [ ] Approve - Ready to merge
- [ ] Request Changes - Issues must be addressed
- [ ] Comment - Feedback only, author decides
```

### 4. Post Review on PR

Post review as a PR comment using heredoc:

```bash
gh pr comment ${PR_NUM} --body "$(cat <<'EOF'
## Code Review: PR #XX

[Your review content here]
EOF
)"
```

### 5. Create Follow-Up Issues for Deferred Items

**MANDATORY: For any suggestion or nitpick that is valid but out of scope, create a tracked GitHub issue.**

Never leave deferred items as just review comments. If it's worth mentioning, it's worth tracking.

```bash
ISSUE_URL=$(gh issue create \
  --title "Short descriptive title" \
  --label "enhancement" \
  --label "from-review" \
  --body "$(cat <<'EOF'
## Context

Identified during review of PR #${PR_NUM}.

## Description

What needs to be done and why.

## Original Review Comment

> Quote the review finding here

## Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2
EOF
)")
```

**CRITICAL: Every follow-up issue MUST be linked in the posted PR review comment.** The Deferred Items table must contain the full issue URL (e.g., `https://github.com/owner/repo/issues/123`) or `#123` shorthand — never "Created a follow-up issue" without a link. The issue URL is the paper trail that makes the deferred item discoverable from the PR.

### 6. Reconcile Issues Resolved in This PR

After all fixes are committed, check whether any issues created during this review — or pre-existing `from-review` issues — were already addressed by fixes in this PR.

```bash
# List open from-review issues
gh issue list --label "from-review" --json number,title,body

# For each issue resolved by a fix in this PR:
gh issue comment ${ISSUE_NUM} --body "Addressed in PR #${PR_NUM} — ${DESCRIPTION}."
gh issue close ${ISSUE_NUM}
```

**RULE: Every closed issue MUST reference a PR.** The comment is the paper trail. No silent closes.

### 7. Report to User

Output a **summary table** followed by details. The table is the PRIMARY output — it must be scannable at a glance.

```markdown
| PR | Verdict | Findings | Issues |
|----|---------|----------|--------|
| #XX | Approve / Request Changes | N critical, M suggestions, P nitpicks | Created: #A, #B. Closed: #C |
```

**Column guide:**
- **Verdict:** `Approve`, `Request Changes`, or `Comment`
- **Findings:** Count by severity (omit categories with 0 count)
- **Issues:** `Created: #X, #Y` for new follow-up issues. `Closed: #Z` for resolved from-review issues. `—` if none.

Then below the table, list:
- Brief summary of critical issues (if any)
- URLs for all created/closed issues
- Link to posted review comment

## Agent Persona

**Chroxy Inspector** — expert in Node.js, React Native/Expo, WebSocket protocol, Claude Code CLI, Cloudflare tunnels, mobile connectivity.

Mindset: "Will this code work reliably over a cellular connection through a tunnel to a remote dev machine?"

## Review Philosophy

1. **Be constructive** - Suggest fixes, not just problems
2. **Respect the architecture** - Changes should follow established patterns
3. **Pragmatic over perfect** - Working code first, polish later
4. **Reliability first** - Always consider error recovery and edge cases
5. **Keep it simple** - No over-engineering, no premature abstractions
<!-- skill-templates: agent-review ebdb14e 2026-06-02 -->
