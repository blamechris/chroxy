# /qa-update

Record manual QA test results and run gap analysis against the smoke test matrix.

## Arguments

- `$ARGUMENTS` - Freeform description of what was tested, results, and device (e.g., "tested baseline and chat, both pass, iPhone")

## Instructions

### 1. Gather Context

Auto-detect environment — no user input needed for these:

```bash
# Current commit
SHA=$(git rev-parse --short HEAD)

# Version from package.json
VERSION=$(node -p "require('./package.json').version")

# Tester name
TESTER=$(git config user.name)

# Timestamp
TIMESTAMP=$(date "+%Y-%m-%d %H:%M")
```

Read the current QA log:

```bash
cat docs/qa-log.md
```

### 2. Parse User Input

The user provides `$ARGUMENTS` as freeform text. Map keywords to the 12 smoke test scopes:

| Keywords | Scope |
|---|---|
| baseline, regression | Regression Baseline |
| connection, connect, qr, tunnel | Connection |
| chat, streaming, message | Chat |
| permission, hooks, approve, deny | Permissions |
| model, switching | Model Switching |
| cost, usage, tokens | Cost/Usage Display |
| no-auth, noauth | No-Auth Mode |
| selection, copy, export | Message Selection |
| input, keyboard, multiline | Input Modes |
| terminal, pty, tmux | Terminal (PTY) |
| shutdown, cleanup, ctrl-c | Shutdown/Cleanup |
| edge, network, resilience | Edge Cases |
| all | All 12 scopes |

**Result keywords:**
- Default result is `PASS` unless the user says otherwise near a scope
- "fail" / "failed" near a scope → `FAIL`
- "partial" / "mostly" near a scope → `PARTIAL`

If the input is ambiguous (can't determine which scopes were tested), ask the user to clarify before proceeding. Do NOT guess.

### 3. Gap Analysis

This is the key step. For every scope in the coverage matrix that has been previously tested (status is not `--`):

1. Get the scope's last-tested SHA from the matrix
2. Run `git diff <scope-sha>..HEAD --name-only` to find changed files
3. Map changed files to affected scopes using this table:

| Changed File(s) | Affected Scopes |
|---|---|
| `ws-server.js` | Connection, Chat, Permissions, No-Auth |
| `cli-session.js` | Chat, Permissions, Model Switching |
| `server-cli.js`, `cli.js` | Connection, No-Auth, Shutdown |
| `tunnel.js`, `tunnel-check.js` | Connection |
| `permission-hook.sh` | Permissions |
| `models.js` | Model Switching |
| `connection.ts` | Connection, Chat, Permissions, Model Switching, Cost/Usage |
| `SessionScreen.tsx` | Chat, Permissions, Model Switching, Cost/Usage, Selection |
| `ConnectScreen.tsx` | Connection |
| `server.js` (src/), `pty-manager.js`, `output-parser.js` | Terminal |

4. If a scope's source files changed since its last-tested SHA → mark `STALE`
5. Files NOT in the mapping (tests, docs, config, scripts) do **not** trigger staleness

**Keep this mapping in sync with `docs/smoke-test.md` § File-to-Scope Mapping.**

### 4. Update `docs/qa-log.md`

Make two updates to the file:

#### Update Coverage Matrix

For each scope that was just tested:
- Set Status to the test result (PASS/FAIL/PARTIAL)
- Set Last Tested to today's date
- Set SHA to current HEAD
- Set Tester name
- Add any notes from the user

For scopes flagged as stale by gap analysis (not retested now):
- Change Status from PASS/PARTIAL to `STALE`

Leave `--` scopes untouched.

#### Insert Test History Entry

Insert a new entry immediately after the `## Test History` heading (before older entries). Format:

```markdown
### YYYY-MM-DD HH:MM -- Tester @ `SHA` (vX.Y.Z)

**Scopes Tested:**

| Scope | Result | Notes |
|---|---|---|
| Scope Name | PASS | Any notes |

**Device/Platform:** From user input
**Server Mode:** From user input (default: CLI headless)

**Notes:**
- Any additional context from user input
```

Only include scopes that were actually tested in this entry — no rows for untested scopes.

### 5. Report

Output a summary to the user:

```
## QA Update Recorded

**Commit:** `SHA` (vX.Y.Z)
**Tester:** Name
**Date:** YYYY-MM-DD HH:MM

### Results Recorded
- Scope 1: PASS
- Scope 2: FAIL — notes

### Stale Scopes (source files changed since last test)
- Scope: last tested at `abc1234`, files changed: foo.js, bar.ts

### Untested Scopes (never tested)
- Scope 1
- Scope 2

### Suggested Next Tests
Prioritized list based on:
1. FAIL scopes (retest after fix)
2. STALE scopes (source changed)
3. Never-tested scopes (`--`)
```

If no scopes are stale and all scopes have been tested, report full coverage achieved.
