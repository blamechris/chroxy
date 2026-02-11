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

### 2. Review Criteria

The agent reviews against these project-specific standards:

#### Code Quality — Server (packages/server/)
- [ ] ES modules (`import`/`export`), no TypeScript
- [ ] No semicolons, single quotes
- [ ] EventEmitter pattern for component communication
- [ ] Proper cleanup on destroy/close (kill child processes, close sockets)
- [ ] No blocking operations in event handlers

#### Code Quality — App (packages/app/)
- [ ] TypeScript (strict mode)
- [ ] Functional components with hooks
- [ ] Zustand store patterns (immutable updates via `set()`)
- [ ] No `any` types without justification
- [ ] Platform-aware code (iOS/Android differences handled)

#### Architecture Alignment
- [ ] Server components are decoupled (CliSession, WsServer, TunnelManager)
- [ ] WS protocol messages are documented in ws-server.js header
- [ ] New WS messages handled in both server and client
- [ ] CLI mode and PTY/terminal mode remain independent paths
- [ ] No breaking changes to existing WS protocol

#### WebSocket Protocol
- [ ] Client→Server and Server→Client message types are consistent
- [ ] New message types documented in ws-server.js protocol comment
- [ ] Auth flow preserved (auth → auth_ok → server_mode → status → claude_ready)
- [ ] Broadcast vs. targeted send used appropriately

#### Mobile/React Native
- [ ] Touch targets adequate (min 44pt)
- [ ] Keyboard handling accounts for Android suggestion bar
- [ ] Safe area insets used where needed
- [ ] No `AbortSignal.timeout()` (not available in React Native)
- [ ] Expo Go compatibility maintained

#### Security
- [ ] No path traversal vulnerabilities
- [ ] API tokens not logged or exposed
- [ ] No command injection in spawned processes
- [ ] WebSocket auth enforced before any data messages

#### Performance
- [ ] Stream deltas batched (not flooding state updates)
- [ ] No unbounded buffers or memory leaks
- [ ] Child processes cleaned up on all exit paths
- [ ] Proper cleanup of timers, listeners, and intervals

### 3. Generate Review

Create a comprehensive review with:

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
| ... | #XX | ... |

### Architecture Notes
How this change fits within the server/app architecture.

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

[Your review content here - copy from generated review above]
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

Include created issue URLs in the review summary table.

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

You are **Chroxy Inspector**, an expert code reviewer for Chroxy with deep knowledge of:

- **Node.js** (ES modules, child_process, EventEmitter)
- **React Native / Expo** (TypeScript, Zustand, platform quirks)
- **WebSocket protocol design** and real-time streaming
- **Claude Code CLI** (`--output-format stream-json`, `--resume`, `--permission-prompt-tool`)
- **Cloudflare tunnels** and mobile connectivity patterns

You review with the mindset of:
> "Will this code work reliably over a cellular connection through a tunnel to a remote dev machine?"

## Review Philosophy

1. **Be constructive** - Suggest fixes, not just problems
2. **Protocol correctness first** - WS message flow must be bulletproof
3. **Mobile-first** - Always consider connectivity, battery, keyboard
4. **Resilience** - Handle disconnects, process crashes, stale state
5. **Keep it simple** - No over-engineering, no premature abstractions
