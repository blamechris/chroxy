# Builder's Audit: Chroxy Project Health & What's Next

**Agent**: Builder -- Pragmatic full-stack dev focused on implementability and effort estimates
**Overall Rating**: 3.8 / 5
**Date**: 2026-02-21

---

## Is This Shippable Today?

**Yes, with rough edges.** The core loop works: start server, scan QR, send messages, see responses, approve permissions, switch models, manage sessions. The encryption, reconnection, and supervisor infrastructure is solid. A motivated early adopter could use this daily.

**Rough edges that block a wider audience:**
- No onboarding flow (issue #628) -- new users hit a blank ConnectScreen with no guidance
- Auto-connect timeout is 19 seconds of spinner on failure before falling back
- `acceptEdits` mode is missing entirely (the most common Claude Code permission mode)
- No client-side persistence -- lose your chat on disconnect

---

## Stale Issues to Close

These are done. Close them to clean the backlog:

| Issue | Why Close |
|-------|-----------|
| #662 | Symlink fix merged in PR #710 |
| #663 | browse_files/read_file tests merged in PR #708 |
| #713 | WS protocol types now documented via Zod schemas (PR #712) |
| #716 | `from-review` label, untracked file binary detection -- verify if still relevant, close if scoped out |
| #665 | Syntax tokenization memoization -- no activity, file viewer performance is acceptable |

**Effort: 10 minutes.**

---

## Two-Roadmap Reconciliation

There are two roadmap documents floating around. The **competitive analysis roadmap** should be primary -- it is more complete and maps to actual issues. The in-app-dev roadmap has three items marked "not started" that are actually done:

| In-App-Dev Item | Actual Status | Evidence |
|-----------------|---------------|----------|
| EventNormalizer layer | Done | PR #714, `event-normalizer.js` + `event-normalizer.test.js` |
| Zod schema validation | Done | PR #712, `ws-schemas.js` + `ws-schemas.test.js` |
| Maestro E2E flows | Done | 11 flows in `packages/app/.maestro/`, `run-all.yaml` |

The in-app-dev doc should be archived or merged into the competitive roadmap.

---

## Top 5 by ROI (Impact / Effort)

### 1. Close Stale Issues (10 min)
Close #662, #663, #713, #716, #665. Immediate backlog clarity.

### 2. Fix Failing Test (30 min)
`doctor.test.js:33` fails locally because it expects Node version check to return `'pass'` but gets `'warn'` (macOS git PATH issue, not a real failure). CI is green. Fix the test to handle Node 22 on macOS correctly, or make the version check more flexible.

### 3. Auto-Connect Timeout Reduction (1-2 hours)
`ConnectScreen.tsx:79-98` starts auto-connect on mount, but failure takes ~19s (full 6-attempt retry chain). Add a `silent: true` fast-fail path: 1 attempt, 3s timeout. If it fails, immediately show ConnectScreen. The infrastructure is there -- `connect()` already accepts options at line 87.

### 4. Dynamic Model List (2-4 hours)
Issue #686. Replace static `models.js` list with a startup query to the SDK. The provider abstraction already supports it -- `sdk-session.js` wraps the SDK. Add a `listModels()` method that calls `claude models list` (or SDK equivalent) once at startup and caches the result.

### 5. acceptEdits Permission Mode (3-4 hours)
The permission mode switch in `sdk-session.js:576-600` already handles `approve`, `auto`, and `plan`. Adding `acceptEdits` requires:
- Map it to the SDK's `acceptEdits` permission mode at `sdk-session.js:589`
- Add it to the mode list in `cli-session.js:123` (for legacy path)
- Add it to the app's permission mode picker in SettingsBar
- No new WS protocol messages needed -- `permission_mode_changed` already carries the mode string

---

## Effort Estimates for Remaining Open Issues

### Quick Wins (< 1 day each)

| Issue | Effort | Notes |
|-------|--------|-------|
| #686 Dynamic models | 2-4h | SDK query + cache |
| #625 Session timeout | 2-3h | Timer in session-manager.js |
| #624 Token rotation | 3-4h | Generate new token, notify connected clients |
| #626 Cost budget | 2-3h | Track cumulative cost in session, warn at threshold |
| #616 Usage limit awareness | 2-3h | Parse rate limit headers from SDK responses |
| #623 Connection quality | 2-3h | Ping/pong latency tracking, display in app |
| #628 Onboarding tutorial | 3-4h | Overlay/modal on first launch |
| #627 Terminal export | 1-2h | Share sheet from terminal buffer |

### Medium Effort (1-3 days each)

| Issue | Effort | Notes |
|-------|--------|-------|
| #685 Client persistence | 1-2d | AsyncStorage for conversation history + reconnect |
| #615 Conversation search | 1-2d | Full-text search over message history |
| #622 WS compression | 1d | `permessage-deflate` on server, test on cellular |
| #618 Tablet/landscape | 2-3d | Responsive layout, side-by-side chat/terminal |
| #619 Biometric lock | 1d | `expo-local-authentication`, gate on app foreground |

### High Effort (1+ week each)

| Issue | Effort | Notes |
|-------|--------|-------|
| #607 App diff viewer | 1w | Render diffs in chat, syntax highlighting, collapse/expand |
| #684 Image results | 1w | Base64 image rendering, computer-use screenshot display |
| #610 Web client | 2-3w | Separate React web app or shared components |
| #613 Codex provider | 1-2w | New provider implementation, multi-agent orchestration |
| #611 Parallel sessions | 1w | Concurrent session execution, resource management |
| #617 Checkpoint/rewind | 2w | Git checkpoint integration, undo UI |
| #679 SQLite migration | 1w | Schema design, migration from JSON, backwards compat |

---

## Architecture Observations

**What works well:**
- Provider abstraction (`providers.js`) is clean -- adding new backends is straightforward
- EventNormalizer is a good addition -- decouples WS protocol from session internals
- Encryption is properly layered (ECDH + NaCl, not homebrew crypto)
- Supervisor restart logic is production-grade

**What needs attention:**
- `ws-server.js` at 2,691 lines is doing too much. Split into: router, auth, encryption, session bridge, file operations.
- `connection.ts` at 2,764 lines mirrors this problem on the app side. The Zustand store is a monolith.
- PTY mode (`server.js` + `pty-manager.js` + `output-parser.js` + `pty-session.js` = 1,345 lines) is legacy code with its own test suite. If CLI headless is the path forward, this should be deprecated and removed.
- Test infrastructure uses 177 `setTimeout` calls across server tests, creating timing fragility.
