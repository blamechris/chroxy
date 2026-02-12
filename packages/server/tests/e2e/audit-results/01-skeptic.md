# Skeptic's Audit: E2E Test Suite

**Agent**: Skeptic -- Cynical systems engineer who cross-references every claim against actual code
**Overall Rating**: 3.0 / 5
**Date**: 2026-02-12

## Section Ratings

| Suite | Rating | Justification |
|-------|--------|---------------|
| Health endpoint | 4/5 | Legitimate HTTP tests; misses `/version` endpoint and `POST /permission` |
| Authentication | 4/5 | Core paths covered; rate limiting and auth timeout untested |
| Post-auth info | 3/5 | Fragile `messages.length >= 5` heuristic; `claude_ready` timing-dependent |
| Session management | 4/5 | Good CRUD; misses cwd validation, discover/attach/trigger paths |
| Input and streaming | 3/5 | **50ms delta buffering never exercised** -- mock fires synchronously |
| Model and permission mode | 3/5 | Mock `setModel` is a no-op; real version kills/respawns process |
| Permission requests | 2/5 | Only SDK-mode allow path; HTTP hook (102 lines) has zero coverage |
| User questions | 2/5 | Mock stores answer; real session writes NDJSON to stdin or resolves Promise |
| Directory listing | 4/5 | Tests real filesystem; misses tilde expansion and EACCES paths |
| Multi-client | 4/5 | Good coverage; misses primary cleanup on disconnect |
| History replay | 3/5 | Mock `_recordHistory` diverges from real (missing tool_start, user_question, ring buffer) |
| Primary tracking | 3/5 | Verifies event fires; doesn't verify sessionId or same-client short-circuit |

## Top 5 Findings

1. **POST /permission HTTP Hook has zero coverage** -- 102 lines of complex HTTP-hold-open logic (`ws-server.js:1578-1680`) completely untested
2. **Mock SessionManager diverges from real** -- Missing `tool_start`/`user_question` in history recording, no ring buffer cap
3. **50ms delta buffering never exercised** -- Synchronous mock means the timer path never fires
4. **MockSession methods are no-ops hiding real behavior** -- `setModel` assigns a string vs production kills/respawns processes
5. **~50% of protocol message types have zero coverage** -- 9/22 client-to-server, ~16/30+ server-to-client

## Verdict

These tests prove WsServer correctly *routes* messages for the happy path in multi-session CLI mode. But calling them "E2E" overstates what they deliver. The most complex subsystem (HTTP permission hook), security-critical paths (rate limiting, auth timeout), and two of three server modes (legacy CLI, PTY) are completely untested.
