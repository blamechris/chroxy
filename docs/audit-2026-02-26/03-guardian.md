# Guardian's Audit: Chroxy Codebase Re-Baseline

**Agent**: Guardian — Defensive engineer focused on reliability, failure modes, and production resilience
**Overall Rating**: 3.5 / 5
**Date**: 2026-02-26

---

## Section Ratings

| Area | Rating | Notes |
|------|--------|-------|
| Server | 3.5/5 | Happy path is solid; error recovery and edge cases have gaps |
| App | 4/5 | ConnectionPhase state machine handles most failure modes well |
| Desktop | 3/5 | Dashboard lacks defensive coding — no CSP, no error boundaries |
| WS Protocol | 3/5 | Schema validation is good when it works, but the gaps are in critical paths |
| Testing | 3.5/5 | Tests verify success paths; failure mode coverage is thin |
| Security | 3.5/5 | Auth is sound but several defense-in-depth layers are missing |
| CI/CD | 4/5 | Pipeline catches regressions; no security scanning or dependency audit |
| Documentation | 3/5 | Operational runbooks are absent — no guidance for failure scenarios |

---

## Top 5 Findings

### 1. CRITICAL: Conversation History Is Broken at the Schema Validation Layer

**Severity**: Critical
**Status**: Broken in production

The `list_conversations` and `resume_conversation` client message types are not included in the `ClientMessageSchema` Zod discriminated union (`ws-schemas.js:432-463`). All incoming WebSocket messages pass through `safeParse` validation in `ws-server.js` (lines 969-976). Messages with unrecognized types fail validation and are rejected with an error response before reaching any handler.

The handler code in `ws-message-handlers.js:427-473` exists but is unreachable dead code.

**Failure mode**: The app sends `list_conversations`, the server responds with a schema validation error, the app's `conversationHistoryLoading` flag remains `true` forever (no timeout), and the user sees an infinite spinner.

**Impact**: Conversation history — a headline v0.2.0 feature — is completely non-functional. This is a two-line fix (add the types to the schema union) but represents a process failure: the feature shipped without integration testing.

**Recommendation**: Fix the schema immediately. Add an integration test that sends each client message type through the full validation-dispatch-response pipeline. Add a loading timeout on the app side.

---

### 2. No uncaughtException or unhandledRejection Handlers

**Severity**: High
**Status**: Open

The server process has no global `process.on('uncaughtException')` or `process.on('unhandledRejection')` handlers. An unhandled promise rejection or thrown error in any async path will crash the process with no logging, no cleanup, and no notification.

**Evidence**:
- Grep for `uncaughtException` and `unhandledRejection` across `packages/server/src/` — zero results
- `server-cli.js` — no global error handlers registered
- `supervisor.js` — restarts the child process on crash, but the crash itself is unlogged from the child's perspective

**Impact**: In supervisor mode, crashes are recovered but the root cause is invisible. In non-supervisor mode (development, `--no-supervisor`), a single unhandled rejection kills the server with no diagnostic output.

**Recommendation**: Add global handlers that log the error with full stack trace, attempt graceful cleanup (close WebSocket connections, flush logs), and exit with a non-zero code. In supervisor mode, emit the crash reason to the parent before exiting.

---

### 3. Conversation Scanner Has Unbounded DoS Potential

**Severity**: High
**Status**: Open

The conversation scanner (`conversation-scanner.js`) recursively scans the Claude projects directory for conversation files. There is no limit on the number of files scanned, the depth of recursion, or the total size of data read. A malicious or misconfigured projects directory with thousands of conversation files could cause the server to consume excessive memory and CPU, blocking all other operations.

**Evidence**:
- `conversation-scanner.js` — `scanConversations()` uses recursive directory walking with no depth limit
- No file count cap or total size budget
- Scan runs on the main thread (no worker), blocking the event loop during I/O

**Impact**: On machines with large Claude histories (power users, shared dev machines), the scan could take tens of seconds and block all WebSocket message processing during that time.

**Recommendation**: Add configurable limits: max file count (e.g., 1000), max scan depth (e.g., 5 levels), max total read size (e.g., 50MB). Consider running the scan in a worker thread. Add a scan timeout.

---

### 4. Standby Server EADDRINUSE Leads to Infinite Retry Loop

**Severity**: Medium
**Status**: Open

When the supervisor's standby HTTP server encounters an `EADDRINUSE` error (port already in use), it retries binding on a short interval with no maximum attempt count. If the port is permanently occupied (e.g., another instance, a conflicting service), the supervisor loops indefinitely, consuming CPU and flooding logs.

**Evidence**:
- `supervisor.js` — `startStandbyServer()` catches `EADDRINUSE` and calls `setTimeout` to retry
- No retry counter or maximum attempt limit
- No exponential backoff on the retry interval

**Impact**: A common misconfiguration (running two instances on the same port) results in a process that appears hung — no useful error message, just infinite retries in the background.

**Recommendation**: Add a maximum retry count (e.g., 5 attempts). After exhausting retries, log a clear error message ("Port {N} is in use by another process") and exit with a non-zero code. Apply exponential backoff to retries.

---

### 5. Dashboard Token Served Without Content Security Policy

**Severity**: Medium
**Status**: Open

The web dashboard is served as an HTML page that includes the API token in the page content (used for WebSocket authentication). The response does not include a `Content-Security-Policy` header. This means:

- Inline scripts can execute without restriction
- No protection against XSS if any user-controlled content reaches the page
- The token could be exfiltrated by injected scripts

**Evidence**:
- `dashboard.js` — `generateDashboard(token)` embeds the token in a `<script>` tag
- `ws-server.js` — HTTP response for `/dashboard` does not set CSP headers
- No `X-Content-Type-Options`, `X-Frame-Options`, or `Referrer-Policy` headers either

**Impact**: If an attacker can inject content into any field rendered on the dashboard (e.g., a crafted conversation message containing `<script>` tags), they could steal the API token.

**Recommendation**: Add a strict CSP header: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss:`. Also add `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and sanitize any user-generated content before rendering.

---

## Verdict

Chroxy is reliable on the happy path — connections are established cleanly, sessions work, the supervisor restarts crashes, and the app's ConnectionPhase state machine handles most network hiccups gracefully. The concern is what happens on the unhappy path. The server has no global error handlers, no resource limits on the conversation scanner, and an infinite retry loop on port conflicts. The dashboard serves tokens without CSP protection. Most critically, the conversation history feature is broken at the schema layer and the app has no timeout to recover from the missing response. These are not architectural flaws — they are missing guardrails that should be straightforward to add. A focused reliability pass addressing these five findings would significantly improve production resilience.
