# /start-working

Scan all work sources — GitHub issues, open PRs, roadmap files, audit outputs, codebase TODOs — to determine what to work on next. If nothing actionable is found, perform a lightweight codebase audit to surface potential investigations.

This skill is **read-only** — it never writes files, creates issues, or commits. It's a triage tool that feeds naturally into `/autonomous-dev-flow` or manual work.

## Arguments

- `$ARGUMENTS` - Optional filters. Space-separated tokens:
  - `focus=AREA` — Narrow to a specific area (e.g., `focus=testing`, `focus=security`, `focus=performance`)
  - `limit=N` — Max items to show per source (default: 10)
  - `include-closed` — Also scan recently closed issues (last 7 days) for context
  - If empty, scan everything with defaults

Examples:
```
/start-working
/start-working focus=testing
/start-working limit=5
/start-working focus=security include-closed
```

## Instructions

### 0. Setup

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
REPO_NAME=$(basename "$REPO")
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
```

Parse `$ARGUMENTS` for `focus`, `limit` (default 10), and `include-closed` flag.

Read CLAUDE.md and any `.claude/rules/` files to understand the project's conventions, priorities, and known issues.

### 1. Gather Work Sources

Collect data from all sources. Run independent queries in parallel where possible.

#### 1a. GitHub Issues

```bash
# Open issues sorted by updated date (most recent activity first)
gh issue list --state open --json number,title,labels,assignees,milestone,createdAt,updatedAt --limit 50

# If include-closed flag set, also grab recently closed for context
gh issue list --state closed --json number,title,labels,closedAt --limit 20
```

Categorize each open issue:

| Category | Detection |
|----------|-----------|
| Blocked | Has label matching: `blocked`, `wontfix`, `needs-design` |
| Assigned | Has assignees (someone is already working on it) |
| Ready | Unblocked, unassigned `enhancement` and `from-review` issues |
| Backlog | Open, unassigned, not blocked, but no explicit "ready" signal |

For "Ready" and "Backlog" issues, read the issue body to check for acceptance criteria:

```bash
gh issue view ${ISSUE_NUM} --json body -q .body
```

Issues with clear acceptance criteria rank higher than vague ones.

#### 1b. Open PRs Needing Attention

```bash
# All open PRs with review and check status
gh pr list --state open --json number,title,author,reviewDecision,isDraft,headRefName,createdAt,updatedAt --limit 20
```

Flag PRs that need attention:

| Signal | Meaning |
|--------|---------|
| `reviewDecision: CHANGES_REQUESTED` | Review feedback needs addressing |
| `isDraft: true` | Work in progress — may be stale |
| Stale (no update in 7+ days) | Forgotten PR — needs decision (finish, close, or rebase) |

Also check CI status for open PRs:

```bash
# For each open PR, check if CI is failing
gh pr checks ${PR_NUM} --json name,state --jq '[.[] | select(.state != "SUCCESS" and .state != "SKIPPED")]'
```

#### 1c. Roadmap and Planning Files

Scan for planning documents in common locations:

```bash
# Common roadmap/planning file patterns
```

Search for these files (check existence, don't fail if missing):
- `ROADMAP.md`, `TODO.md`, `CHANGELOG.md` (for recent/planned entries)
- `docs/roadmap/`, `docs/planning/`, `docs/TODO/`

For each found file, scan for:
- Unchecked items (`- [ ]`)
- Sections labeled "Planned", "Next", "Upcoming", "TODO", "Backlog"
- Items not yet represented as GitHub issues

#### 1d. Audit Output Files

Check for existing audit reports:

```bash
# Look for project-audit output
ls docs/project-audit/ 2>/dev/null
ls docs/audits/ 2>/dev/null

# Also check for from-audit issues that are still open
gh issue list --state open --label "from-audit" --json number,title,labels --limit 20 2>/dev/null

# And from-review issues (deferred work from PR reviews)
gh issue list --state open --label "from-review" --json number,title,labels --limit 20 2>/dev/null
```

If audit reports exist, read the master assessment for any unaddressed recommendations (check if corresponding issues exist).

#### 1e. Codebase TODOs

Scan for TODO/FIXME/HACK markers in source code:

```bash
# Search for actionable markers in server and app files
grep -r "TODO\|FIXME\|HACK\|XXX\|WORKAROUND" server/**/*.js app/**/*.tsx app/**/*.ts 2>/dev/null | grep -v node_modules | grep -v .godot | grep -v build | grep -v dist
```

Use Grep to find `TODO`, `FIXME`, `HACK`, `XXX`, and `WORKAROUND` markers in source files. Exclude:
- `node_modules/`, `.godot/`, `build/`, `dist/`, vendor directories
- Test fixtures and generated files
- Lock files

Collect file path, line number, and the marker text for each hit.

### 2. Prioritize and Deduplicate

#### 2a. Assign Priority Tiers

Map every finding to a unified priority tier:

| Tier | Label | Signals |
|------|-------|---------|
| P0 | Immediate | PRs with `CHANGES_REQUESTED`, open `bug` issues, failing CI on open PRs |
| P1 | High | `from-review` issues, milestone-assigned issues, stale PRs |
| P2 | Normal | `enhancement` issues with acceptance criteria, `from-audit` issues, roadmap items |
| P3 | Exploratory | Codebase TODOs, vague issues without criteria, audit recommendations without issues |

If `focus=AREA` was specified, boost items matching that area by one tier (P2→P1, P3→P2).

#### 2b. Deduplicate

Cross-reference findings across sources:
- If a roadmap item already has a GitHub issue → keep the issue, drop the roadmap entry (note the link)
- If an audit recommendation already has a `from-audit` issue → keep the issue, drop the audit entry
- If a TODO in code references an issue number (e.g., `TODO(#42)`) → link to the issue, don't list separately
- If multiple TODOs relate to the same theme → group them as one item

#### 2c. Apply Focus Filter

If `focus=AREA` is set, filter to only show items related to that area. Match against:
- Issue labels
- Issue title/body keywords
- File paths (e.g., `focus=testing` matches test files)
- TODO context

### 3. Present Work Queue

Output the primary summary table, then detail sections for each source.

#### Primary Output — Work Queue Table

```markdown
## What's Next for ${REPO_NAME}

**Sources scanned:** GitHub issues, open PRs, roadmap files, audit outputs, codebase TODOs
**Found:** ${TOTAL_ITEMS} actionable items across ${SOURCE_COUNT} sources

### Work Queue

| Priority | Source | Item | Why |
|----------|--------|------|-----|
| P0 | PR | #45 — Failing CI, changes requested | Review feedback unaddressed for 3 days |
| P0 | Issue | #12 — Login broken on Android | Bug, reported 2 days ago |
| P1 | Issue | #18 — Add retry logic to API | from-review, has acceptance criteria |
| P1 | PR | #38 — Draft PR stale 14 days | Needs decision: finish or close |
| P2 | Issue | #25 — Improve error messages | enhancement, milestone v1.2 |
| P2 | Roadmap | Add rate limiting | In ROADMAP.md, no issue yet |
| P3 | TODO | 5× FIXME in src/auth/ | Scattered workarounds for token refresh |
| P3 | Audit | Upgrade vulnerable deps | From project-audit, no issue created |
```

#### Detail Sections

After the summary table, provide detail sections only for sources that had findings:

**GitHub Issues** (if any):
```markdown
### Open Issues ({N} total, {M} ready, {K} blocked)

**Ready to work on:**
- #18 — Add retry logic to API (`from-review`, `complexity:low`) — has 3 acceptance criteria
- #25 — Improve error messages (`enhancement`) — milestone v1.2

**Blocked / Needs input:**
- #30 — Choose auth provider (`needs-design`) — requires decision
- #35 — Blocked by #18 (`blocked`)

**Assigned (in progress):**
- #22 — Refactor auth module — assigned to @user
```

**Open PRs** (if any):
```markdown
### Open PRs Needing Attention ({N})

- **#45** — Fix login flow: Changes requested 3 days ago, CI failing
- **#38** — Add caching layer: Draft, no updates in 14 days
```

**Roadmap Items** (if any):
```markdown
### Roadmap Items Not Yet Tracked ({N})

Items from planning docs without corresponding GitHub issues:
- Add rate limiting (ROADMAP.md line 42)
- Implement offline mode (ROADMAP.md line 58)
```

**Codebase TODOs** (if any):
```markdown
### Codebase TODOs ({N} markers across {M} files)

| Marker | Count | Top Locations |
|--------|-------|---------------|
| TODO | 12 | src/auth/ (5), src/api/ (4), src/utils/ (3) |
| FIXME | 3 | src/auth/token.js (2), src/db/migrate.js (1) |
| HACK | 1 | src/api/retry.js:42 |
```

#### Recommended Next Action

End with a concrete recommendation:

```markdown
### Recommended Next Action

Based on the work queue:
- **If you want to fix what's broken:** Address P0 items first — {description}
- **If you want to build features:** Run `/autonomous-dev-flow {issue_numbers}` for the P1/P2 ready issues
- **If you want to clean up:** The {N} TODOs in src/auth/ suggest a refactoring pass
```

### 4. Quick Audit (Fallback — Only If Queue Is Empty)

**ONLY run this phase if Phases 1-3 found zero actionable items.** If there were any issues, PRs, roadmap items, or TODOs, skip this phase entirely.

When the queue is truly empty, perform a lightweight codebase scan to surface potential investigations. This is NOT a full project audit — it's a quick check across a few dimensions.

#### 4a. Test Coverage Gaps

```bash
# Server tests
npm test
# App tests
npx jest
```

- Check which source directories have corresponding test files
- Identify source files with no test counterpart
- Look for test files that are empty or minimal (< 5 assertions)

#### 4b. Dependency Health

```bash
# Check for outdated dependencies and vulnerabilities
npm outdated
npm audit
```

- Count outdated dependencies
- Check for known vulnerabilities if tooling is available (`npm audit`, `pip-audit`, etc.)

#### 4c. Code Quality Signals

Quick scan for potential issues:
- Files over 500 lines (may need splitting)
- Functions/methods over 50 lines (may need refactoring)
- Deeply nested code (4+ levels of indentation)
- Duplicated patterns across files

#### 4d. Documentation Gaps

- README.md: is it up to date? Does it cover setup, usage, contributing?
- API documentation: are public interfaces documented?
- Architecture: any `docs/architecture/` or ADR files?

#### 4e. Present Quick Audit Results

```markdown
## Quick Audit — Potential Investigations

No actionable items found in the standard work sources. Here's what a quick codebase scan revealed:

| Area | Status | Finding |
|------|--------|---------|
| Test Coverage | ⚠️ | {N} source files have no test counterpart |
| Dependencies | ✅ | All up to date |
| Code Quality | ⚠️ | {N} files over 500 lines |
| Documentation | ⚠️ | README missing setup instructions |

### Suggested Investigations

1. **Add tests for {module}** — {N} files in `src/{path}/` have no tests. Effort: M
2. **Split {file}** — {file} is {N} lines. Consider extracting {concept}. Effort: S
3. **Update README** — Missing: setup instructions, environment variables. Effort: S

### Want a Deep Audit?

Run `/project-audit` for a comprehensive multi-agent analysis with detailed recommendations.
```

## Critical Rules

1. **Read-only** — This skill NEVER writes files, creates issues, creates PRs, or commits. It is purely informational. The user decides what to act on.
2. **Quick, not deep** — Phase 1-3 should complete in under 2 minutes. The fallback audit (Phase 4) adds 1-2 minutes. This is NOT `/project-audit`.
3. **Prioritize actionability** — Items with clear acceptance criteria and "ready" signals rank above vague ideas. The user should be able to pick the top item and start working immediately.
4. **Deduplicate across sources** — Never show the same work item from multiple sources. Link them instead.
5. **Graceful degradation** — If a source is unavailable (no `gh` auth, no roadmap file, no audit reports), skip it silently and note it in the sources summary. Never fail on a missing source.
6. **Respect blocked/assigned** — Show blocked and assigned items for context but clearly separate them from the actionable queue. Never recommend working on a blocked or assigned item.
7. **Composable output** — The "Recommended Next Action" section should include copy-pasteable commands (e.g., `/autonomous-dev-flow #12 #18 #25`) so the user can immediately act on the findings.
8. **No file writes** — The fallback audit in Phase 4 outputs to the conversation only. Unlike `/project-audit`, it does NOT write report files or create a `docs/` directory.
<!-- skill-templates: start-working 59a26f3 2026-02-26 -->
